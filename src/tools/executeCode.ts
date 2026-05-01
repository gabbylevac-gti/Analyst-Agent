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
import pkg from "@e2b/code-interpreter";
const { CodeInterpreter } = pkg;

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
    envelope: artifactSchema.optional(),
    stdout: z.string(),
    stderr: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { code, csvUrl } = context;

    const sandbox = await CodeInterpreter.create({
      apiKey: process.env.E2B_API_KEY,
    });

    try {
      // ── Upload CSV if provided ─────────────────────────────────────────────
      if (csvUrl) {
        const response = await fetch(csvUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch CSV from ${csvUrl}: ${response.statusText}`);
        }
        const csvBuffer = Buffer.from(await response.arrayBuffer());
        await sandbox.files.write("/sandbox/upload.csv", csvBuffer);
      }

      // ── Execute the script ─────────────────────────────────────────────────
      const exec = await sandbox.runCode(code, { language: "python" });

      const stdout = exec.logs.stdout.join("\n");
      const stderr = exec.logs.stderr.join("\n");

      // ── Parse output envelope from final stdout line ───────────────────────
      const lines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = lines[lines.length - 1];

      let envelope: z.infer<typeof artifactSchema> | undefined;
      if (lastLine) {
        try {
          const parsed = JSON.parse(lastLine);
          envelope = artifactSchema.parse(parsed);
        } catch (parseError) {
          // Final line was not a valid envelope — surface as error
          envelope = {
            type: "error",
            title: "Output Contract Violation",
            summary: "Script did not produce a valid JSON output envelope as its final stdout line.",
            message: `Parse error: ${(parseError as Error).message}. Last stdout line: ${lastLine}`,
          };
        }
      }

      return { envelope, stdout, stderr };
    } catch (err) {
      return {
        envelope: undefined,
        stdout: "",
        stderr: "",
        error: (err as Error).message,
      };
    } finally {
      await sandbox.close();
    }
  },
});
