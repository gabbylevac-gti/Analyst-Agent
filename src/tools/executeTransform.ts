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
    columnMapping: z
      .record(z.string())
      .optional()
      .describe("Column rename map: { csvHeader: canonicalName }. When provided, a preprocessing step renames CSV columns before the template runs. Use this when the uploaded CSV has non-canonical column names (e.g. 'sample_time' → 'log_creation_time')."),
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
    const { rawUploadId, orgId, templateId, params, endPointId, columnMapping } = context;
    let { datasetId } = context;
    const supabase = getSupabase();

    // ── 0a. Validate datasetId — guard against agent passing rawUploadId by mistake ─
    // The agent occasionally hallucinates datasetId from rawUploadId (same-looking UUID).
    // Verify it exists in datasets before trusting it; clear if stale or wrong.
    if (datasetId) {
      const { data: dsCheck } = await supabase
        .from("datasets")
        .select("id")
        .eq("id", datasetId)
        .maybeSingle();
      if (!dsCheck) {
        datasetId = undefined;
      }
    }

    // ── 0b. Idempotency guard ─────────────────────────────────────────────────
    // If audience_observations already has rows for this raw_upload_id, the transform
    // already ran successfully. Skip E2B to prevent duplicate agg rows.
    // The UNIQUE constraint on audience_day_agg(org_id, endpoint_id, date) is the
    // DB-level safety net for overlapping fetches; this guard prevents redundant E2B work.
    const { count: existingObsCount } = await supabase
      .from("audience_observations")
      .select("id", { count: "exact", head: true })
      .eq("raw_upload_id", rawUploadId)
      .eq("org_id", orgId);

    if ((existingObsCount ?? 0) > 0) {
      return {
        success: true,
        observationsWritten: 0,
        agg15minWritten: 0,
        aggDayWritten: 0,
        classificationCounts: { engaged: 0, passer_by: 0 },
        summary: `Upload ${rawUploadId} already transformed (${existingObsCount} observations exist). Skipping re-transform.`,
      };
    }

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

      // ── 4. Apply column mapping (rename headers before template reads CSV) ──
      if (columnMapping && Object.keys(columnMapping).length > 0) {
        // Filter out skipped columns (null/empty values mean "keep original name")
        const activeRenames = Object.fromEntries(
          Object.entries(columnMapping).filter(([, v]) => v && v !== "__skip__")
        );
        if (Object.keys(activeRenames).length > 0) {
          const renameJson = JSON.stringify(activeRenames);
          const renameScript = [
            "import pandas as pd, json",
            `rename_map = json.loads(${JSON.stringify(renameJson)})`,
            "df = pd.read_csv('/sandbox/upload.csv')",
            "df.rename(columns=rename_map, inplace=True)",
            "df.to_csv('/sandbox/upload.csv', index=False)",
          ].join("\n");
          await sandbox.runCode(renameScript, { language: "python" });
        }
      }

      // ── 5. Run the filled template code ───────────────────────────────────
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
          ENDPOINT_ID: endPointId ?? "",
          DB_URL: dbUrl,
        },
      });
      const stdout = exec.logs.stdout.join("\n");

      // ── 6. Parse transform output envelope ────────────────────────────────
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

        // Template error envelopes have type: "error" — surface the human-readable
        // message directly instead of letting Zod produce a confusing validation dump.
        if (parsed && typeof parsed === "object" && parsed.type === "error") {
          const title = (parsed as Record<string, unknown>).title as string | undefined;
          const msg = (parsed as Record<string, unknown>).message as string | undefined;
          const errMsg = title && msg ? `${title}: ${msg}` : title ?? msg ?? JSON.stringify(parsed);
          return { success: false, summary: `Transform failed — ${errMsg}`, error: errMsg };
        }

        transformOutput = transformOutputSchema.parse(parsed);
      } catch (err) {
        return {
          success: false,
          summary: `Transform output did not match contract. Expected { type: 'transform', ... }. Last line: ${lastLine.slice(0, 300)}`,
          error: (err as Error).message,
        };
      }

      const { observationsWritten, agg15minWritten, aggDayWritten, classificationCounts, summary } = transformOutput;

      // ── 7. Write template_id to audience_observations rows ────────────────
      // endpoint_id is written directly by the template during INSERT.
      // Non-blocking: failure here does not fail the transform result.
      await supabase
        .from("audience_observations")
        .update({ template_id: templateId })
        .eq("raw_upload_id", rawUploadId)
        .eq("org_id", orgId);

      // ── 8. Write pipeline_run_log record ──────────────────────────────────
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
