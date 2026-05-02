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
    "Uploads the resulting CSV to Supabase Storage and updates sessions.csv_public_url. " +
    "After this tool succeeds, use the returned csvUrl in all executeCode calls.",
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
      .default("sessions")
      .describe("DR6000 report type. Use 'sessions' for dwell/engagement metrics, 'paths' for x/y coordinates."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    csvUrl: z.string().optional(),
    filename: z.string().optional(),
    rowCount: z.number().optional(),
    reportType: z.string().optional(),
    message: z.string(),
  }),
  execute: async (context) => {
    const { sessionId, endPointId, startTime, endTime, reportType } = context;
    const supabase = getSupabase();

    // ── 1. Look up endpoint record → mac_address + org_id ─────────────────────
    const { data: endPoint, error: endPointError } = await supabase
      .from("end_points")
      .select("mac_address, org_id")
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

    // ── 3. Build and execute DR6000 API request ────────────────────────────────
    const params = new URLSearchParams({
      mac_address: endPoint.mac_address,
      start_time: startTime,
      end_time: endTime,
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

    // ── 4. Count rows (header excluded) ───────────────────────────────────────
    const lines = csvText.trim().split("\n");
    const rowCount = lines.length - 1;

    // ── 5. Upload CSV to Supabase Storage ──────────────────────────────────────
    const safeStart = startTime.replace(/[^0-9T]/g, "-");
    const safeEnd = endTime.replace(/[^0-9T]/g, "-");
    const filename = `dr6000_${reportType}_${safeStart}_${safeEnd}.csv`;
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

    // ── 6. Get public URL and update session ───────────────────────────────────
    const { data: urlData } = supabase.storage.from("csv-uploads").getPublicUrl(storagePath);
    const csvUrl = urlData.publicUrl;

    await supabase
      .from("sessions")
      .update({ csv_public_url: csvUrl, csv_storage_path: storagePath })
      .eq("id", sessionId);

    return {
      success: true,
      csvUrl,
      filename,
      rowCount,
      reportType,
      message: `Fetched ${rowCount} rows (${reportType} report). CSV ready at ${csvUrl}`,
    };
  },
});
