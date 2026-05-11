/**
 * Tool: executeQueryData
 *
 * Runs exploration code against the clean audience tables to give the agent
 * real statistics BEFORE it writes the belief statement and calls executeChart.
 * This is Step 1 of the Take-Away flow.
 *
 * Unlike executeChart, this tool does NOT return an artifact envelope — the
 * frontend renders only a collapsed tool indicator. The data is returned
 * directly to the agent for interpretation.
 *
 * In Collaborate mode, this tool is called after the user approves proposeQueryData.
 * In Delegate mode, this tool is called directly (no approval step).
 *
 * Exploration code pattern:
 *   import psycopg2, os, json, pandas as pd
 *   conn = psycopg2.connect(os.environ["DB_URL"])
 *   cur = conn.cursor()
 *   cur.execute("SELECT ... FROM audience_observations WHERE raw_upload_id = %s",
 *               (os.environ["RAW_UPLOAD_ID"],))
 *   rows = [r[0] for r in cur.fetchall()]
 *   # ... compute statistics ...
 *   print(json.dumps({ "n_real": 847, "engagement_rate": 23.4, "summary": "..." }))
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";

export const executeQueryDataTool = createTool({
  id: "execute-query-data",
  description:
    "Explore the clean audience tables to compute statistics for formulating a Take-Away. " +
    "Returns data to the agent but renders NO chart or table in the chat — only a collapsed tool indicator. " +
    "ALWAYS call this before writing the belief statement so your answer contains real numbers. " +
    "In Delegate mode, call this directly. In Collaborate mode, call proposeQueryData first and wait for approval. " +
    "The exploration code must query audience_observations, audience_15min_agg, or audience_day_agg via psycopg2 " +
    "(DB_URL env var) and print a JSON object with named statistic fields + a summary string as its final stdout line. " +
    "Do NOT use this for producing charts — use executeChart for rendering.",
  inputSchema: z.object({
    rawUploadId: z.string().describe(
      "raw_data_uploads.id — injected as RAW_UPLOAD_ID env var so the code can filter records"
    ),
    orgId: z.string().describe("Organization ID"),
    code: z.string().describe(
      "Python exploration code. Must connect to Postgres via psycopg2 (DB_URL env var), " +
      "query audience_observations/audience_15min_agg/audience_day_agg filtered by RAW_UPLOAD_ID, " +
      "compute statistics, and print a JSON object as the final stdout line. " +
      "Include a 'summary' key with a plain-language sentence describing the key findings."
    ),
  }),
  outputSchema: z.object({
    data: z.record(z.unknown()),
    summary: z.string(),
    stdout: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { rawUploadId, code } = context;
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });

    try {
      await sandbox.runCode(
        "import subprocess; subprocess.run(['pip', 'install', 'pandas', 'numpy', 'psycopg2-binary', '--quiet', '--root-user-action=ignore'], check=True, capture_output=True)",
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
      const lines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];

      if (!lastLine) {
        const errMsg = exec.error
          ? `${exec.error.name}: ${exec.error.value}`
          : "Script produced no output";
        return {
          data: {},
          summary: `Exploration failed: ${errMsg}`,
          stdout,
          error: errMsg,
        };
      }

      let data: Record<string, unknown> = {};
      let summary = "";

      try {
        const parsed = JSON.parse(lastLine);
        if (typeof parsed === "object" && parsed !== null) {
          data = parsed as Record<string, unknown>;
          summary = typeof parsed.summary === "string" ? parsed.summary : JSON.stringify(parsed).slice(0, 300);
        } else {
          data = { value: parsed };
          summary = String(parsed).slice(0, 300);
        }
      } catch {
        data = { raw: lastLine };
        summary = lastLine.slice(0, 300);
      }

      return { data, summary, stdout };
    } catch (err) {
      return {
        data: {},
        summary: `Sandbox error: ${(err as Error).message}`,
        stdout: "",
        error: (err as Error).message,
      };
    } finally {
      await sandbox.kill();
    }
  },
});
