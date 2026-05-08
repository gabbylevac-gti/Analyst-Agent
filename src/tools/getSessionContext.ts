/**
 * Tool: getSessionContext
 *
 * The session priming tool. Called at the start of every session to load:
 *   1. Static domain knowledge from .md files
 *   2. Approved beliefs from Supabase knowledge_beliefs table
 *   3. Available code templates from Supabase code_templates table
 *   4. Recent session summaries from Supabase session_summaries table
 *   5. Approved data dictionary if a prior session used the same CSV schema
 *
 * This is what makes each session smarter than the last.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
// Domain knowledge constants moved to analystAgent.ts system prompt.

// ─── Supabase client ───────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );
}

// Static knowledge (domain files, output contract, seed beliefs) is now embedded
// in the agent system prompt via analystAgent.ts. Returning it here too would
// duplicate ~5k tokens into every conversation turn. Return a short confirmation.

// ─── Tool definition ───────────────────────────────────────────────────────────

export const getSessionContextTool = createTool({
  id: "get-session-context",
  description:
    "Load all context needed to prime a session: static domain knowledge, approved beliefs, " +
    "available code templates, recent session summaries, and the data dictionary for the current CSV. " +
    "Call this at the start of every session before responding to the user.",
  inputSchema: z.object({
    sessionId: z.string().describe("Current session ID"),
    csvColumnSignature: z
      .string()
      .optional()
      .describe("Comma-separated list of CSV column names, used to match a prior data dictionary"),
    beliefTags: z
      .array(z.string())
      .optional()
      .describe("Tag filter for beliefs (e.g. ['ghost-detection', 'path-classification']). Leave empty to load all."),
  }),
  outputSchema: z.object({
    staticKnowledge: z.string(),
    orgId: z.string().optional(),
    beliefs: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        type: z.string(),
        confidence: z.number(),
        tags: z.array(z.string()),
        created_at: z.string(),
      })
    ),
    codeTemplates: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        tags: z.array(z.string()),
        version: z.string(),
      })
    ),
    sessionSummaries: z.array(
      z.object({
        session_id: z.string(),
        summary_text: z.string(),
        key_findings: z.array(z.string()),
        created_at: z.string(),
      })
    ),
    dataDictionary: z
      .object({
        filename: z.string(),
        schema_json: z.unknown(),
        data_dictionary_json: z.unknown(),
        deployment_context: z.string().optional(),
      })
      .optional(),
    csvUrl: z.string().optional(),
    endPointId: z.string().optional(),
    rangeStart: z.string().optional(),
    rangeEnd: z.string().optional(),
  }),
  execute: async (context, toolContext) => {
    const { sessionId, csvColumnSignature, beliefTags } = context;
    const supabase = getSupabase();

    // ── 1. Static domain knowledge — in system prompt, not tool results ───────
    const staticKnowledge = "Domain knowledge available in system prompt (radar-sensors, path-classification, retail-context, dr6000-schema, seed-beliefs, output-contract).";

    // The agent may pass "current" as a placeholder when it doesn't yet have
    // the real session UUID. Fall back to the sessionId from the verified
    // request context (set by the edge function or Studio Variables panel).
    const runtimeSessionId = toolContext?.requestContext?.get?.("sessionId") as string | undefined;
    const resolvedSessionId = sessionId === "current" ? (runtimeSessionId ?? sessionId) : sessionId;

    // ── Fetch session record once — org_id scopes all subsequent reads/writes ─
    const { data: sessionRecord } = await supabase
      .from("sessions")
      .select("csv_storage_path, csv_public_url, org_id, end_point_id, range_start, range_end")
      .eq("id", resolvedSessionId)
      .single();

    // Fall back to the org_id from the verified request context when session
    // lookup fails (e.g., agent passes "current" before it has a real UUID).
    const runtimeOrgId = toolContext?.requestContext?.get?.("orgId") as string | undefined;
    const orgId: string | undefined = sessionRecord?.org_id ?? runtimeOrgId;

    // Safety: never return unfiltered cross-org data if org can't be resolved.
    if (!orgId) {
      return {
        staticKnowledge,
        orgId: undefined,
        beliefs: [],
        codeTemplates: [],
        sessionSummaries: [],
        dataDictionary: undefined,
        csvUrl: undefined,
      };
    }

    // ── 2. Approved beliefs (scoped to org) ────────────────────────────────
    let beliefsQuery = supabase
      .from("knowledge_beliefs")
      .select("id, content, type, confidence, tags, created_at")
      .eq("approval_status", "approved")
      .order("confidence", { ascending: false })
      .limit(50);

    if (orgId) beliefsQuery = beliefsQuery.eq("org_id", orgId);
    if (beliefTags && beliefTags.length > 0) {
      beliefsQuery = beliefsQuery.overlaps("tags", beliefTags);
    }

    const { data: beliefs } = await beliefsQuery;

    // ── 3. Code templates (scoped to org) ──────────────────────────────────
    let templatesQuery = supabase
      .from("code_templates")
      .select("name, description, tags, version")
      .eq("approval_status", "approved")
      .order("approved_at", { ascending: false })
      .limit(20);

    if (orgId) templatesQuery = templatesQuery.eq("org_id", orgId);
    const { data: codeTemplates } = await templatesQuery;

    // ── 4. Session summaries (3 most recent, excluding current, scoped to org) ─
    let summariesQuery = supabase
      .from("session_summaries")
      .select("session_id, summary_text, key_findings, created_at")
      .neq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(3);

    if (orgId) summariesQuery = summariesQuery.eq("org_id", orgId);
    const { data: sessionSummaries } = await summariesQuery;

    // ── 5. Data dictionary for current CSV schema ──────────────────────────
    let dataDictionary = undefined;
    let csvUrl: string | undefined = undefined;

    if (sessionRecord?.csv_public_url) {
      csvUrl = sessionRecord.csv_public_url;
    }

    // Look for matching data dictionary by column signature, scoped to org
    if (csvColumnSignature) {
      let datasetQuery = supabase
        .from("datasets")
        .select("filename, schema_json, data_dictionary_json, deployment_context")
        .eq("column_signature", csvColumnSignature)
        .eq("approval_status", "approved")
        .not("data_dictionary_json", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);

      if (orgId) datasetQuery = datasetQuery.eq("org_id", orgId);

      const { data: matchingDataset } = await datasetQuery.single();

      if (matchingDataset) {
        dataDictionary = matchingDataset;
      }
    }

    return {
      staticKnowledge,
      orgId,
      beliefs: beliefs ?? [],
      codeTemplates: codeTemplates ?? [],
      sessionSummaries: sessionSummaries ?? [],
      dataDictionary,
      csvUrl,
      endPointId: sessionRecord?.end_point_id ?? undefined,
      rangeStart: sessionRecord?.range_start ?? undefined,
      rangeEnd: sessionRecord?.range_end ?? undefined,
    };
  },
});
