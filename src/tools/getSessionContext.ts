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
import { readFileSync } from "fs";
import { join } from "path";
// Domain knowledge constants moved to analystAgent.ts system prompt.

// ─── Date range helpers ────────────────────────────────────────────────────────

function eachDayInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  const endDate = new Date(end);
  current.setUTCHours(0, 0, 0, 0);
  endDate.setUTCHours(0, 0, 0, 0);
  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function contiguousRanges(sortedDates: string[]): Array<{ start: string; end: string }> {
  if (sortedDates.length === 0) return [];
  const ranges: Array<{ start: string; end: string }> = [];
  let rangeStart = sortedDates[0];
  let prev = sortedDates[0];
  for (let i = 1; i < sortedDates.length; i++) {
    const curr = sortedDates[i];
    const diffDays =
      (new Date(curr + "T00:00:00Z").getTime() - new Date(prev + "T00:00:00Z").getTime()) /
      86400000;
    if (diffDays > 1) {
      ranges.push({ start: rangeStart, end: prev });
      rangeStart = curr;
    }
    prev = curr;
  }
  ranges.push({ start: rangeStart, end: prev });
  return ranges;
}

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
    phase: z.enum(["objective", "setup", "analysis", "wrap_up"]).optional(),
    objective: z.string().optional(),
    activeDatasetId: z.string().optional(),
    datasetApprovalStatus: z.enum(["none", "pending", "approved"]).optional(),
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
    rawUploadId: z.string().optional(),
    endPointId: z.string().optional(),
    rangeStart: z.string().optional(),
    rangeEnd: z.string().optional(),
    storeHours: z.record(z.object({ open: z.number(), close: z.number() })).nullable(),
    storeLocationLinked: z.boolean(),
    endpointCategory: z.string().nullable(),
    endpointKnownInterference: z.string().nullable(),
    technicalEngagement: z.enum(["delegate", "collaborate", "direct"]).nullable(),
    cleanDataSummary: z.object({
      available: z.boolean(),
      coveragePercent: z.number(),
      coveredDates: z.array(z.string()),
      missingRanges: z.array(z.object({ start: z.string(), end: z.string() })),
    }),
  }),
  execute: async (context, toolContext) => {
    const { sessionId, csvColumnSignature, beliefTags } = context;
    const supabase = getSupabase();

    // ── 1. Static domain knowledge — in system prompt, not tool results ───────
    let stakeholderKnowledge = "";
    try {
      const knowledgePath = join(process.cwd(), "knowledge/stakeholders/knowledge.md");
      stakeholderKnowledge = readFileSync(knowledgePath, "utf-8");
    } catch {
      // File not found or unreadable — proceed without stakeholder context
    }

    const staticKnowledge = stakeholderKnowledge
      ? `Domain knowledge available in system prompt (radar-sensors, path-classification, retail-context, dr6000-schema, seed-beliefs, output-contract).\n\n## Stakeholder Preferences\n\n${stakeholderKnowledge}`
      : "Domain knowledge available in system prompt (radar-sensors, path-classification, retail-context, dr6000-schema, seed-beliefs, output-contract).";

    // The agent may pass "current" as a placeholder when it doesn't yet have
    // the real session UUID. Fall back to the sessionId from the verified
    // request context (set by the edge function or Studio Variables panel).
    const runtimeSessionId = toolContext?.requestContext?.get?.("sessionId") as string | undefined;
    const resolvedSessionId = sessionId === "current" ? (runtimeSessionId ?? sessionId) : sessionId;

    // ── Fetch session record once — org_id scopes all subsequent reads/writes ─
    const { data: sessionRecord } = await supabase
      .from("sessions")
      .select("csv_storage_path, csv_public_url, org_id, user_id, end_point_id, range_start, range_end, phase, objective, active_dataset_id, raw_upload_id, technical_engagement")
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
        storeHours: null,
        storeLocationLinked: false,
        endpointCategory: null,
        endpointKnownInterference: null,
        technicalEngagement: null,
        cleanDataSummary: { available: false, coveragePercent: 0, coveredDates: [], missingRanges: [] },
      };
    }

    // ── 1b. Technical engagement mode ────────────────────────────────────────
    // Prefer the per-message override from runtimeContext (set by the frontend
    // dropdown). Fall back to the user's profile default.
    let technicalEngagement: "delegate" | "collaborate" | "direct" | null = null;
    const runtimeTE = toolContext?.requestContext?.get?.("technicalEngagement") as string | undefined;
    if (runtimeTE === "delegate" || runtimeTE === "collaborate" || runtimeTE === "direct") {
      technicalEngagement = runtimeTE;
    } else {
      // Session-level override takes priority over profile default (persisted when user changes
      // mode mid-session so it survives page reload).
      const sessionTE = sessionRecord?.technical_engagement as string | null | undefined;
      if (sessionTE === "delegate" || sessionTE === "collaborate" || sessionTE === "direct") {
        technicalEngagement = sessionTE;
      } else {
        const userId = (sessionRecord?.user_id as string | null | undefined) ?? (toolContext?.requestContext?.get?.("userId") as string | undefined);
        if (userId) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("technical_engagement")
            .eq("id", userId)
            .maybeSingle();
          const raw = profile?.technical_engagement as string | null | undefined;
          if (raw === "delegate" || raw === "collaborate" || raw === "direct") {
            technicalEngagement = raw;
          }
        }
      }
    }

    // ── 1c. Endpoint retail context (store hours, category, known interference) ─
    // Always returned as null (not omitted) so the agent sees them explicitly
    // and knows to seek the missing info rather than silently skipping.
    let storeHours: Record<string, { open: number; close: number }> | null = null;
    let storeLocationLinked = false;
    let endpointCategory: string | null = null;
    let endpointKnownInterference: string | null = null;

    const endPointId: string | undefined = sessionRecord?.end_point_id ?? undefined;
    if (endPointId) {
      const { data: epData } = await supabase
        .from("end_points")
        .select("category, known_interference, store_locations(hours)")
        .eq("id", endPointId)
        .single();

      if (epData) {
        endpointCategory = epData.category ?? null;
        endpointKnownInterference = epData.known_interference ?? null;
        const loc = (epData.store_locations as unknown as { hours: Record<string, { open: number; close: number }> | null } | null);
        storeLocationLinked = !!loc;
        if (loc?.hours && Object.keys(loc.hours).length > 0) {
          storeHours = loc.hours;
        }
      }
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

    // ── 5. Clean data coverage — endpoint+range aware query via audience_day_agg ──
    // For API sessions (endpoint + date range): join audience_day_agg with
    // raw_data_uploads on endpoint_id to find which dates are in the clean layer.
    // For CSV sessions (no endpoint): fall back to binary check on raw_upload_id.
    let cleanDataSummary: {
      available: boolean;
      coveragePercent: number;
      coveredDates: string[];
      missingRanges: Array<{ start: string; end: string }>;
    };

    const sessionEndPointId = sessionRecord?.end_point_id as string | null | undefined;
    const sessionRangeStart = sessionRecord?.range_start as string | null | undefined;
    const sessionRangeEnd = sessionRecord?.range_end as string | null | undefined;

    if (sessionEndPointId && sessionRangeStart && sessionRangeEnd) {
      // API session: query covered dates via audience_day_agg joined on endpoint_id
      const rangeStartDate = sessionRangeStart.split("T")[0];
      const rangeEndDate = sessionRangeEnd.split("T")[0];

      const { data: coveredRows } = await supabase
        .from("audience_day_agg")
        .select("date, raw_data_uploads!inner(endpoint_id)")
        .eq("raw_data_uploads.endpoint_id", sessionEndPointId)
        .eq("org_id", orgId)
        .gte("date", rangeStartDate)
        .lte("date", rangeEndDate);

      const coveredSet = new Set<string>((coveredRows ?? []).map((r) => r.date as string));
      const expectedDates = eachDayInRange(rangeStartDate, rangeEndDate);
      const missingDates = expectedDates.filter((d) => !coveredSet.has(d));
      const missingRanges = contiguousRanges(missingDates);

      cleanDataSummary = {
        available: missingDates.length === 0,
        coveragePercent:
          expectedDates.length === 0
            ? 0
            : Math.round((coveredSet.size / expectedDates.length) * 100),
        coveredDates: [...coveredSet].sort(),
        missingRanges,
      };
    } else {
      // CSV session: binary check — any audience_observations for this upload?
      const rawUploadIdForCheck = sessionRecord?.raw_upload_id as string | null | undefined;
      if (rawUploadIdForCheck) {
        const { count } = await supabase
          .from("audience_observations")
          .select("id", { count: "exact", head: true })
          .eq("raw_upload_id", rawUploadIdForCheck);
        const hasData = (count ?? 0) > 0;
        cleanDataSummary = {
          available: hasData,
          coveragePercent: hasData ? 100 : 0,
          coveredDates: [],
          missingRanges: [],
        };
      } else {
        cleanDataSummary = { available: false, coveragePercent: 0, coveredDates: [], missingRanges: [] };
      }
    }

    // ── 6. Data dictionary — prefer session's active_dataset_id, fall back to column signature ──
    let dataDictionary = undefined;
    let datasetApprovalStatus: "none" | "pending" | "approved" = "none";
    let activeDatasetId: string | undefined = sessionRecord?.active_dataset_id ?? undefined;
    let csvUrl: string | undefined = undefined;

    if (sessionRecord?.csv_public_url) {
      csvUrl = sessionRecord.csv_public_url;
    }

    // Primary lookup: use active_dataset_id if the session already has one linked.
    // This works across sessions without needing the column signature.
    if (activeDatasetId) {
      const { data: linkedDataset } = await supabase
        .from("datasets")
        .select("id, filename, schema_json, data_dictionary_json, deployment_context, approval_status")
        .eq("id", activeDatasetId)
        .maybeSingle();

      if (linkedDataset) {
        datasetApprovalStatus = (linkedDataset.approval_status as "none" | "pending" | "approved") ?? "none";
        if (linkedDataset.approval_status === "approved" && linkedDataset.data_dictionary_json) {
          dataDictionary = linkedDataset;
        }
      }
    }

    // Fallback: match by column signature if no active dataset is linked yet.
    // Used during the first session with a new CSV, before updateSession is called.
    if (!dataDictionary && csvColumnSignature) {
      let datasetQuery = supabase
        .from("datasets")
        .select("filename, schema_json, data_dictionary_json, deployment_context, approval_status")
        .eq("column_signature", csvColumnSignature)
        .not("data_dictionary_json", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);

      if (orgId) datasetQuery = datasetQuery.eq("org_id", orgId);

      const { data: matchingDataset } = await datasetQuery.maybeSingle();

      if (matchingDataset) {
        datasetApprovalStatus = (matchingDataset.approval_status as "none" | "pending" | "approved") ?? "none";
        if (matchingDataset.approval_status === "approved") {
          dataDictionary = matchingDataset;
        }
      }
    }

    return {
      staticKnowledge,
      orgId,
      phase: (sessionRecord?.phase as "objective" | "setup" | "analysis" | "wrap_up") ?? "setup",
      objective: sessionRecord?.objective ?? undefined,
      activeDatasetId,
      datasetApprovalStatus,
      beliefs: beliefs ?? [],
      codeTemplates: codeTemplates ?? [],
      sessionSummaries: sessionSummaries ?? [],
      dataDictionary,
      csvUrl,
      rawUploadId: sessionRecord?.raw_upload_id ?? undefined,
      endPointId,
      rangeStart: sessionRecord?.range_start ?? undefined,
      rangeEnd: sessionRecord?.range_end ?? undefined,
      storeHours,
      storeLocationLinked,
      endpointCategory,
      endpointKnownInterference,
      technicalEngagement,
      cleanDataSummary,
    };
  },
});
