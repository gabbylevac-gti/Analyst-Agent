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

const ScopeFieldSchema = z.object({
  regions: z.array(z.string()),
  locations: z.array(z.object({ id: z.string(), name: z.string() })),
  endpoints: z.array(z.object({ id: z.string(), name: z.string() })),
  data_sources: z.array(z.string()),
  date_range: z.object({ start: z.string(), end: z.string() }).nullable(),
}).optional().describe(
  "Data access scope for this session. Always include in every proposeQueryData call. " +
  "When present, the card renders a 'Data Access' section with editable tags. " +
  "Accepting the card writes sessions.scope with approved: true."
);

const AvailableOptionsSchema = z.object({
  endpoints: z.array(z.object({ id: z.string(), name: z.string() })),
  locations: z.array(z.object({ id: z.string(), name: z.string() })),
  regions: z.array(z.string()),
}).optional().describe(
  "All org-level endpoints/locations/regions from getSessionContext.availableEndpoints. " +
  "These populate the Add dropdowns in the Data Access section so the user can add " +
  "endpoints/locations/regions that are not yet in scope. Always pass this."
);

export const proposeQueryDataTool = createTool({
  id: "propose-query-data",
  description:
    "In Collaborate TE mode: call this tool to present the data exploration code to the user " +
    "for approval BEFORE calling executeQueryData. The result is rendered as a code-approval card. " +
    "After calling this tool, STOP — do not call executeQueryData in the same turn. " +
    "Wait for [Code approved] or [Scope updated: ...] in the next user message. " +
    "In Delegate mode, skip this tool entirely and call executeQueryData directly. " +
    "Always pass `scope` and `availableOptions` so the card shows the Data Access section " +
    "with editable endpoint/location/data-source tags and working Add dropdowns.",
  inputSchema: z.object({
    summary: z.string().describe(
      "Plain-language explanation: what this query computes, which table(s) it reads, and why it answers the user's question."
    ),
    code: z.string().describe(
      "The exact Python exploration code you plan to pass to executeQueryData."
    ),
    scope: ScopeFieldSchema,
    availableOptions: AvailableOptionsSchema,
  }),
  outputSchema: z.object({
    type: z.literal("code_approval"),
    summary: z.string(),
    code: z.string(),
    status: z.literal("pending"),
    scope: ScopeFieldSchema,
    availableOptions: AvailableOptionsSchema,
  }),
  execute: async ({ summary, code, scope, availableOptions }) => ({
    type: "code_approval" as const,
    summary,
    code,
    status: "pending" as const,
    scope,
    availableOptions,
  }),
});
