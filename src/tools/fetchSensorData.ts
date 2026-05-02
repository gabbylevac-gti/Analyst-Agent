/**
 * Tool: fetchSensorData
 *
 * Fetches radar sensor data from the DR6000 API, uploads the resulting CSV to
 * Supabase Storage, and updates sessions.csv_public_url so the existing
 * executeCode flow can access it without any other changes.
 *
 * Credentials (api_key) and query parameters are read from the sessions table,
 * where the app UI stores them before starting the conversation. This keeps
 * the API key out of message history entirely.
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
    "Fetch radar sensor data from the DR6000 API using credentials and parameters stored in the session record. " +
    "Uploads the resulting CSV to Supabase Storage and updates sessions.csv_public_url. " +
    "Call this when the user wants to analyse sensor data from the API rather than from an uploaded file. " +
    "After this tool succeeds, use the returned csvUrl in executeCode calls.",
  inputSchema: z.object({
    sessionId: z.string().describe("Current session ID — used to look up credentials and store the result"),
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
    const { sessionId } = context;
    const supabase = getSupabase();

    // ── 1. Load credentials and query params from session record ──────────────
    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .select("dr6000_api_key, dr6000_mac_address, dr6000_start_time, dr6000_end_time, dr6000_report_type")
      .eq("id", sessionId)
      .single();

    if (sessionError || !session) {
      return { success: false, message: `Could not load session: ${sessionError?.message ?? "not found"}` };
    }

    const { dr6000_api_key, dr6000_mac_address, dr6000_start_time, dr6000_end_time, dr6000_report_type } = session;

    if (!dr6000_api_key || !dr6000_mac_address || !dr6000_start_time || !dr6000_end_time) {
      return {
        success: false,
        message:
          "Missing DR6000 credentials in session record. " +
          "The app UI must store api_key, mac_address, start_time, and end_time in the sessions table before calling this tool.",
      };
    }

    const reportType: string = dr6000_report_type ?? "sessions";
    if (reportType !== "sessions" && reportType !== "paths") {
      return { success: false, message: `Invalid report_type "${reportType}". Must be "sessions" or "paths".` };
    }

    // ── 2. Build DR6000 API request ────────────────────────────────────────────
    const params = new URLSearchParams({
      mac_address: dr6000_mac_address,
      start_time: dr6000_start_time,
      end_time: dr6000_end_time,
      type: "csv",
    });

    const endpoint = `${DR6000_BASE_URL}/${reportType}?${params.toString()}`;

    const response = await fetch(endpoint, {
      headers: { "x-api-key": dr6000_api_key },
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

    // ── 3. Count rows for the caller (header row excluded) ─────────────────────
    const lines = csvText.trim().split("\n");
    const rowCount = lines.length - 1;

    // ── 4. Upload CSV to Supabase Storage ──────────────────────────────────────
    const safeStart = dr6000_start_time.replace(/[^0-9T]/g, "-");
    const safeEnd = dr6000_end_time.replace(/[^0-9T]/g, "-");
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

    // ── 5. Get public URL ──────────────────────────────────────────────────────
    const { data: urlData } = supabase.storage.from("csv-uploads").getPublicUrl(storagePath);
    const csvUrl = urlData.publicUrl;

    // ── 6. Update session record ───────────────────────────────────────────────
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
