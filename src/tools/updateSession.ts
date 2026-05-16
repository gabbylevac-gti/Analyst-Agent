/**
 * Tool: updateSession
 *
 * Writes durable session state to Postgres after each phase gate.
 * This is the agent's single write path for structured lifecycle state:
 *   - phase transition (objective → setup → analysis → wrap_up)
 *   - objective text (captured after user states it in Phase 1)
 *   - active_dataset_id (linked after uploadDataset succeeds)
 *
 * getSessionContext reads these fields at session start so the agent
 * always knows where it is without relying on in-memory state.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );
}

export const updateSessionTool = createTool({
  id: "update-session",
  description:
    "Write durable session state to Postgres. Call this at every phase gate: " +
    "(1) after the user states their objective — set phase='setup' and objective; " +
    "(2) immediately after uploadDataset returns a datasetId — set active_dataset_id; " +
    "(3) after the data dictionary is approved and analysis begins — set phase='analysis'; " +
    "(4) on wrap-up — set phase='wrap_up'. " +
    "This lets the next session pick up exactly where the current one left off. " +
    "In Delegate mode: after proposeQueryData, call with scope + phase='setup' to persist " +
    "the approved scope so DataSourceBar renders without requiring a user Accept click.",
  inputSchema: z.object({
    sessionId: z.string().describe("Current session ID"),
    phase: z
      .enum(["objective", "setup", "analysis", "wrap_up"])
      .optional()
      .describe("New phase value — only pass if transitioning"),
    objective: z
      .string()
      .optional()
      .describe("The user's stated analysis objective — set once in Phase 1"),
    activeDatasetId: z
      .string()
      .optional()
      .describe("datasets.id returned by uploadDataset — links this session to its dataset"),
    scope: z
      .record(z.unknown())
      .optional()
      .describe(
        "Approved scope to persist to sessions.scope. Pass the same scope given to proposeQueryData: " +
        "{ endpoints, date_range, locations, data_sources }. Do NOT add 'approved' manually — " +
        "the tool merges { approved: true, approved_at } automatically. Use in Delegate mode."
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    phase: z.string().optional(),
    activeDatasetId: z.string().optional(),
  }),
  execute: async (context, toolContext) => {
    const supabase = getSupabase();

    const runtimeSessionId = toolContext?.requestContext?.get?.("sessionId") as string | undefined;
    const resolvedSessionId =
      context.sessionId === "current" ? (runtimeSessionId ?? context.sessionId) : context.sessionId;

    const patch: Record<string, unknown> = {};
    if (context.phase !== undefined) patch.phase = context.phase;
    if (context.objective !== undefined) patch.objective = context.objective;
    if (context.activeDatasetId !== undefined) patch.active_dataset_id = context.activeDatasetId;
    if (context.scope !== undefined) {
      patch.scope = { ...context.scope, approved: true, approved_at: new Date().toISOString() };
    }

    if (Object.keys(patch).length === 0) {
      return { success: false, message: "Nothing to update — pass at least one field." };
    }

    const { error } = await supabase
      .from("sessions")
      .update(patch)
      .eq("id", resolvedSessionId);

    if (error) {
      return { success: false, message: `Failed to update session: ${error.message}` };
    }

    return {
      success: true,
      message: "Session state updated.",
      phase: context.phase,
      activeDatasetId: context.activeDatasetId,
    };
  },
});
