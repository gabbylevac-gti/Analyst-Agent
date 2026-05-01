/**
 * Tool: writeBelief
 *
 * Writes an approved belief or session summary to Supabase.
 * Called only after explicit user approval — never autonomously.
 *
 * Also handles session summaries (type: "session_summary") which go to
 * the session_summaries table rather than knowledge_beliefs.
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

export const writeBeliefTool = createTool({
  id: "write-belief",
  description:
    "Write an approved belief, false-belief, or session summary to the knowledge graph in Supabase. " +
    "Only call this after the user has explicitly approved the belief content. " +
    "For session summaries, set type to 'session_summary' — these go to session_summaries table.",
  inputSchema: z.object({
    content: z.string().describe("The belief content in plain language"),
    type: z
      .enum(["take-away", "belief", "false-belief", "pending", "algorithm-version", "session_summary"])
      .describe("Belief category"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Confidence score 0.0–1.0"),
    tags: z
      .array(z.string())
      .describe("Topic tags for retrieval (e.g. ['ghost-detection', 'path-classification'])"),
    evidenceSessionId: z
      .string()
      .optional()
      .describe("Session ID where the supporting evidence was gathered"),
    // For session summaries only
    sessionId: z
      .string()
      .optional()
      .describe("Session ID (required when type is session_summary)"),
    keyFindings: z
      .array(z.string())
      .optional()
      .describe("Key findings list (for session summaries)"),
    approvedBeliefIds: z
      .array(z.string())
      .optional()
      .describe("Belief IDs approved in this session (for session summaries)"),
    approvedTemplateIds: z
      .array(z.string())
      .optional()
      .describe("Template IDs saved in this session (for session summaries)"),
    // For updating existing beliefs
    existingBeliefId: z
      .string()
      .optional()
      .describe("If updating an existing belief, provide its ID"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context }) => {
    const supabase = getSupabase();

    try {
      // ── Session summary — goes to session_summaries table ──────────────
      if (context.type === "session_summary") {
        if (!context.sessionId) {
          return { success: false, message: "sessionId is required for session summaries" };
        }

        const { data, error } = await supabase
          .from("session_summaries")
          .insert({
            session_id: context.sessionId,
            summary_text: context.content,
            key_findings: context.keyFindings ?? [],
            approved_belief_ids: context.approvedBeliefIds ?? [],
            approved_template_ids: context.approvedTemplateIds ?? [],
          })
          .select("id")
          .single();

        if (error) throw error;
        return {
          success: true,
          id: data?.id,
          message: "Session summary saved. Will be loaded in future sessions.",
        };
      }

      // ── Update existing belief ─────────────────────────────────────────
      if (context.existingBeliefId) {
        const { data, error } = await supabase
          .from("knowledge_beliefs")
          .update({
            content: context.content,
            type: context.type,
            confidence: context.confidence,
            tags: context.tags,
            evidence_session_id: context.evidenceSessionId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", context.existingBeliefId)
          .select("id")
          .single();

        if (error) throw error;
        return {
          success: true,
          id: data?.id,
          message: `Belief updated (confidence: ${context.confidence}). Available in all future sessions.`,
        };
      }

      // ── Insert new belief ──────────────────────────────────────────────
      const { data, error } = await supabase
        .from("knowledge_beliefs")
        .insert({
          content: context.content,
          type: context.type,
          confidence: context.confidence,
          tags: context.tags,
          evidence_session_id: context.evidenceSessionId ?? null,
        })
        .select("id")
        .single();

      if (error) throw error;

      return {
        success: true,
        id: data?.id,
        message: `Belief saved (${context.type}, confidence: ${context.confidence}). Available as a hypothesis in all future sessions.`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to write belief: ${(err as Error).message}`,
      };
    }
  },
});
