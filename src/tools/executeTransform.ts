/**
 * Tool: executeTransform
 *
 * Runs an approved transformation template against raw ingested data.
 * Reads the CSV from Supabase Storage, runs the transform code in E2B,
 * and writes the resulting clean path-level rows to dataset_records (Postgres).
 *
 * This is Stage 1 of the two-stage execution pipeline:
 *   Stage 1 (this tool) — Raw → Clean:  raw CSV → dataset_records
 *   Stage 2 (executeAnalysis) — Clean → Enriched: dataset_records → analysis_artifacts
 *
 * Transform templates must output: { type: "transform", rows: [...], summary: "..." }
 * See knowledge/output-contract.md.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );
}

const transformOutputSchema = z.object({
  type: z.literal("transform"),
  rows: z.array(z.record(z.unknown())),
  summary: z.string(),
});

export const executeTransformTool = createTool({
  id: "execute-transform",
  description:
    "Run an approved transformation template against raw ingested data. " +
    "Reads the raw CSV from Supabase Storage, runs transformation code in E2B, " +
    "and writes the resulting clean path-level rows to dataset_records. " +
    "Call this after uploadDataset or fetchSensorData succeeds — before any executeAnalysis calls. " +
    "The transform template must print { type: 'transform', rows: [...], summary: '...' } as its final output.",
  inputSchema: z.object({
    rawUploadId: z.string().describe("raw_data_uploads.id returned by uploadDataset or fetchSensorData"),
    datasetId: z
      .string()
      .optional()
      .describe("datasets.id (approved data dictionary) to link clean records to. Pass if available."),
    orgId: z.string().describe("Organization ID"),
    code: z.string().describe("Approved transformation Python code. Must print { type: 'transform', rows: [...], summary: '...' }"),
    params: z.record(z.unknown()).optional().describe("Template parameters (store hours, MIN_POINTS, etc.)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    rowsWritten: z.number().optional(),
    summary: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { rawUploadId, datasetId, orgId, code } = context;
    const supabase = getSupabase();

    // ── 1. Look up storage_url from raw_data_uploads ──────────────────────────
    const { data: upload, error: uploadError } = await supabase
      .from("raw_data_uploads")
      .select("storage_url, filename")
      .eq("id", rawUploadId)
      .single();

    if (uploadError || !upload) {
      return {
        success: false,
        summary: `Could not find raw upload ${rawUploadId}: ${uploadError?.message ?? "not found"}`,
        error: uploadError?.message,
      };
    }

    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });

    try {
      // ── 2. Download CSV from Storage into sandbox ──────────────────────────
      let csvResponse: Response;
      try {
        csvResponse = await fetch(upload.storage_url);
      } catch (fetchErr) {
        return {
          success: false,
          summary: `Could not fetch CSV from Storage: ${(fetchErr as Error).message}`,
          error: (fetchErr as Error).message,
        };
      }

      if (!csvResponse.ok) {
        return {
          success: false,
          summary: `Failed to fetch CSV: HTTP ${csvResponse.status} ${csvResponse.statusText}`,
          error: `HTTP ${csvResponse.status}`,
        };
      }

      const csvBuffer = await csvResponse.arrayBuffer();
      await sandbox.files.write("/sandbox/upload.csv", csvBuffer);

      // ── 3. Pre-install transform libraries ────────────────────────────────
      await sandbox.runCode(
        "import subprocess; subprocess.run(['pip', 'install', 'pandas', 'numpy', '--quiet', '--root-user-action=ignore'], check=True, capture_output=True)",
        { language: "python" }
      );

      // ── 4. Run the transformation code ────────────────────────────────────
      // SUPABASE_URL/KEY injected as safety net — correct templates don't use them,
      // but prevents KeyError if agent-written code tries REST API access.
      const exec = await sandbox.runCode(code, {
        language: "python",
        envs: {
          SUPABASE_URL: process.env.SUPABASE_URL ?? "",
          SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          RAW_UPLOAD_ID: rawUploadId,
        },
      });
      const stdout = exec.logs.stdout.join("\n");

      // ── 5. Parse transform output envelope ────────────────────────────────
      const lines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];

      if (!lastLine) {
        const errMsg = exec.error
          ? `${exec.error.name}: ${exec.error.value}`
          : "Script produced no output";
        return {
          success: false,
          summary: `Transform script failed: ${errMsg}`,
          error: errMsg,
        };
      }

      let transformOutput: z.infer<typeof transformOutputSchema>;
      try {
        const parsed = JSON.parse(lastLine);
        transformOutput = transformOutputSchema.parse(parsed);
      } catch (err) {
        return {
          success: false,
          summary: `Transform output did not match contract. Expected { type: 'transform', rows: [...], summary: '...' }. Got: ${lastLine.slice(0, 200)}`,
          error: (err as Error).message,
        };
      }

      const { rows, summary } = transformOutput;

      if (!rows.length) {
        return {
          success: true,
          rowsWritten: 0,
          summary: `Transform complete. 0 rows produced. ${summary}`,
        };
      }

      // ── 6. Bulk-insert rows into dataset_records ──────────────────────────
      const records = rows.map((row) => ({
        org_id: orgId,
        raw_upload_id: rawUploadId,
        dataset_id: datasetId ?? null,
        data: row,
      }));

      const BATCH_SIZE = 500;
      let inserted = 0;

      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        const { error: insertError } = await supabase
          .from("dataset_records")
          .insert(batch);

        if (insertError) {
          return {
            success: false,
            rowsWritten: inserted,
            summary: `Inserted ${inserted} rows before error: ${insertError.message}`,
            error: insertError.message,
          };
        }
        inserted += batch.length;
      }

      return { success: true, rowsWritten: inserted, summary };
    } finally {
      await sandbox.kill();
    }
  },
});
