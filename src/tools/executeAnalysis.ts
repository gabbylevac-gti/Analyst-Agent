/**
 * Tool: executeAnalysis
 *
 * Runs an approved analysis template against the dataset_records clean layer.
 * Injects a Postgres read-only connection string (DB_URL env var) and the
 * raw_upload_id so the analysis code can query dataset_records directly.
 *
 * This is Stage 2 of the two-stage execution pipeline:
 *   Stage 1 (executeTransform) — Raw → Clean:  raw CSV → dataset_records
 *   Stage 2 (this tool)        — Clean → Enriched: dataset_records → analysis_artifacts
 *
 * Returns the artifact envelope, its persisted ID, and the code that ran.
 * The code field is required for M2 Direct Control mode display.
 *
 * Analysis code pattern:
 *   import psycopg2, os, json
 *   conn = psycopg2.connect(os.environ["DB_URL"])
 *   cur = conn.cursor()
 *   cur.execute("SELECT data FROM dataset_records WHERE raw_upload_id = %s",
 *               (os.environ["RAW_UPLOAD_ID"],))
 *   rows = [r[0] for r in cur.fetchall()]
 *
 * See knowledge/output-contract.md for the envelope schema.
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

// ─── Trace data truncation ────────────────────────────────────────────────────
// Same logic as executeCode — keep result sizes manageable for the agent.

const MAX_TRACE_POINTS = 80;
const TRACE_ARRAY_KEYS = new Set(["x", "y", "z", "text", "customdata", "ids", "values", "labels"]);
const TABLE_MAX_ROWS = 20;

function truncateTrace(trace: unknown): unknown {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return trace;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(trace as Record<string, unknown>)) {
    if (TRACE_ARRAY_KEYS.has(k) && Array.isArray(v) && v.length > MAX_TRACE_POINTS) {
      result[k] = v.slice(0, MAX_TRACE_POINTS);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function truncateEnvelopeData(envelope: z.infer<typeof artifactSchema>): z.infer<typeof artifactSchema> {
  if (envelope.type === "chart") {
    const fig = envelope.data as { data?: unknown[]; layout?: unknown } | undefined;
    if (fig?.data) {
      return { ...envelope, data: { ...fig, data: fig.data.map(truncateTrace) } };
    }
  }
  if (envelope.type === "table" && Array.isArray(envelope.data) && envelope.data.length > TABLE_MAX_ROWS) {
    return { ...envelope, data: (envelope.data as unknown[]).slice(0, TABLE_MAX_ROWS) };
  }
  if (envelope.type === "multi" && Array.isArray(envelope.artifacts)) {
    return {
      ...envelope,
      artifacts: envelope.artifacts.map(a =>
        truncateEnvelopeData(a as z.infer<typeof artifactSchema>)
      ),
    };
  }
  return envelope;
}

// ─── Output envelope schema ───────────────────────────────────────────────────

const artifactSchema = z.object({
  type: z.enum(["chart", "table", "text", "multi", "error"]),
  title: z.string(),
  html: z.string().optional(),
  data: z.unknown().optional(),
  content: z.string().optional(),
  columns: z.array(z.string()).optional(),
  artifacts: z.array(z.unknown()).optional(),
  summary: z.string(),
  message: z.string().optional(),
  traceback: z.string().optional(),
});

// ─── Tool definition ──────────────────────────────────────────────────────────

export const executeAnalysisTool = createTool({
  id: "execute-analysis",
  description:
    "Execute an approved analysis template against the clean dataset_records layer. " +
    "Injects a Postgres read-only connection (DB_URL env var) so the analysis code can query " +
    "dataset_records WHERE raw_upload_id = rawUploadId via psycopg2. " +
    "Writes the output envelope to analysis_artifacts and returns it along with the code that ran. " +
    "Always pass rawUploadId (not csvUrl) — analysis reads from Postgres, not Storage. " +
    "Requires executeTransform to have run first to populate dataset_records.",
  inputSchema: z.object({
    rawUploadId: z.string().describe(
      "raw_data_uploads.id — injected as RAW_UPLOAD_ID env var for the analysis code to filter dataset_records"
    ),
    orgId: z.string().describe("Organization ID"),
    sessionId: z.string().describe("Session ID — used to link the written analysis_artifact"),
    code: z.string().describe(
      "Analysis Python code. Must connect to Postgres via psycopg2 (DB_URL env var), " +
      "query dataset_records WHERE raw_upload_id = os.environ['RAW_UPLOAD_ID'], " +
      "and print a valid output envelope as the final stdout line."
    ),
    params: z.record(z.unknown()).optional().describe("Template parameters (thresholds, time windows, etc.)"),
    templateId: z.string().optional().describe("code_templates.id if running an approved template"),
  }),
  outputSchema: z.object({
    envelope: artifactSchema,
    artifactId: z.string().optional(),
    code: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { rawUploadId, orgId, sessionId, code, templateId } = context;
    const supabase = getSupabase();

    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });

    try {
      // ── Pre-install analysis libraries ────────────────────────────────────
      await sandbox.runCode(
        "import subprocess; subprocess.run(['pip', 'install', 'plotly', 'pandas', 'numpy', 'scipy', 'psycopg2-binary', '--quiet', '--root-user-action=ignore'], check=True, capture_output=True)",
        { language: "python" }
      );

      // ── Build Postgres connection URL and run analysis code ───────────────
      const dbPassword = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD ?? "");
      const dbUrl = `postgresql://postgres.ftshahsqtkxxjmpsmyhp:${dbPassword}@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require`;

      const exec = await sandbox.runCode(code, {
        language: "python",
        envs: {
          DB_URL: dbUrl,
          RAW_UPLOAD_ID: rawUploadId,
        },
      });

      const stdout = exec.logs.stdout.join("\n");
      const stderr = exec.logs.stderr.join("\n");
      const exitCode = exec.error ? 1 : 0;

      // ── Parse output envelope from final stdout line ───────────────────────
      const lines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];

      let envelope: z.infer<typeof artifactSchema>;

      if (!lastLine) {
        envelope = {
          type: "error",
          title: "No Output",
          summary: "Script produced no stdout. It likely crashed before reaching the final print().",
          message: exec.error
            ? `${exec.error.name}: ${exec.error.value}`
            : "Script exited without printing a JSON envelope.",
          traceback: exec.error?.traceback ?? undefined,
        };
      } else {
        try {
          const parsed = JSON.parse(lastLine);
          envelope = artifactSchema.parse(parsed);
        } catch (parseError) {
          envelope = {
            type: "error",
            title: "Output Contract Violation",
            summary: "Script did not produce a valid JSON output envelope as its final stdout line.",
            message: `Parse error: ${(parseError as Error).message}. Last stdout line: ${lastLine}`,
          };
        }
      }

      const truncatedEnvelope = truncateEnvelopeData(envelope);

      // ── Write to analysis_artifacts if execution succeeded ────────────────
      let artifactId: string | undefined;
      if (envelope.type !== "error") {
        const { data: artifact } = await supabase
          .from("analysis_artifacts")
          .insert({
            org_id: orgId,
            session_id: sessionId,
            template_id: templateId ?? null,
            raw_upload_id: rawUploadId,
            html: typeof (envelope as Record<string, unknown>).html === "string"
              ? (envelope as Record<string, unknown>).html as string
              : null,
            data: (envelope as Record<string, unknown>).data ?? {},
            summary: envelope.summary,
            input_params: context.params ?? {},
          })
          .select("id")
          .single();

        artifactId = artifact?.id as string | undefined;
      }

      return {
        envelope: truncatedEnvelope,
        artifactId,
        code,
        stdout,
        stderr,
        exitCode,
      };
    } catch (err) {
      return {
        envelope: {
          type: "error" as const,
          title: "Sandbox Error",
          summary: "The E2B sandbox threw an exception before execution completed.",
          message: (err as Error).message,
        },
        code,
        stdout: "",
        stderr: "",
        exitCode: 1,
        error: (err as Error).message,
      };
    } finally {
      await sandbox.kill();
    }
  },
});
