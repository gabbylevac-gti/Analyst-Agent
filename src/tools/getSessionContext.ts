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

function toLocalDateStr(isoTs: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTs));
}

function eachDayInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  // Work in UTC-anchored midnight so date arithmetic is unambiguous.
  // Both start and end are already YYYY-MM-DD local-date strings at this point.
  const current = new Date(start + "T00:00:00Z");
  const endDate = new Date(end + "T00:00:00Z");
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
    scope: z.object({
      regions: z.array(z.string()),
      locations: z.array(z.object({ id: z.string(), name: z.string() })),
      endpoints: z.array(z.object({ id: z.string(), name: z.string() })),
      data_sources: z.array(z.string()),
      date_range: z.object({ start: z.string(), end: z.string() }).nullable(),
      approved: z.boolean(),
      approved_at: z.string().nullable(),
    }).nullable(),
    scopeApproved: z.boolean(),
    endpointCoverage: z.array(z.object({
      endpointId: z.string(),
      endpointName: z.string(),
      locationName: z.string(),
      cleanDataSummary: z.object({
        coveredDays: z.number(),
        totalDays: z.number(),
        coveragePercent: z.number(),
        missingRanges: z.array(z.object({ start: z.string(), end: z.string() })),
      }),
    })).nullable(),
    availableEndpoints: z.array(z.object({
      id: z.string(),
      name: z.string(),
      locationName: z.string().nullable(),
      region: z.string().nullable(),
      category: z.string().nullable(),
    })).nullable(),
    availableLocations: z.array(z.object({
      id: z.string(),
      name: z.string(),
      region: z.string().nullable(),
    })).nullable(),
    availableRegions: z.array(z.string()).nullable(),
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
      .select("csv_storage_path, csv_public_url, org_id, user_id, end_point_id, range_start, range_end, phase, objective, active_dataset_id, raw_upload_id, technical_engagement, scope")
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
        scope: null,
        scopeApproved: false,
        endpointCoverage: null,
        availableEndpoints: null,
        availableLocations: null,
        availableRegions: null,
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
    let endpointTimezone = "America/Toronto";

    const endPointId: string | undefined = sessionRecord?.end_point_id ?? undefined;

    // For M4-2 sessions, end_point_id is never set on the session record — the scope
    // approval flow writes the endpoint into sessions.scope, not sessions.end_point_id.
    // Fall back to scope.endpoints[0].id when scope is approved so store hours and
    // other endpoint metadata are available for Phase 1 (setup) without an extra round-trip.
    const earlyScope = sessionRecord?.scope as {
      approved?: boolean;
      endpoints?: Array<{ id: string; name: string }>;
    } | null | undefined;
    const resolvedEndpointId = endPointId ?? (
      earlyScope?.approved === true && (earlyScope.endpoints?.length ?? 0) > 0
        ? earlyScope.endpoints![0].id
        : undefined
    );

    if (resolvedEndpointId) {
      const { data: epData } = await supabase
        .from("end_points")
        .select("category, known_interference, timezone, store_locations(hours)")
        .eq("id", resolvedEndpointId)
        .single();

      if (epData) {
        endpointCategory = epData.category ?? null;
        endpointKnownInterference = epData.known_interference ?? null;
        endpointTimezone = (epData.timezone as string | null) ?? "America/Toronto";
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

    // Include both org-specific and global (org_id IS NULL) templates.
    if (orgId) templatesQuery = templatesQuery.or(`org_id.eq.${orgId},org_id.is.null`);
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

    // For M4-2 scope sessions, end_point_id / range_* are never set on the session record.
    // Fall back to scope.endpoints[0] + scope.date_range so cleanDataSummary reflects
    // whether the pipeline has run for the approved scope — enables skipping Phase 1 on
    // returning sessions where data is already in raw_data_uploads.
    const scopeForCoverage = sessionRecord?.scope as {
      approved?: boolean;
      endpoints?: Array<{ id: string }>;
      date_range?: { start: string; end: string } | null;
    } | null | undefined;
    const effectiveEndPointId = sessionEndPointId ?? (
      scopeForCoverage?.approved === true && (scopeForCoverage.endpoints?.length ?? 0) > 0
        ? scopeForCoverage.endpoints![0].id
        : null
    );
    const effectiveRangeStart = sessionRangeStart ?? (scopeForCoverage?.date_range?.start ?? null);
    const effectiveRangeEnd   = sessionRangeEnd   ?? (scopeForCoverage?.date_range?.end   ?? null);

    if (effectiveEndPointId && effectiveRangeStart && effectiveRangeEnd) {
      // API session: coverage = did a successful raw_upload run for each day in the range?
      // A day is "covered" if a raw_data_upload exists for this endpoint whose date_start <= day <= date_end.
      // This is intentionally different from checking audience_day_agg rows per day — zero-path days
      // (store closed, sensor offline) produce no agg row but the pipeline DID run for them.
      // Checking agg rows would incorrectly show those days as gaps.
      const rangeStartDate = toLocalDateStr(effectiveRangeStart, endpointTimezone);
      const rangeEndDate   = toLocalDateStr(effectiveRangeEnd, endpointTimezone);

      const { data: uploads } = await supabase
        .from("raw_data_uploads")
        .select("date_start, date_end")
        .eq("endpoint_id", effectiveEndPointId)
        .eq("org_id", orgId)
        .not("date_start", "is", null)
        .not("date_end", "is", null);

      const expectedDates = eachDayInRange(rangeStartDate, rangeEndDate);
      const coveredSet = new Set<string>();
      for (const d of expectedDates) {
        for (const u of uploads ?? []) {
          if ((u.date_start as string) <= d && (u.date_end as string) >= d) {
            coveredSet.add(d);
            break;
          }
        }
      }

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

    // ── 6. Session scope — read the approved access policy ────────────────────
    type ScopeLocation = { id: string; name: string };
    type ScopeEndpoint = { id: string; name: string };
    type SessionScope = {
      regions: string[];
      locations: ScopeLocation[];
      endpoints: ScopeEndpoint[];
      data_sources: string[];
      date_range: { start: string; end: string } | null;
      approved: boolean;
      approved_at: string | null;
    };

    const rawScope = sessionRecord?.scope as SessionScope | null | undefined;
    const sessionScope: SessionScope | null = rawScope ?? null;
    const scopeApproved = sessionScope?.approved === true;

    // Per-endpoint coverage — computed for each endpoint in the approved scope.
    // Uses the same raw_data_uploads coverage logic as the single-endpoint path.
    type EndpointCoverageEntry = {
      endpointId: string;
      endpointName: string;
      locationName: string;
      cleanDataSummary: {
        coveredDays: number;
        totalDays: number;
        coveragePercent: number;
        missingRanges: Array<{ start: string; end: string }>;
      };
    };

    let endpointCoverage: EndpointCoverageEntry[] | null = null;

    if (scopeApproved && sessionScope && sessionScope.endpoints.length > 0 && sessionScope.date_range) {
      const { start: scopeStart, end: scopeEnd } = sessionScope.date_range;
      const coverageResults: EndpointCoverageEntry[] = [];

      for (const ep of sessionScope.endpoints) {
        const { data: uploads } = await supabase
          .from("raw_data_uploads")
          .select("date_start, date_end")
          .eq("endpoint_id", ep.id)
          .eq("org_id", orgId)
          .not("date_start", "is", null)
          .not("date_end", "is", null);

        const expectedDates = eachDayInRange(scopeStart, scopeEnd);
        const coveredSet = new Set<string>();
        for (const d of expectedDates) {
          for (const u of uploads ?? []) {
            if ((u.date_start as string) <= d && (u.date_end as string) >= d) {
              coveredSet.add(d);
              break;
            }
          }
        }

        const missingDates = expectedDates.filter((d) => !coveredSet.has(d));

        // Find the location name for this endpoint from the scope
        const matchingLoc = sessionScope.locations.find((l) =>
          sessionScope.endpoints.some((e) => e.id === ep.id)
        );

        coverageResults.push({
          endpointId: ep.id,
          endpointName: ep.name,
          locationName: matchingLoc?.name ?? "",
          cleanDataSummary: {
            coveredDays: coveredSet.size,
            totalDays: expectedDates.length,
            coveragePercent: expectedDates.length === 0 ? 0 : Math.round((coveredSet.size / expectedDates.length) * 100),
            missingRanges: contiguousRanges(missingDates),
          },
        });
      }

      endpointCoverage = coverageResults;
    }

    // ── 7. Available endpoints + locations (for scope proposal when scope is null) ──
    let availableEndpoints: Array<{ id: string; name: string; locationName: string | null; region: string | null; category: string | null }> | null = null;
    let availableLocations: Array<{ id: string; name: string; region: string | null }> | null = null;
    let availableRegions: string[] | null = null;

    if (orgId) {
      const { data: orgEndpoints } = await supabase
        .from("end_points")
        .select("id, end_point, category, store_locations(id, store_name, region)")
        .eq("org_id", orgId)
        .eq("dr_radar", true)
        .order("end_point");

      availableEndpoints = (orgEndpoints ?? []).map((ep) => {
        const loc = (ep.store_locations as unknown as { store_name: string; region: string | null } | null);
        return {
          id: ep.id as string,
          name: ep.end_point as string,
          locationName: loc?.store_name ?? null,
          region: loc?.region ?? null,
          category: (ep.category as string | null) ?? null,
        };
      });

      const { data: orgLocations } = await supabase
        .from("store_locations")
        .select("id, store_name, region")
        .eq("org_id", orgId)
        .order("store_name");

      availableLocations = (orgLocations ?? []).map((l) => ({
        id: l.id as string,
        name: l.store_name as string,
        region: (l.region as string | null) ?? null,
      }));

      availableRegions = [...new Set(
        (orgLocations ?? []).map((l) => l.region as string | null).filter((r): r is string => !!r)
      )];
    }

    // ── 8. Data dictionary — prefer session's active_dataset_id, fall back to column signature ──
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
      } else {
        // Dataset was deleted — clear the stale ID so it isn't passed to executeTransform
        // and causes a FK constraint violation.
        activeDatasetId = undefined;
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
      scope: sessionScope,
      scopeApproved,
      endpointCoverage,
      availableEndpoints,
      availableLocations,
      availableRegions,
    };
  },
});
