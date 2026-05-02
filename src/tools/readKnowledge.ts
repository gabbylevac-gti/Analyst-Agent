/**
 * Tool: readKnowledge
 *
 * Reads from the knowledge graph during a session — useful for mid-conversation
 * lookups when the agent needs to check a specific belief or template without
 * reloading the full session context.
 *
 * For full session priming, use getSessionContext instead.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );
}

export const readKnowledgeTool = createTool({
  id: "read-knowledge",
  description:
    "Query the knowledge graph for beliefs or code templates matching specific tags or a search term. " +
    "Use mid-conversation when checking whether a belief exists before proposing a new one, " +
    "or when looking up a specific template by name.",
  inputSchema: z.object({
    type: z
      .enum(["beliefs", "templates", "both"])
      .describe("What to query"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Filter by tags (e.g. ['ghost-detection', 'path-classification'])"),
    searchTerm: z
      .string()
      .optional()
      .describe("Free-text search in content/description fields"),
    templateName: z
      .string()
      .optional()
      .describe("Exact template name lookup (e.g. 'ghost-classifier-v1')"),
    orgId: z
      .string()
      .optional()
      .describe("Organization ID — use the orgId returned by getSessionContext to prevent cross-org leakage"),
  }),
  outputSchema: z.object({
    beliefs: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        type: z.string(),
        confidence: z.number(),
        tags: z.array(z.string()),
        evidence_session_id: z.string().nullable(),
        created_at: z.string(),
      })
    ),
    templates: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        code: z.string(),
        tags: z.array(z.string()),
        version: z.string(),
        approved_at: z.string(),
      })
    ),
  }),
  execute: async (context) => {
    const { type, tags, searchTerm, templateName, orgId } = context;
    const supabase = getSupabase();

    let beliefs: any[] = [];
    let templates: any[] = [];

    // ── Query beliefs ──────────────────────────────────────────────────────
    if (type === "beliefs" || type === "both") {
      let query = supabase
        .from("knowledge_beliefs")
        .select("id, content, type, confidence, tags, evidence_session_id, created_at")
        .order("confidence", { ascending: false })
        .limit(20);

      if (orgId) query = query.eq("org_id", orgId);
      if (tags && tags.length > 0) {
        query = query.overlaps("tags", tags);
      }
      if (searchTerm) {
        query = query.ilike("content", `%${searchTerm}%`);
      }

      const { data } = await query;
      beliefs = data ?? [];
    }

    // ── Query templates ────────────────────────────────────────────────────
    if (type === "templates" || type === "both") {
      let query = supabase
        .from("code_templates")
        .select("id, name, description, code, tags, version, approved_at")
        .order("approved_at", { ascending: false })
        .limit(20);

      if (orgId) query = query.eq("org_id", orgId);
      if (templateName) {
        query = query.eq("name", templateName);
      } else {
        if (tags && tags.length > 0) {
          query = query.overlaps("tags", tags);
        }
        if (searchTerm) {
          query = query.ilike("description", `%${searchTerm}%`);
        }
      }

      const { data } = await query;
      templates = data ?? [];
    }

    return { beliefs, templates };
  },
});
