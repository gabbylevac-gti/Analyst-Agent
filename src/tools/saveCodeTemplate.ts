/**
 * Tool: saveCodeTemplate
 *
 * Saves an approved Python analysis template to Supabase code_templates table.
 * Called only after explicit user approval via the save-approved-template skill.
 *
 * Templates saved here are available in all future sessions via getSessionContext.
 * If a template with the same name already exists, a new version is created.
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

export const saveCodeTemplateTool = createTool({
  id: "save-code-template",
  description:
    "Submit a parameterized Python analysis template to Supabase for user approval. " +
    "Always pass pendingApproval: true — the template is saved as pending and the user " +
    "approves it via the inline card in the chat UI. Do not wait for a text 'yes' first. " +
    "If a template with this name exists, the new version is saved alongside the original (not overwritten).",
  inputSchema: z.object({
    name: z
      .string()
      .describe("Template name in kebab-case with version suffix (e.g. 'ghost-classifier-v1')"),
    description: z
      .string()
      .describe("One sentence: what question does this template answer?"),
    code: z
      .string()
      .describe("The complete parameterized Python script with {{PLACEHOLDER}} tokens"),
    tags: z
      .array(z.string())
      .describe("Topic tags (e.g. ['path-classification', 'ghost-detection'])"),
    parameters: z
      .array(
        z.object({
          name: z.string(),
          description: z.string(),
          example: z.string().optional(),
        })
      )
      .describe("List of {{PLACEHOLDER}} tokens with descriptions"),
    pendingApproval: z
      .boolean()
      .default(true)
      .describe("Always true for agent calls. Saves the template as pending so the user can approve via the UI."),
    sourceSessionId: z
      .string()
      .optional()
      .describe("Session ID where this template was developed and tested"),
    version: z
      .string()
      .describe("Version string (e.g. 'v1', 'v2')"),
    orgId: z
      .string()
      .describe("Organization ID — use the orgId returned by getSessionContext"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    kind: z.literal("template").optional(),
    approval_status: z.enum(["pending", "approved"]).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    code: z.string().optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional(),
    parameters: z.array(z.object({
      name: z.string(),
      description: z.string(),
      example: z.string().optional(),
    })).optional(),
    message: z.string(),
    alreadyExisted: z.boolean(),
  }),
  execute: async (context) => {
    const supabase = getSupabase();

    try {
      // ── Check if this name already exists ──────────────────────────────
      const { data: existing } = await supabase
        .from("code_templates")
        .select("id, name, version")
        .eq("name", context.name)
        .single();

      const alreadyExisted = !!existing;
      const approvalStatus = context.pendingApproval ? "pending" : "approved";

      // ── Insert the template ────────────────────────────────────────────
      const { data, error } = await supabase
        .from("code_templates")
        .insert({
          name: context.name,
          description: context.description,
          code: context.code,
          tags: context.tags,
          parameters: context.parameters,
          version: context.version,
          source_session_id: context.sourceSessionId ?? null,
          approved_at: new Date().toISOString(),
          approval_status: approvalStatus,
          org_id: context.orgId,
        })
        .select("id")
        .single();

      if (error) throw error;

      const message = approvalStatus === "pending"
        ? `Template '${context.name}' submitted for approval. The user will see an inline approval card.`
        : alreadyExisted
          ? `Template '${context.name}' saved as a new version alongside the existing one.`
          : `Template '${context.name}' saved. Available in all future sessions.`;

      return {
        success: true,
        id: data?.id,
        kind: "template" as const,
        approval_status: approvalStatus,
        name: context.name,
        description: context.description,
        code: context.code,
        tags: context.tags,
        version: context.version,
        parameters: context.parameters,
        message,
        alreadyExisted,
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to save template: ${(err as Error).message}`,
        alreadyExisted: false,
      };
    }
  },
});
