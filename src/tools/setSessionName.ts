/**
 * Tool: setSessionName
 *
 * Writes a human-readable name to the sessions table.
 * Called on the first user message so the sidebar can display a meaningful
 * title immediately rather than showing "Untitled" or a raw session ID.
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

export const setSessionNameTool = createTool({
  id: "set-session-name",
  description:
    "Set a concise display name for the current session. " +
    "Call this on the first user message only, in parallel with getSessionContext. " +
    "The name appears immediately in the sidebar via the tool-result stream event.",
  inputSchema: z.object({
    sessionId: z.string().describe("Current session ID"),
    name: z
      .string()
      .describe(
        "3–5 word name capturing the analytical objective (e.g. 'Ghost Path Threshold Analysis', " +
        "'Q2 Sensor A Traffic Review'). Specific beats generic — avoid 'Data Analysis' or 'Session 1'."
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    name: z.string(),
    message: z.string(),
  }),
  execute: async (context) => {
    const supabase = getSupabase();

    try {
      const { error } = await supabase
        .from("sessions")
        .update({ name: context.name })
        .eq("id", context.sessionId);

      if (error) throw error;

      return {
        success: true,
        name: context.name,
        message: `Session named: "${context.name}"`,
      };
    } catch (err) {
      return {
        success: false,
        name: context.name,
        message: `Failed to set session name: ${(err as Error).message}`,
      };
    }
  },
});
