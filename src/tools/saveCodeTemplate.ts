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
    "Save an approved, parameterized Python analysis template to Supabase. " +
    "Only call after the user has explicitly confirmed they want to save the template. " +
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
    sourceSessionId: z
      .string()
      .optional()
      .describe("Session ID where this template was developed and tested"),
    version: z
      .string()
      .describe("Version string (e.g. 'v1', 'v2')"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
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
        })
        .select("id")
        .single();

      if (error) throw error;

      const message = alreadyExisted
        ? `Template '${context.name}' saved as a new version alongside the existing one. Both are available in future sessions.`
        : `Template '${context.name}' saved. Available in all future sessions — I'll use it instead of rewriting this analysis.`;

      return { success: true, id: data?.id, message, alreadyExisted };
    } catch (err) {
      return {
        success: false,
        message: `Failed to save template: ${(err as Error).message}`,
        alreadyExisted: false,
      };
    }
  },
});
