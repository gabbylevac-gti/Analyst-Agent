/**
 * Tool: executeChart
 *
 * Runs chart code against the dataset_records clean layer and produces an
 * interactive Plotly visualization. This is Stage 2 of the two-stage pipeline:
 *   Stage 1 (executeTransform) — Raw → Clean: raw CSV → dataset_records
 *   Stage 2 (this tool)        — Clean → Chart: dataset_records → analysis_artifacts
 *
 * Returns a compact envelope (type/title/summary/insights only) and the artifact
 * ID for frontend rendering. html/data are stored in analysis_artifacts and fetched
 * by the frontend directly — not returned to the agent to keep token usage low.
 *
 * Chart code pattern:
 *   import psycopg2, os, json
 *   conn = psycopg2.connect(os.environ["DB_URL"])
 *   cur = conn.cursor()
 *   cur.execute("SELECT ... FROM audience_observations WHERE raw_upload_id = %s",
 *               (os.environ["RAW_UPLOAD_ID"],))
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

export const executeChartTool = createTool({
  id: "execute-chart",
  description:
    "Execute chart code against the clean audience tables to produce an interactive Plotly visualization. " +
    "Injects a Postgres read-only connection (DB_URL env var) so the code can query " +
    "audience_observations, audience_15min_agg, or audience_day_agg filtered by RAW_UPLOAD_ID. " +
    "Writes the output envelope to analysis_artifacts and returns it. " +
    "Always pass rawUploadId (not csvUrl) — chart code reads from Postgres, not Storage. " +
    "Requires executeTransform to have run first.",
  inputSchema: z.object({
    rawUploadId: z.string().describe(
      "raw_data_uploads.id — injected as RAW_UPLOAD_ID env var for the chart code to filter records"
    ),
    orgId: z.string().describe("Organization ID"),
    sessionId: z.string().describe("Session ID — used to link the written analysis_artifact"),
    code: z.string().describe(
      "Chart Python code. Must connect to Postgres via psycopg2 (DB_URL env var), " +
      "query audience_observations/audience_15min_agg/audience_day_agg filtered by RAW_UPLOAD_ID, " +
      "and print a valid output envelope as the final stdout line."
    ),
    params: z.record(z.unknown()).optional().describe("Template parameters (thresholds, time windows, etc.)"),
    templateId: z.string().optional().describe("code_templates.id if running an approved template"),
    updateArtifactId: z.string().optional().describe(
      "When set, UPDATE this analysis_artifacts row in-place instead of inserting a new one. " +
      "Used for chart edit reruns so the original TakeAwayCard updates without creating a new one."
    ),
  }),
  outputSchema: z.object({
    envelope: artifactSchema,
    artifactId: z.string().optional(),
    exitCode: z.number(),
    error: z.string().optional(),
    code: z.string().optional(),
  }),
  execute: async (context) => {
    const { rawUploadId, orgId, sessionId, code, templateId, updateArtifactId } = context;
    const supabase = getSupabase();

    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });

    try {
      await sandbox.runCode(
        "import subprocess; subprocess.run(['pip', 'install', 'plotly', 'pandas', 'numpy', 'scipy', 'psycopg2-binary', '--quiet', '--root-user-action=ignore'], check=True, capture_output=True)",
        { language: "python" }
      );

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
      const exitCode = exec.error ? 1 : 0;

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

      let artifactId: string | undefined;
      if (envelope.type !== "error") {
        const artifactPayload = {
          html: typeof (envelope as Record<string, unknown>).html === "string"
            ? (envelope as Record<string, unknown>).html as string
            : null,
          data: (envelope as Record<string, unknown>).data ?? {},
          summary: envelope.summary,
          insights: Array.isArray((envelope as Record<string, unknown>).insights)
            ? (envelope as Record<string, unknown>).insights as string[]
            : [],
          input_params: context.params ?? {},
          code,
        };

        if (updateArtifactId) {
          await supabase
            .from("analysis_artifacts")
            .update(artifactPayload)
            .eq("id", updateArtifactId);
          artifactId = updateArtifactId;
        } else {
          const { data: artifact } = await supabase
            .from("analysis_artifacts")
            .insert({
              org_id: orgId,
              session_id: sessionId,
              template_id: templateId ?? null,
              raw_upload_id: rawUploadId,
              ...artifactPayload,
            })
            .select("id")
            .single();
          artifactId = artifact?.id as string | undefined;
        }
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
