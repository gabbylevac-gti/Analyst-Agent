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
    "Submit a belief, false-belief, or session summary to Supabase. " +
    "For beliefs, always pass pendingApproval: true — the record is saved as pending and the user " +
    "approves it via the inline card in the chat UI. Do not wait for a text 'yes' first. " +
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
    pendingApproval: z
      .boolean()
      .default(true)
      .describe("Always true for agent calls. Saves the belief as pending so the user can approve via the UI."),
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
    orgId: z
      .string()
      .describe("Organization ID — use the orgId returned by getSessionContext"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    belief_id: z.string().optional(),
    kind: z.literal("belief").optional(),
    approval_status: z.enum(["pending", "approved"]).optional(),
    content: z.string().optional(),
    type: z.string().optional(),
    confidence: z.number().optional(),
    tags: z.array(z.string()).optional(),
    proposed_tags: z.array(z.string()).optional(),
    message: z.string(),
  }),
  execute: async (context) => {
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
            org_id: context.orgId,
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

      const approvalStatus: "pending" | "approved" = context.pendingApproval ? "pending" : "approved";

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
            approval_status: approvalStatus,
            updated_at: new Date().toISOString(),
          })
          .eq("id", context.existingBeliefId)
          .select("id")
          .single();

        if (error) throw error;
        return {
          success: true,
          id: data?.id,
          kind: "belief" as const,
          approval_status: approvalStatus,
          content: context.content,
          type: context.type,
          confidence: context.confidence,
          tags: context.tags,
          message: approvalStatus === "pending"
            ? "Belief update submitted for approval."
            : `Belief updated (confidence: ${context.confidence}). Available in all future sessions.`,
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
          approval_status: approvalStatus,
          org_id: context.orgId,
          source: "observation",
        })
        .select("id")
        .single();

      if (error) throw error;

      return {
        success: true,
        id: data?.id,
        belief_id: data?.id,
        kind: "belief" as const,
        approval_status: approvalStatus,
        content: context.content,
        type: context.type,
        confidence: context.confidence,
        tags: context.tags,
        proposed_tags: context.tags,
        message: approvalStatus === "pending"
          ? "Belief submitted for approval. The user will see an inline approval card."
          : `Belief saved (${context.type}, confidence: ${context.confidence}). Available as a hypothesis in all future sessions.`,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to write belief: ${(err as Error).message}`,
      };
    }
  },
});
