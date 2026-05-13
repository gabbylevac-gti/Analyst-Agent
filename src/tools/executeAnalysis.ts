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
 * Returns a compact envelope (type/title/summary/insights only), the artifact ID for
 * frontend rendering, and the exit code. html/data are stored in analysis_artifacts
 * and fetched by the frontend directly — not returned to the agent to keep token usage low.
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

// Strip html and data from the agent-facing envelope — these are saved to analysis_artifacts
// and fetched by the frontend via artifactId, so the agent never needs to see them.
function stripHeavyFields(envelope: z.infer<typeof artifactSchema>): z.infer<typeof artifactSchema> {
  const { html: _html, data: _data, ...rest } = envelope as z.infer<typeof artifactSchema> & { html?: unknown; data?: unknown };
  if (rest.type === "multi" && Array.isArray(rest.artifacts)) {
    return {
      ...rest,
      artifacts: rest.artifacts.map(a => {
        const { html: _h, data: _d, ...r } = a as Record<string, unknown>;
        return r;
      }),
    } as z.infer<typeof artifactSchema>;
  }
  return rest as z.infer<typeof artifactSchema>;
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
  insights: z.array(z.string()).optional(),
  summary: z.string(),
  message: z.string().optional(),
  traceback: z.string().optional(),
});

// ─── Tool definition ──────────────────────────────────────────────────────────

export const executeAnalysisTool = createTool({
  id: "execute-analysis",
  description:
    "Execute analysis Python code against the clean audience tables (audience_observations, " +
    "audience_15min_agg, audience_day_agg). Injects DB_URL, ENDPOINT_ID, ORG_ID, and RAW_UPLOAD_ID " +
    "as env vars. Scope rule: when ENDPOINT_ID is non-empty (API session), filter by " +
    "endpoint_id + org_id to get the full dataset across all uploads for that sensor. " +
    "When ENDPOINT_ID is empty (CSV session), filter by RAW_UPLOAD_ID instead. " +
    "Writes the output envelope to analysis_artifacts. Never pass csvUrl — reads from Postgres only.",
  inputSchema: z.object({
    endPointId: z.string().optional().describe(
      "end_points.id — injected as ENDPOINT_ID env var. When set, code scopes by endpoint_id + org_id."
    ),
    orgId: z.string().describe("Organization ID — injected as ORG_ID env var"),
    sessionId: z.string().describe("Session ID — used to link the written analysis_artifact"),
    code: z.string().describe(
      "Analysis Python code. Must connect to Postgres via psycopg2 (DB_URL env var). " +
      "Scope: if ENDPOINT_ID env var is set, filter by endpoint_id + org_id; else filter by org_id alone. " +
      "Print a valid output envelope as the final stdout line."
    ),
    params: z.record(z.unknown()).optional().describe("Template parameters (thresholds, time windows, etc.)"),
    templateId: z.string().optional().describe("code_templates.id if running an approved template"),
  }),
  outputSchema: z.object({
    envelope: artifactSchema,
    artifactId: z.string().optional(),
    exitCode: z.number(),
    error: z.string().optional(),
    code: z.string().optional(),
  }),
  execute: async (context) => {
    const { endPointId, orgId, sessionId, code, templateId } = context;
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
          ENDPOINT_ID: endPointId ?? "",
          ORG_ID: orgId,
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
            raw_upload_id: null,
            html: typeof (envelope as Record<string, unknown>).html === "string"
              ? (envelope as Record<string, unknown>).html as string
              : null,
            data: (envelope as Record<string, unknown>).data ?? {},
            summary: envelope.summary,
            insights: Array.isArray((envelope as Record<string, unknown>).insights)
              ? (envelope as Record<string, unknown>).insights as string[]
              : [],
            input_params: context.params ?? {},
          })
          .select("id")
          .single();

        artifactId = artifact?.id as string | undefined;
      }

      return {
        envelope: stripHeavyFields(truncatedEnvelope),
        artifactId,
        exitCode,
        code,
      };
    } catch (err) {
      return {
        envelope: {
          type: "error" as const,
          title: "Sandbox Error",
          summary: "The E2B sandbox threw an exception before execution completed.",
          message: (err as Error).message,
        },
        exitCode: 1,
        error: (err as Error).message,
        code,
      };
    } finally {
      await sandbox.kill();
    }
  },
});
