/**
 * Tool: executeQueryData
 *
 * Runs exploration code against the clean audience tables to give the agent
 * real statistics BEFORE it writes the belief statement and calls executeChart.
 *
 * When autoFetch is true and the analysis returns 0 rows, the tool
 * automatically: checks raw_data_uploads coverage → fetches from DR6000 API
 * if needed → runs the transform → re-runs the analysis. This makes the
 * pipeline invisible to the user when data hasn't been fetched yet.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";
import { createClient } from "@supabase/supabase-js";

const DR6000_BASE_URL = "https://app.datarealities.com/api/sensor-logs";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );
}

function toLocalDateStr(isoTs: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTs));
}

// ── Inline fetch from DR6000 API (mirrors fetchSensorData logic) ──────────────
async function fetchFromDR6000(
  supabase: ReturnType<typeof getSupabase>,
  {
    sessionId,
    endPointId,
    orgId,
    startTime,
    endTime,
  }: { sessionId: string; endPointId: string; orgId: string; startTime: string; endTime: string }
): Promise<{ success: boolean; message: string; rawUploadId?: string; csvUrl?: string; csvText?: string }> {
  const { data: endPoint } = await supabase
    .from("end_points")
    .select("mac_address, org_id, timezone")
    .eq("id", endPointId)
    .single();

  if (!endPoint?.mac_address) {
    return { success: false, message: `No mac_address for endpoint ${endPointId}` };
  }

  const { data: integration } = await supabase
    .from("integrations")
    .select("api_key")
    .eq("org_id", (endPoint.org_id as string | null) ?? orgId)
    .eq("vendor", "data-realities-radar")
    .single();

  if (!integration?.api_key) {
    return { success: false, message: `No API key configured for org ${orgId}` };
  }

  const tz = (endPoint.timezone as string | null) ?? "America/Toronto";
  const dateStart = toLocalDateStr(startTime, tz);
  const dateEnd = toLocalDateStr(endTime, tz);

  const params = new URLSearchParams({
    mac_address: endPoint.mac_address as string,
    start_time: `${dateStart} 00:00:00`,
    end_time: `${dateEnd} 23:59:59`,
    type: "csv",
  });

  const response = await fetch(`${DR6000_BASE_URL}/paths?${params.toString()}`, {
    headers: { "x-api-key": integration.api_key as string },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { success: false, message: `DR6000 API ${response.status}: ${body || response.statusText}` };
  }

  const csvText = await response.text();
  if (!csvText.trim()) {
    return { success: false, message: "DR6000 API returned empty response" };
  }

  const rowCount = csvText.trim().split("\n").length - 1;
  const filename = `dr6000_paths_${dateStart}_${dateEnd}.csv`;
  const storagePath = `sessions/${sessionId}/${filename}`;

  const { error: uploadError } = await supabase.storage
    .from("csv-uploads")
    .upload(storagePath, new Blob([csvText], { type: "text/csv" }), {
      upsert: true,
      contentType: "text/csv",
    });

  if (uploadError) {
    return { success: false, message: `Storage upload failed: ${uploadError.message}` };
  }

  const { data: urlData } = supabase.storage.from("csv-uploads").getPublicUrl(storagePath);
  const csvUrl = urlData.publicUrl;

  const { data: rawUpload } = await supabase
    .from("raw_data_uploads")
    .insert({
      org_id: (endPoint.org_id as string | null) ?? orgId,
      source_type: "api_fetch",
      filename,
      storage_path: storagePath,
      storage_url: csvUrl,
      row_count: rowCount,
      session_id: sessionId,
      integration_type: "dr6000-radar",
      endpoint_id: endPointId,
      range_start: startTime,
      range_end: endTime,
      date_start: dateStart,
      date_end: dateEnd,
    })
    .select("id")
    .single();

  if (!rawUpload) {
    return { success: false, message: "Failed to write raw_data_uploads record" };
  }

  // Update session (non-blocking)
  void supabase
    .from("sessions")
    .update({ csv_public_url: csvUrl, csv_storage_path: storagePath, raw_upload_id: rawUpload.id as string })
    .eq("id", sessionId);

  return {
    success: true,
    message: `Fetched ${rowCount} rows for ${dateStart} to ${dateEnd}`,
    rawUploadId: rawUpload.id as string,
    csvUrl,
    csvText,
  };
}

// ── Build filled transform template code ──────────────────────────────────────
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

  // Resolve org_config params from interpretation_configs
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

  // Resolve deployment_context params (store hours) from end_points → store_locations
  const { data: ep } = await supabase
    .from("end_points")
    .select("store_locations(hours)")
    .eq("id", endPointId)
    .single();

  const storeHoursArr = ep?.store_locations as Array<{ hours?: { open?: number; close?: number } }> | null;
  const hours = storeHoursArr?.[0]?.hours;

  const fillParams: Record<string, unknown> = {
    STORE_OPEN_HOUR: hours?.open ?? parseInt(orgConfig["store_open_hour"] ?? "7"),
    STORE_CLOSE_HOUR: hours?.close ?? parseInt(orgConfig["store_close_hour"] ?? "22"),
    MIN_POINTS: parseInt(orgConfig["min_points_per_path"] ?? "2"),
    ENGAGED_THRESHOLD: parseInt(orgConfig["engaged_threshold"] ?? "10"),
  };

  let code = template.code as string;
  code = code.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    fillParams[key] !== undefined ? String(fillParams[key]) : `{{${key}}}`
  );

  return { code, templateId: template.id as string };
}

// ── Main tool ─────────────────────────────────────────────────────────────────

export const executeQueryDataTool = createTool({
  id: "execute-query-data",
  description:
    "Explore the clean audience tables to compute statistics for formulating a Take-Away. " +
    "Returns data to the agent but renders NO chart or table in the chat — only a collapsed tool indicator. " +
    "ALWAYS call this before writing the belief statement so your answer contains real numbers. " +
    "In Delegate mode, call this directly. In Collaborate mode, call proposeQueryData first and wait for approval. " +
    "Injects ENDPOINT_ID and ORG_ID env vars — scope all queries by endpoint_id when set, org_id otherwise. " +
    "When autoFetch is true and the analysis returns 0 rows, the tool automatically fetches data from the " +
    "DR6000 API, runs the transform, and re-runs the analysis — all silently. " +
    "Pass autoFetch: true, sessionId, and dateRange in all Phase 3 analysis calls. " +
    "Do NOT use this for producing charts — use executeChart for rendering.",
  inputSchema: z.object({
    endPointId: z.string().optional().describe(
      "end_points.id — injected as ENDPOINT_ID. When set, the code must scope by endpoint_id + org_id."
    ),
    orgId: z.string().describe("Organization ID — injected as ORG_ID"),
    code: z.string().describe(
      "Python exploration code. Connect via psycopg2 (DB_URL), scope by ENDPOINT_ID + ORG_ID, " +
      "query audience_observations/audience_15min_agg/audience_day_agg, and print a JSON object as the final stdout line. " +
      "Include a 'summary' key and a 'rows' key (array) so the tool can detect empty results."
    ),
    sessionId: z.string().optional().describe(
      "Current session ID — required when autoFetch is true. Used to store the fetched CSV."
    ),
    dateRange: z
      .object({ start: z.string(), end: z.string() })
      .optional()
      .describe(
        "Date range of the analysis in YYYY-MM-DD format — required when autoFetch is true. " +
        "Used to check raw_data_uploads coverage and fetch missing data."
      ),
    autoFetch: z
      .boolean()
      .optional()
      .describe(
        "When true and the analysis query returns 0 rows, automatically checks raw_data_uploads coverage, " +
        "fetches from the DR6000 API if needed, runs the transform, and re-runs the analysis. " +
        "Always pass true for Phase 3 analysis calls. Do NOT pass true for coverage check code (Phase 1)."
      ),
  }),
  outputSchema: z.object({
    data: z.record(z.unknown()),
    summary: z.string(),
    stdout: z.string(),
    error: z.string().optional(),
    autoFetchCompleted: z.boolean().optional().describe(
      "True when the data pipeline (fetch + transform) was run automatically because the analysis returned 0 rows. " +
      "When this is true, proceed directly to executeChart — do NOT call requestContextCard, fetchSensorData, " +
      "getTransformPipeline, or proposeQueryData again."
    ),
  }),
  execute: async (context) => {
    const { endPointId, orgId, code, sessionId, dateRange, autoFetch } = context;
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });

    try {
      await sandbox.runCode(
        "import subprocess; subprocess.run(['pip', 'install', 'pandas', 'numpy', 'psycopg2-binary', '--quiet', '--root-user-action=ignore'], check=True, capture_output=True)",
        { language: "python" }
      );

      const dbPassword = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD ?? "");
      const dbUrl = `postgresql://postgres.ftshahsqtkxxjmpsmyhp:${dbPassword}@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require`;

      const envs = {
        DB_URL: dbUrl,
        ENDPOINT_ID: endPointId ?? "",
        ORG_ID: orgId,
      };

      const runAndParse = async (execCode: string) => {
        const exec = await sandbox.runCode(execCode, { language: "python", envs });
        const stdout = exec.logs.stdout.join("\n");
        const lines = stdout.trim().split("\n").filter(Boolean);
        const lastLine = lines[lines.length - 1];

        if (!lastLine) {
          const errMsg = exec.error
            ? `${exec.error.name}: ${exec.error.value}`
            : "Script produced no output";
          return { data: {} as Record<string, unknown>, summary: `Exploration failed: ${errMsg}`, stdout, error: errMsg };
        }

        let data: Record<string, unknown> = {};
        let summary = "";
        try {
          const parsed = JSON.parse(lastLine);
          if (typeof parsed === "object" && parsed !== null) {
            data = parsed as Record<string, unknown>;
            summary = typeof parsed.summary === "string" ? parsed.summary : JSON.stringify(parsed).slice(0, 300);
          } else {
            data = { value: parsed };
            summary = String(parsed).slice(0, 300);
          }
        } catch {
          data = { raw: lastLine };
          summary = lastLine.slice(0, 300);
        }
        return { data, summary, stdout };
      };

      // ── 1. Run analysis code ───────────────────────────────────────────────
      // Auto-fix missing ::uuid[] cast on endpoint_id array filters.
      // psycopg2 passes Python lists as text[], but endpoint_id is uuid — cast is required.
      const fixedCode = code.replace(
        /=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]+)\]\s*\)(?!::uuid)/gi,
        "= ANY(ARRAY[$1]::uuid[])"
      );
      let result = await runAndParse(fixedCode);

      // ── 2. Auto-fetch pipeline when analysis returns 0 rows ───────────────
      const shouldAutoFetch =
        autoFetch &&
        endPointId &&
        sessionId &&
        dateRange &&
        !result.error &&
        Array.isArray(result.data.rows) &&
        (result.data.rows as unknown[]).length === 0;

      if (shouldAutoFetch) {
        const supabase = getSupabase();

        // Check if uploads already exist for this endpoint + date range
        const { data: uploads } = await supabase
          .from("raw_data_uploads")
          .select("id, storage_url")
          .eq("endpoint_id", endPointId!)
          .eq("org_id", orgId)
          .gte("date_start", dateRange!.start)
          .lte("date_end", dateRange!.end);

        let rawUploadId: string | null = null;
        let csvText: string | null = null;

        if (!uploads || uploads.length === 0) {
          // No uploads — fetch from DR6000 API
          const fetchResult = await fetchFromDR6000(supabase, {
            sessionId: sessionId!,
            endPointId: endPointId!,
            orgId,
            startTime: `${dateRange!.start}T00:00:00`,
            endTime: `${dateRange!.end}T23:59:59`,
          });

          if (!fetchResult.success) {
            return { ...result, error: `Auto-fetch failed: ${fetchResult.message}` };
          }

          rawUploadId = fetchResult.rawUploadId ?? null;
          csvText = fetchResult.csvText ?? null;
        } else {
          rawUploadId = (uploads[0] as { id: string }).id;

          // Check if transform already ran for this upload
          const { count: obsCount } = await supabase
            .from("audience_observations")
            .select("id", { count: "exact", head: true })
            .eq("raw_upload_id", rawUploadId)
            .eq("org_id", orgId);

          if ((obsCount ?? 0) > 0) {
            // Transform ran but analysis still returned 0 — date range mismatch or filter issue
            result.data = { ...result.data, autoFetchCompleted: true };
            return { ...result, autoFetchCompleted: true };
          }

          // Upload exists but transform didn't run — fetch CSV from storage for transform
          const storageUrl = (uploads[0] as { storage_url: string }).storage_url;
          if (storageUrl) {
            const csvResp = await fetch(storageUrl);
            csvText = csvResp.ok ? await csvResp.text() : null;
          }
        }

        if (!rawUploadId) {
          return { ...result, error: "Auto-fetch: could not obtain rawUploadId" };
        }

        // Get filled transform template code (resolves store hours from DB automatically)
        const { code: transformCode, templateId } = await getFilledTransformCode(
          supabase,
          orgId,
          endPointId!
        );

        if (!transformCode || !templateId) {
          return { ...result, error: "Auto-fetch: no approved transform template found for dr6000-radar" };
        }

        // Upload CSV to sandbox
        if (csvText) {
          await sandbox.files.write("/sandbox/upload.csv", csvText);
        } else {
          return { ...result, error: "Auto-fetch: could not load CSV data for transform" };
        }

        // Run transform in sandbox
        await sandbox.runCode(transformCode, {
          language: "python",
          envs: {
            SUPABASE_URL: process.env.SUPABASE_URL ?? "",
            SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
            RAW_UPLOAD_ID: rawUploadId,
            ORG_ID: orgId,
            DATASET_ID: "",
            ENDPOINT_ID: endPointId!,
            DB_URL: dbUrl,
          },
        });

        // Log pipeline run (non-blocking)
        void supabase.from("pipeline_run_log").insert({
          org_id: orgId,
          endpoint_id: endPointId,
          trigger_reason: "chat",
          template_id: templateId,
          status: "complete",
        });

        // Update session phase to analysis (non-blocking)
        void supabase.from("sessions").update({ phase: "analysis" }).eq("id", sessionId!);

        // Re-run analysis code against the now-populated tables
        result = await runAndParse(fixedCode);
        return { ...result, autoFetchCompleted: true };
      }

      return result;
    } catch (err) {
      return {
        data: {},
        summary: `Sandbox error: ${(err as Error).message}`,
        stdout: "",
        error: (err as Error).message,
      };
    } finally {
      await sandbox.kill();
    }
  },
});
