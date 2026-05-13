/**
 * Tool: executeTransform
 *
 * Runs an approved transformation template against raw ingested data.
 * Reads the CSV from Supabase Storage, runs the transform code in E2B.
 * The transform Python code writes directly to typed audience tables via psycopg2
 * (audience_observations, audience_15min_agg, audience_day_agg).
 *
 * This is Stage 1 of the two-stage execution pipeline:
 *   Stage 1 (this tool) — Raw → Clean:  raw CSV → audience_observations + agg tables
 *   Stage 2 (executeAnalysis) — Clean → Enriched: typed tables → analysis_artifacts
 *
 * Transform templates must output:
 *   { type: "transform", observationsWritten, agg15minWritten, aggDayWritten,
 *     classificationCounts, qualityRules, summary }
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
  observationsWritten: z.number(),
  agg15minWritten: z.number(),
  aggDayWritten: z.number(),
  classificationCounts: z.object({ engaged: z.number(), passer_by: z.number() }),
  qualityRules: z.object({ offHoursRemoved: z.number(), belowMinPointsRemoved: z.number() }),
  summary: z.string(),
});

export const executeTransformTool = createTool({
  id: "execute-transform",
  description:
    "Run an approved transformation template against raw ingested data. " +
    "Fetches the template code from code_templates by templateId, fills {{PLACEHOLDER}} " +
    "tokens from params, runs it in E2B. The Python template writes clean path records and " +
    "pre-computed aggregations directly to Postgres (audience_observations, audience_15min_agg, " +
    "audience_day_agg). Call this after getTransformPipeline resolves the templateId and all " +
    "required params. Never pass raw code — use templateId only.",
  inputSchema: z.object({
    rawUploadId: z.string().describe("raw_data_uploads.id returned by uploadDataset or fetchSensorData"),
    datasetId: z
      .string()
      .optional()
      .describe("datasets.id (approved data dictionary) to link clean records to. Pass if available."),
    orgId: z.string().describe("Organization ID"),
    templateId: z
      .string()
      .describe("code_templates.id returned by getTransformPipeline. The tool fetches the code itself."),
    params: z
      .record(z.unknown())
      .optional()
      .describe("Resolved parameter values keyed by placeholder name (e.g. { STORE_OPEN_HOUR: 8, MIN_POINTS: 2 }). All required params must be present."),
    endPointId: z
      .string()
      .optional()
      .describe("Endpoint ID that produced the raw upload. Passed through to pipeline_run_log for audit."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    observationsWritten: z.number().optional(),
    agg15minWritten: z.number().optional(),
    aggDayWritten: z.number().optional(),
    classificationCounts: z.object({ engaged: z.number(), passer_by: z.number() }).optional(),
    summary: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { rawUploadId, datasetId, orgId, templateId, params, endPointId } = context;
    const supabase = getSupabase();

    // ── 1. Fetch template code from code_templates ────────────────────────────
    const { data: template, error: templateError } = await supabase
      .from("code_templates")
      .select("code, parameters, name")
      .eq("id", templateId)
      .single();

    if (templateError || !template) {
      return {
        success: false,
        summary: `Template ${templateId} not found: ${templateError?.message ?? "not found"}`,
        error: templateError?.message ?? "not found",
      };
    }

    // Validate required params before executing
    if (template.parameters && Array.isArray(template.parameters)) {
      const missingRequired: string[] = [];
      for (const p of template.parameters as Array<{ name: string; required: boolean }>) {
        if (p.required && (params?.[p.name] === undefined || params?.[p.name] === null || params?.[p.name] === "")) {
          missingRequired.push(p.name);
        }
      }
      if (missingRequired.length > 0) {
        return {
          success: false,
          summary: `Missing required parameters: ${missingRequired.join(", ")}. Resolve these before calling executeTransform.`,
          error: `Missing required params: ${missingRequired.join(", ")}`,
        };
      }
    }

    // Fill {{PLACEHOLDER}} tokens from params
    let code: string = template.code as string;
    if (params) {
      code = code.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const val = params[key];
        return val !== undefined && val !== null ? String(val) : `{{${key}}}`;
      });
    }

    // Verify no unfilled placeholders remain (guards against missing optional params with no default)
    const unfilled = code.match(/\{\{\w+\}\}/g);
    if (unfilled) {
      return {
        success: false,
        summary: `Unfilled placeholders in template after param resolution: ${[...new Set(unfilled)].join(", ")}`,
        error: `Unfilled placeholders: ${[...new Set(unfilled)].join(", ")}`,
      };
    }

    // ── 2. Look up storage_url from raw_data_uploads ──────────────────────────
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
        "import subprocess; subprocess.run(['pip', 'install', 'pandas', 'numpy', 'psycopg2-binary', '--quiet', '--root-user-action=ignore'], check=True, capture_output=True)",
        { language: "python" }
      );

      // ── 4. Run the filled template code ───────────────────────────────────
      const dbPassword = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD ?? "");
      const dbUrl = `postgresql://postgres.ftshahsqtkxxjmpsmyhp:${dbPassword}@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require`;

      const exec = await sandbox.runCode(code, {
        language: "python",
        envs: {
          SUPABASE_URL: process.env.SUPABASE_URL ?? "",
          SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          RAW_UPLOAD_ID: rawUploadId,
          ORG_ID: orgId,
          DATASET_ID: datasetId ?? "",
          DB_URL: dbUrl,
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
          summary: `Transform output did not match contract. Expected { type: 'transform', observationsWritten, agg15minWritten, aggDayWritten, ... }. Got: ${lastLine.slice(0, 200)}`,
          error: (err as Error).message,
        };
      }

      const { observationsWritten, agg15minWritten, aggDayWritten, classificationCounts, summary } = transformOutput;

      // ── 6. Write template_id to audience_observations rows ────────────────
      // Non-blocking: failure here does not fail the transform result.
      await supabase
        .from("audience_observations")
        .update({ template_id: templateId })
        .eq("raw_upload_id", rawUploadId)
        .eq("org_id", orgId);

      // ── 7. Write pipeline_run_log record ──────────────────────────────────
      await supabase.from("pipeline_run_log").insert({
        org_id: orgId,
        endpoint_id: endPointId ?? null,
        trigger_reason: "chat",
        template_id: templateId,
        status: "complete",
        rows_written: observationsWritten,
      });

      return { success: true, observationsWritten, agg15minWritten, aggDayWritten, classificationCounts, summary };
    } finally {
      await sandbox.kill();
    }
  },
});
