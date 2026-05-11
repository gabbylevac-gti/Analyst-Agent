/**
 * Tool: proposeAnalysis
 *
 * In Collaborate TE mode, the agent calls this tool to present analysis code
 * to the user BEFORE executing it. The tool result is rendered as a
 * CodeApprovalCard in the UI. The agent must stop after calling this tool and
 * wait for [Code approved] in the next user message before calling executeAnalysis.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const proposeAnalysisTool = createTool({
  id: "propose-analysis",
  description:
    "In Collaborate TE mode: call this tool to present the analysis code to the user " +
    "for approval BEFORE calling executeAnalysis. The result is rendered as a code-approval card. " +
    "After calling this tool, STOP — do not call executeAnalysis in the same turn. " +
    "Wait for [Code approved] in the next user message, then call executeAnalysis with the same code. " +
    "In Delegate mode, skip this tool entirely and call executeAnalysis directly.",
  inputSchema: z.object({
    summary: z.string().describe(
      "Plain-language explanation: what this analysis computes, which table(s) it queries, and why it answers the user's question."
    ),
    code: z.string().describe(
      "The exact Python code you plan to pass to executeAnalysis. Must use psycopg2 + audience tables."
    ),
  }),
  outputSchema: z.object({
    type: z.literal("code_approval"),
    summary: z.string(),
    code: z.string(),
    status: z.literal("pending"),
  }),
  execute: async ({ summary, code }) => ({
    type: "code_approval" as const,
    summary,
    code,
    status: "pending" as const,
  }),
});
