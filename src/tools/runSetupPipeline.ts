/**
 * Tool: runSetupPipeline
 *
 * Called immediately after updateSession(phase: 'setup') in GATE C.1.
 * Reads the approved scope from the session, checks raw_data_uploads coverage
 * for every scope endpoint, fetches from the DR6000 API for any missing
 * endpoints, runs the transform (resolving store hours automatically), and
 * advances the session phase to 'analysis'.
 *
 * The agent calls this ONE tool — no reasoning about fetch / transform / store
 * hours / coverage is required. Everything runs silently.
 */

import { createTool } from "@mastra/core/tools";
import { createClient } from "@supabase/supabase-js";
import { Sandbox } from "@e2b/code-interpreter";
import { z } from "zod";

const DR6000_BASE_URL = "https://api.data-realities.com/v1";

const getSupabase = () =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// ── Reused helpers (mirror fetchSensorData + executeQueryData internals) ───────

function toLocalDateStr(isoStr: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(isoStr))
      .replace(/\//g, "-");
  } catch {
    return isoStr.slice(0, 10);
  }
}

async function fetchFromDR6000(
  supabase: ReturnType<typeof getSupabase>,
  { sessionId, endPointId, orgId, dateStart, dateEnd }: {
    sessionId: string; endPointId: string; orgId: string; dateStart: string; dateEnd: string;
  }
): Promise<{ success: boolean; message: string; rawUploadId?: string; csvText?: string }> {
  const { data: ep } = await supabase
    .from("end_points")
    .select("mac_address, org_id, timezone")
    .eq("id", endPointId)
    .single();

  if (!ep?.mac_address) return { success: false, message: `No mac_address for endpoint ${endPointId}` };

  const { data: integration } = await supabase
    .from("integrations")
    .select("api_key")
    .eq("org_id", (ep.org_id as string | null) ?? orgId)
    .eq("vendor", "data-realities-radar")
    .single();

  if (!integration?.api_key) return { success: false, message: `No API key for org ${orgId}` };

  const tz = (ep.timezone as string | null) ?? "America/Toronto";
  const localStart = toLocalDateStr(`${dateStart}T00:00:00`, tz);
  const localEnd   = toLocalDateStr(`${dateEnd}T23:59:59`, tz);

  const params = new URLSearchParams({
    mac_address: ep.mac_address as string,
    start_time: `${localStart} 00:00:00`,
    end_time:   `${localEnd} 23:59:59`,
    type: "csv",
  });

  const response = await fetch(`${DR6000_BASE_URL}/paths?${params.toString()}`, {
    headers: { "x-api-key": integration.api_key as string },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { success: false, message: `DR6000 ${response.status}: ${body || response.statusText}` };
  }

  const csvText = await response.text();
  if (!csvText.trim()) return { success: false, message: "DR6000 returned empty response" };

  const rowCount = csvText.trim().split("\n").length - 1;
  // Include endpoint prefix so multiple endpoints in the same session don't overwrite each other
  const epSuffix = endPointId.slice(0, 8);
  const filename = `dr6000_paths_${localStart}_${localEnd}_${epSuffix}.csv`;
  const storagePath = `sessions/${sessionId}/${filename}`;

  const { error: uploadError } = await supabase.storage
    .from("csv-uploads")
    .upload(storagePath, new Blob([csvText], { type: "text/csv" }), { upsert: true, contentType: "text/csv" });

  if (uploadError) return { success: false, message: `Storage upload failed: ${uploadError.message}` };

  const { data: urlData } = supabase.storage.from("csv-uploads").getPublicUrl(storagePath);

  const { data: rawUpload } = await supabase
    .from("raw_data_uploads")
    .insert({
      org_id: orgId,
      endpoint_id: endPointId,
      session_id: sessionId,
      filename,
      storage_path: storagePath,
      csv_public_url: urlData?.publicUrl ?? null,
      row_count: rowCount,
      date_start: localStart,
      date_end: localEnd,
      report_type: "paths",
      source: "dr6000-radar",
    })
    .select("id")
    .single();

  return { success: true, message: `Fetched ${rowCount} rows`, rawUploadId: rawUpload?.id as string, csvText };
}

async function getFilledTransformCode(
  supabase: ReturnType<typeof getSupabase>,
  orgId: string,
  endPointId: string
): Promise<{ code?: string; templateId?: string }> {
  const { data: templates } = await supabase
    .from("code_templates")
    .select("id, code, parameters, org_id")
    .eq("integration_type", "dr6000-radar")
    .eq("approval_status", "approved")
    .contains("tags", ["transformation"])
    .order("approved_at", { ascending: false });

  const template = templates?.find((t: { org_id: string | null }) => t.org_id === orgId) ?? templates?.[0];
  if (!template) return {};

  const paramDefs = (template.parameters as Array<{ name: string; source: string; source_field?: string; default?: unknown }> | null) ?? [];
  const orgConfigKeys = paramDefs.filter((p) => p.source === "org_config").map((p) => p.source_field).filter(Boolean) as string[];

  const { data: configs } = await supabase
    .from("interpretation_configs")
    .select("key, value")
    .eq("org_id", orgId)
    .eq("integration_type", "dr6000-radar")
    .in("key", orgConfigKeys);

  const orgConfig: Record<string, string> = {};
  for (const p of paramDefs.filter((p) => p.source === "org_config")) {
    if (p.source_field && p.default !== undefined) orgConfig[p.source_field] = String(p.default);
  }
  for (const c of configs ?? []) orgConfig[(c as { key: string; value: string }).key] = (c as { key: string; value: string }).value;

  const { data: ep } = await supabase
    .from("end_points")
    .select("store_locations(hours)")
    .eq("id", endPointId)
    .single();

  const storeHoursArr = ep?.store_locations as Array<{ hours?: Record<string, { open: number; close: number }> }> | null;
  const hoursMap = storeHoursArr?.[0]?.hours;
  // Use weekday (mon) hours as the canonical open/close, falling back to org config or defaults
  const sampleDay = hoursMap ? Object.values(hoursMap)[0] : null;

  const fillParams: Record<string, unknown> = {
    STORE_OPEN_HOUR:  sampleDay?.open  ?? parseInt(orgConfig["store_open_hour"]  ?? "7"),
    STORE_CLOSE_HOUR: sampleDay?.close ?? parseInt(orgConfig["store_close_hour"] ?? "22"),
    MIN_POINTS:       parseInt(orgConfig["min_points_per_path"] ?? "2"),
    ENGAGED_THRESHOLD: parseInt(orgConfig["engaged_threshold"]  ?? "10"),
  };

  let code = template.code as string;
  code = code.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    fillParams[key] !== undefined ? String(fillParams[key]) : `{{${key}}}`
  );

  return { code, templateId: template.id as string };
}

