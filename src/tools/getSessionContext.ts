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
import {
  OUTPUT_CONTRACT,
  DOMAIN_RADAR_SENSORS,
  DOMAIN_PATH_CLASSIFICATION,
  DOMAIN_RETAIL_CONTEXT,
  SEED_BELIEFS,
} from "../embedded-knowledge";

// ─── Supabase client ───────────────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );
}

// ─── Static knowledge loader ───────────────────────────────────────────────────
// Uses embedded constants instead of filesystem reads so this works on
// Mastra Platform where source .md files are not included in the deployment.

function loadStaticKnowledge(): string {
  return [
    ["output-contract.md", OUTPUT_CONTRACT],
    ["radar-sensors.md", DOMAIN_RADAR_SENSORS],
    ["path-classification.md", DOMAIN_PATH_CLASSIFICATION],
    ["retail-context.md", DOMAIN_RETAIL_CONTEXT],
    ["approved-takeaways.md", SEED_BELIEFS],
  ]
    .map(([name, content]) => `### ${name}\n\n${content}`)
    .join("\n\n---\n\n");
}

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
  }),
  execute: async (context) => {
    const { sessionId, csvColumnSignature, beliefTags } = context;
    const supabase = getSupabase();

    // ── 1. Static domain knowledge ─────────────────────────────────────────
    const staticKnowledge = loadStaticKnowledge();

    // ── Fetch session record once — org_id scopes all subsequent reads/writes ─
    const { data: sessionRecord } = await supabase
      .from("sessions")
      .select("csv_storage_path, csv_public_url, org_id")
      .eq("id", sessionId)
      .single();

    const orgId: string | undefined = sessionRecord?.org_id ?? undefined;

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
    };
  },
});
