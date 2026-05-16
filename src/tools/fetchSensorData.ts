/**
 * Tool: fetchSensorData
 *
 * Fetches radar sensor data from the DR6000 API. Credentials are resolved via
 * two lookups:
 *   end_points (by endPointId)  → mac_address + org_id
 *   integrations (by org_id)    → api_key
 *
 * The agent extracts endPointId, startTime, and endTime from the [API_CONTEXT]
 * block appended to the user's message by the app.
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

const DR6000_BASE_URL = "https://app.datarealities.com/api/sensor-logs";

export const fetchSensorDataTool = createTool({
  id: "fetch-sensor-data",
  description:
    "Fetch radar sensor data from the DR6000 API. " +
    "Use this when the user message contains an [API_CONTEXT] block. " +
    "Extract end_point_id, range_start, and range_end from that block and pass them here. " +
    "Uploads the resulting CSV to Supabase Storage, writes a raw_data_uploads record, and updates sessions.raw_upload_id. " +
    "After this tool succeeds, call executeTransform with the returned rawUploadId to populate dataset_records.",
  inputSchema: z.object({
    sessionId: z.string().describe("Current session ID — used to store the result"),
    endPointId: z
      .string()
      .describe("Endpoint ID from the [API_CONTEXT] block (end_point_id). Used to look up mac_address and org_id."),
    startTime: z
      .string()
      .describe("Start of data range from [API_CONTEXT] (range_start). ISO 8601 string."),
    endTime: z
      .string()
      .describe("End of data range from [API_CONTEXT] (range_end). ISO 8601 string."),
    reportType: z
      .enum(["sessions", "paths"])
      .default("paths")
      .describe(
        "DR6000 report type. Always use 'paths' for the ingestion pipeline — " +
        "it returns per-second position readings (target_id, x_m, y_m) that the " +
        "dr6000-transform-v1 template requires for QR-1/QR-2/QR-3 classification. " +
        "The 'sessions' endpoint returns pre-aggregated rows and is not compatible " +
        "with the transform template. Do not use 'sessions' unless explicitly instructed."
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    csvUrl: z.string().optional(),
    rawUploadId: z.string().optional(),
    integrationId: z.string().optional(),
    filename: z.string().optional(),
    rowCount: z.number().optional(),
    reportType: z.string().optional(),
    message: z.string(),
  }),
  execute: async (context) => {
    const { sessionId, endPointId, startTime, endTime, reportType } = context;
    const supabase = getSupabase();

    // ── 1. Look up endpoint record → mac_address + org_id + timezone ──────────
    const { data: endPoint, error: endPointError } = await supabase
      .from("end_points")
      .select("mac_address, org_id, timezone")
      .eq("id", endPointId)
      .single();

    if (endPointError || !endPoint) {
      return {
        success: false,
        message: `Could not load endpoint ${endPointId}: ${endPointError?.message ?? "not found"}`,
      };
    }

    if (!endPoint.mac_address) {
      return {
        success: false,
        message: `Endpoint ${endPointId} has no mac_address configured.`,
      };
    }

    // ── 2. Look up integration → api_key ──────────────────────────────────────
    const { data: integration, error: integrationError } = await supabase
      .from("integrations")
      .select("api_key")
      .eq("org_id", endPoint.org_id)
      .eq("vendor", "data-realities-radar")
      .single();

    if (integrationError || !integration) {
      return {
        success: false,
        message: `Could not load integration for org ${endPoint.org_id}: ${integrationError?.message ?? "not found"}`,
      };
    }

    if (!integration.api_key) {
      return {
        success: false,
        message: `Integration for org ${endPoint.org_id} has no api_key configured.`,
      };
    }

    // ── 3. Normalize to canonical calendar dates in endpoint's local timezone ──
    // date_start / date_end are the canonical DATE keys used for coverage checks
    // and the UNIQUE constraint on audience_day_agg(org_id, endpoint_id, date).
    // The API call uses local-day boundaries (00:00:00 to 23:59:59) so each fetch
    // covers exactly one or more complete calendar days.
    const tz = (endPoint.timezone as string | null) ?? "America/Toronto";

    function toLocalDateStr(isoTs: string, timezone: string): string {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(isoTs));
    }

    const dateStart = toLocalDateStr(startTime, tz);
    const dateEnd   = toLocalDateStr(endTime, tz);

    // Fetch window: full calendar-day boundaries in local time (no timezone suffix —
    // the DR6000 API interprets these as local store time).
    const normalizedStart = `${dateStart} 00:00:00`;
    const normalizedEnd   = `${dateEnd} 23:59:59`;

    // ── 4. Build and execute DR6000 API request ────────────────────────────────
    const params = new URLSearchParams({
      mac_address: endPoint.mac_address,
      start_time: normalizedStart,
      end_time: normalizedEnd,
      type: "csv",
    });

    const endpoint = `${DR6000_BASE_URL}/${reportType}?${params.toString()}`;

    const response = await fetch(endpoint, {
      headers: { "x-api-key": integration.api_key },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        success: false,
        message: `DR6000 API error ${response.status}: ${body || response.statusText}`,
      };
    }

    const csvText = await response.text();

    if (!csvText.trim()) {
      return { success: false, message: "DR6000 API returned an empty response for the given parameters." };
    }

    // ── 5. Count rows (header excluded) ───────────────────────────────────────
    const lines = csvText.trim().split("\n");
    const rowCount = lines.length - 1;

    // ── 6. Upload CSV to Supabase Storage ──────────────────────────────────────
    // Include a short endpoint suffix so multi-endpoint fetches don't overwrite each other.
    const epSuffix = endPointId.slice(0, 8);
    const filename = `dr6000_${reportType}_${dateStart}_${dateEnd}_${epSuffix}.csv`;
    const storagePath = `sessions/${sessionId}/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from("csv-uploads")
      .upload(storagePath, new Blob([csvText], { type: "text/csv" }), {
        upsert: true,
        contentType: "text/csv",
      });

    if (uploadError) {
      return { success: false, message: `Failed to upload CSV to storage: ${uploadError.message}` };
    }

    // ── 7. Get public URL ─────────────────────────────────────────────────────
    const { data: urlData } = supabase.storage.from("csv-uploads").getPublicUrl(storagePath);
    const csvUrl = urlData.publicUrl;

    // ── 8. Write raw_data_uploads record ──────────────────────────────────────
    // date_start / date_end are canonical calendar dates (local timezone).
    // range_start / range_end preserve the original app-provided timestamps for audit.
    const { data: rawUpload, error: rawUploadError } = await supabase
      .from("raw_data_uploads")
      .insert({
        org_id: endPoint.org_id,
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

    if (rawUploadError || !rawUpload) {
      return {
        success: false,
        message: `CSV fetched and uploaded successfully, but failed to write raw_data_uploads record: ${rawUploadError?.message ?? "no row returned"}. Ensure the sessionId exists in the sessions table (use a real app session, not a Studio-generated ID).`,
      };
    }

    const rawUploadId = rawUpload.id as string;

    // ── 9. Update session with csvUrl + raw_upload_id ─────────────────────────
    await supabase
      .from("sessions")
      .update({
        csv_public_url: csvUrl,
        csv_storage_path: storagePath,
        raw_upload_id: rawUploadId,
      })
      .eq("id", sessionId);

    return {
      success: true,
      csvUrl,
      rawUploadId,
      integrationId: "dr6000-radar",
      filename,
      rowCount,
      reportType,
      message: `Fetched ${rowCount} rows (${reportType} report) for ${dateStart} to ${dateEnd}. CSV ready at ${csvUrl}`,
    };
  },
});
