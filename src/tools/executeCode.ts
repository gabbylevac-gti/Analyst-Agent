/**
 * Tool: executeCode
 *
 * Runs a Python script in an E2B code sandbox. Uploads the session CSV,
 * executes the script, and parses the output envelope from the final stdout line.
 *
 * The script MUST end with print(json.dumps({...})) per the Output Contract.
 * See knowledge/output-contract.md.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";

// ─── Output envelope schema ────────────────────────────────────────────────────

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

// ─── Tool definition ───────────────────────────────────────────────────────────

export const executeCodeTool = createTool({
  id: "execute-code",
  description:
    "Execute a Python script in a sandboxed E2B environment. Provide the script as a string. " +
    "Optionally provide the CSV URL to upload to the sandbox before execution. " +
    "Returns the parsed output envelope (chart, table, text, or multi artifact).",
  inputSchema: z.object({
    code: z.string().describe("The complete Python script to execute"),
    csvUrl: z
      .string()
      .optional()
      .describe("Supabase Storage URL for the session CSV file. Downloaded and written to /sandbox/upload.csv before execution."),
  }),
  outputSchema: z.object({
    envelope: artifactSchema,
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { code, csvUrl } = context;

    const sandbox = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
    });

    try {
      // ── Upload CSV if provided ─────────────────────────────────────────────
      if (csvUrl) {
        const response = await fetch(csvUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch CSV from ${csvUrl}: ${response.statusText}`);
        }
        const csvBuffer = await response.arrayBuffer();
        await sandbox.files.write("/sandbox/upload.csv", csvBuffer);
      }

      // ── Pre-install common libraries so user scripts don't need to ───────
      await sandbox.runCode(
        "import subprocess; subprocess.run(['pip', 'install', 'plotly', 'pandas', 'numpy', 'scipy', '--quiet', '--root-user-action=ignore'], check=True, capture_output=True)",
        { language: "python" }
      );

      // ── Execute the script ─────────────────────────────────────────────────
      const exec = await sandbox.runCode(code, { language: "python" });

      const stdout = exec.logs.stdout.join("\n");
      const stderr = exec.logs.stderr.join("\n");
      const exitCode = exec.exitCode ?? (exec.error ? 1 : 0);

      // ── Parse output envelope from final stdout line ───────────────────────
      const lines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];

      let envelope: z.infer<typeof artifactSchema>;
      if (!lastLine) {
        // Empty stdout — script crashed before printing the output envelope.
        // Synthesize an error envelope so the agent retries rather than
        // silently moving on with an undefined result.
        envelope = {
          type: "error",
          title: "No Output",
          summary: "Script produced no stdout. It likely crashed before reaching the final print().",
          message: exec.error
            ? `${exec.error.name}: ${exec.error.value}`
            : "Script exited without printing a JSON envelope.",
          traceback: exec.error?.traceback?.join("\n"),
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

      return { envelope, stdout, stderr, exitCode };
    } catch (err) {
      return {
        envelope: {
          type: "error" as const,
          title: "Sandbox Error",
          summary: "The E2B sandbox threw an exception before execution completed.",
          message: (err as Error).message,
        },
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
