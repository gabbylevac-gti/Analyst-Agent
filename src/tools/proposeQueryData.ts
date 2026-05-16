/**
 * Tool: proposeQueryData
 *
 * In Collaborate TE mode, the agent calls this tool to present exploration
 * code to the user BEFORE executing it. The tool result is rendered as a
 * CodeApprovalCard in the UI. The agent must stop after calling this tool and
 * wait for [Code approved] or [Scope updated: ...] in the next user message.
 *
 * In Delegate mode, skip this tool entirely and call executeQueryData directly.
 *
 * When session_id is provided, the tool also writes the proposal to
 * sessions.pending_proposal so the existing card can update in place via
 * Realtime instead of creating a new visible card. Set is_revision: true on
 * all calls made after a [Scope updated] message — the new card suppresses
 * itself and only the original card (via Realtime) shows the revised content.
 */

import { createTool } from "@mastra/core/tools";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const getSupabase = () =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

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
  endpoints: z.array(z.object({
    id: z.string(),
    name: z.string(),
    location_id: z.string().optional().describe("UUID of the store location this endpoint is at — required for cascading removal when locations change."),
  })),
  locations: z.array(z.object({
    id: z.string(),
    name: z.string(),
    region: z.string().optional().describe("Region name this location belongs to — required for cascading removal when regions change."),
  })),
  regions: z.array(z.string()),
}).optional().describe(
  "All org-level endpoints/locations/regions from getSessionContext.availableEndpoints. " +
  "These populate the Add dropdowns in the Data Access section so the user can add " +
  "endpoints/locations/regions not yet in scope. " +
  "Always pass this. Include location_id on each endpoint and region on each location " +
  "so the frontend can cascade removals (removing a region removes its locations and endpoints)."
);

export const proposeQueryDataTool = createTool({
  id: "propose-query-data",
  description:
    "In Collaborate TE mode: call this tool to present the data exploration code to the user " +
    "for approval BEFORE calling executeQueryData. The result is rendered as a code-approval card. " +
    "After calling this tool, STOP — do not call executeQueryData in the same turn. " +
    "Wait for [Code approved] or [Scope updated: ...] in the next user message. " +
    "In Delegate mode, skip this tool entirely and call executeQueryData directly. " +
    "Always pass scope, availableOptions (with location_id on endpoints, region on locations), " +
    "session_id, and objective. " +
    "Set is_revision: true when calling after a [Scope updated] message — this suppresses the " +
    "new card; the existing card updates in place via Realtime.",
  inputSchema: z.object({
    summary: z.string().describe(
      "Plain-language explanation: what this query computes, which table(s) it reads, and why it answers the user's question."
    ),
    code: z.string().describe(
      "The exact Python exploration code you plan to pass to executeQueryData."
    ),
    scope: ScopeFieldSchema,
    availableOptions: AvailableOptionsSchema,
    session_id: z.string().optional().describe(
      "The session UUID from getSessionContext. Always pass this. Used to write the proposal to " +
      "sessions.pending_proposal so the existing CodeApprovalCard can update in place via Realtime."
    ),
    objective: z.string().optional().describe(
      "The session objective statement from getSessionContext (sessions.objective). Always pass this. " +
      "Shown above the Data Access section in the card."
    ),
    is_revision: z.boolean().optional().describe(
      "Set to true when calling after a [Scope updated: ...] message. The new card suppresses itself; " +
      "only the original card (already on screen) shows the revised content via Realtime. " +
      "Do NOT include explanatory text in the response when is_revision is true — output only the tool call."
    ),
  }),
  outputSchema: z.object({
    type: z.literal("code_approval"),
    summary: z.string(),
    code: z.string(),
    status: z.literal("pending"),
    scope: ScopeFieldSchema,
    availableOptions: AvailableOptionsSchema,
    objective: z.string().optional(),
    is_revision: z.boolean().optional(),
  }),
  execute: async ({ summary, code, scope, availableOptions, session_id, objective, is_revision }) => {
    // Write the proposal to sessions.pending_proposal only on revision calls so
    // the existing card can update in place via Realtime without creating a new
    // visible card. Non-revision calls skip this to avoid false triggers.
    if (session_id && is_revision) {
      try {
        const supabase = getSupabase();
        await supabase
          .from("sessions")
          .update({
            pending_proposal: { summary, code, scope, availableOptions, objective },
          })
          .eq("id", session_id);
      } catch {
        // Non-fatal — card will still show as a new card if Realtime doesn't pick it up
      }
    }

    return {
      type: "code_approval" as const,
      summary,
      code,
      status: "pending" as const,
      scope,
      availableOptions,
      objective,
      is_revision: is_revision ?? false,
    };
  },
});