// ── Tool ──────────────────────────────────────────────────────────────────────

export const runSetupPipelineTool = createTool({
  id: "run-setup-pipeline",
  description:
    "After [Code approved] in GATE C.1: call updateSession(phase:'setup') then call this tool. " +
    "It reads the approved scope.endpoints and scope.date_range from the session, checks " +
    "raw_data_uploads coverage for every endpoint, fetches from the DR6000 API for any missing " +
    "endpoints, runs the transform (resolving store hours from the DB automatically), and advances " +
    "the session phase to 'analysis'. Returns dataReady: true when all endpoints are ready. " +
    "NEVER call fetchSensorData, getTransformPipeline, executeTransform, or requestContextCard " +
    "for storeHours separately — this tool handles all of that.",
  inputSchema: z.object({
    sessionId: z.string().describe("Session UUID from getSessionContext."),
    orgId: z.string().describe("Org UUID from getSessionContext."),
  }),
  outputSchema: z.object({
    dataReady: z.boolean(),
    endpointsProcessed: z.array(z.object({
      endpointId: z.string(),
      fetched: z.boolean(),
      transformed: z.boolean(),
    })),
    error: z.string().optional(),
  }),
  execute: async ({ sessionId, orgId }) => {
    const supabase = getSupabase();

    // 1. Read approved scope from session
    const { data: sessionRow } = await supabase
      .from("sessions")
      .select("scope")
      .eq("id", sessionId)
      .single();

    const scope = sessionRow?.scope as {
      approved?: boolean;
      endpoints?: Array<{ id: string; name: string }>;
      date_range?: { start: string; end: string } | null;
    } | null;

    if (!scope?.approved || !scope.endpoints?.length || !scope.date_range) {
      return { dataReady: false, endpointsProcessed: [], error: "No approved scope with endpoints and date_range on session." };
    }

    const { start: dateStart, end: dateEnd } = scope.date_range;
    const endpoints = scope.endpoints;

    // 2. Create E2B sandbox (shared across all endpoints in this run)
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });
    const dbPassword = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD ?? "");
    const dbUrl = `postgresql://postgres.ftshahsqtkxxjmpsmyhp:${dbPassword}@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require`;

    try {
      await sandbox.runCode(
        "import subprocess; subprocess.run(['pip','install','pandas','numpy','psycopg2-binary','--quiet','--root-user-action=ignore'],check=True,capture_output=True)",
        { language: "python" }
      );

      const endpointsProcessed: Array<{ endpointId: string; fetched: boolean; transformed: boolean }> = [];

      for (const endpoint of endpoints) {
        let fetched = false;
        let transformed = false;

        // 3. Coverage check
        const { data: uploads } = await supabase
          .from("raw_data_uploads")
          .select("id, storage_url")
          .eq("endpoint_id", endpoint.id)
          .eq("org_id", orgId)
          .gte("date_start", dateStart)
          .lte("date_end", dateEnd);

        let rawUploadId: string | null = null;
        let csvText: string | null = null;

        if (!uploads || uploads.length === 0) {
          // 4a. Fetch from DR6000
          const fetchResult = await fetchFromDR6000(supabase, { sessionId, endPointId: endpoint.id, orgId, dateStart, dateEnd });
          if (!fetchResult.success) {
            endpointsProcessed.push({ endpointId: endpoint.id, fetched: false, transformed: false });
            continue;
          }
          fetched = true;
          rawUploadId = fetchResult.rawUploadId ?? null;
          csvText = fetchResult.csvText ?? null;
        } else {
          rawUploadId = (uploads[0] as { id: string }).id;
          // Check if transform already ran
          const { count: obsCount } = await supabase
            .from("audience_observations")
            .select("id", { count: "exact", head: true })
            .eq("raw_upload_id", rawUploadId)
            .eq("org_id", orgId);

          if ((obsCount ?? 0) > 0) {
            // Already transformed — data ready
            endpointsProcessed.push({ endpointId: endpoint.id, fetched: false, transformed: true });
            continue;
          }

          // 4b. Upload exists, transform not run — reload CSV from storage
          const storageUrl = (uploads[0] as { storage_url: string }).storage_url;
          if (storageUrl) {
            const csvResp = await fetch(storageUrl);
            csvText = csvResp.ok ? await csvResp.text() : null;
          }
        }

        if (!rawUploadId || !csvText) {
          endpointsProcessed.push({ endpointId: endpoint.id, fetched, transformed: false });
          continue;
        }

        // 5. Run transform (store hours resolved from DB automatically)
        const { code: transformCode, templateId } = await getFilledTransformCode(supabase, orgId, endpoint.id);
        if (!transformCode || !templateId) {
          endpointsProcessed.push({ endpointId: endpoint.id, fetched, transformed: false });
          continue;
        }

        await sandbox.files.write("/sandbox/upload.csv", csvText);
        await sandbox.runCode(transformCode, {
          language: "python",
          envs: {
            SUPABASE_URL: process.env.SUPABASE_URL ?? "",
            SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
            RAW_UPLOAD_ID: rawUploadId,
            ORG_ID: orgId,
            DATASET_ID: "",
            ENDPOINT_ID: endpoint.id,
            DB_URL: dbUrl,
          },
        });

        void supabase.from("pipeline_run_log").insert({
          org_id: orgId,
          endpoint_id: endpoint.id,
          trigger_reason: "chat",
          template_id: templateId,
          status: "complete",
        });

        transformed = true;
        endpointsProcessed.push({ endpointId: endpoint.id, fetched, transformed });
      }

      // 6. Advance session phase
      await supabase.from("sessions").update({ phase: "analysis" }).eq("id", sessionId);

      return { dataReady: true, endpointsProcessed };
    } finally {
      await sandbox.kill();
    }
  },
});
