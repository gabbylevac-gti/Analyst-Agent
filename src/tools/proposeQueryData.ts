/**
 * Tool: proposeQueryData
 *
 * In Collaborate TE mode, the agent calls this tool to present exploration
 * code to the user BEFORE executing it. The tool result is rendered as a
 * CodeApprovalCard in the UI. The agent must stop after calling this tool and
 * wait for [Code approved] in the next user message before calling executeQueryData.
 *
 * In Delegate mode, skip this tool entirely and call executeQueryData directly.
 *
 * This is the Collaborate gate for the data exploration step — the query/transform
 * code is the impactful decision (determines what conclusions are possible).
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const proposeQueryDataTool = createTool({
  id: "propose-query-data",
  description:
    "In Collaborate TE mode: call this tool to present the data exploration code to the user " +
    "for approval BEFORE calling executeQueryData. The result is rendered as a code-approval card. " +
    "After calling this tool, STOP — do not call executeQueryData in the same turn. " +
    "Wait for [Code approved] in the next user message, then call executeQueryData with the same code. " +
    "In Delegate mode, skip this tool entirely and call executeQueryData directly.",
  inputSchema: z.object({
    summary: z.string().describe(
      "Plain-language explanation: what this query computes, which table(s) it reads, and why it answers the user's question."
    ),
    code: z.string().describe(
      "The exact Python exploration code you plan to pass to executeQueryData."
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
