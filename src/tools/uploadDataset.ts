/**
 * Tool: uploadDataset
 *
 * Registers a CSV that already exists in Supabase Storage as a formal dataset
 * record. Called by the agent after receiving a csvUrl from getSessionContext
 * or after the user confirms they want to start analysis on the uploaded file.
 *
 * Responsibility boundary: the app frontend handles the physical upload to
 * Supabase Storage. This tool handles metadata extraction and dataset registration.
 *
 * What it does:
 *   1. Fetches the CSV to extract column schema and row count
 *   2. Infers column types from headers + first data row
 *   3. Writes the dataset record to public.datasets
 *   4. Returns datasetId, confirmed csvUrl, column info, and row count
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

const TIMESTAMP_COLUMNS = new Set([
  "log_creation_time", "processed_at", "created_at", "updated_at",
  "timestamp", "event_time", "record_time", "start_time", "end_time",
]);

function inferColumnType(header: string, sampleValue: string): string {
  const h = header.toLowerCase();
  // Exact-match known timestamp columns first to avoid false positives on
  // names like "timezone_offset" or "timezone_label" that contain "time".
  if (TIMESTAMP_COLUMNS.has(h) || h.endsWith("_at")) return "timestamp";
  // Only treat *_id as uuid when the sample value looks like a real UUID.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if ((h.endsWith("_id") || h === "id") && UUID_RE.test(sampleValue)) return "uuid";
  if (h.includes("_m") || h === "proximity_m") return "float";
  if (h.includes("dwell") || h.includes("count") || h.includes("duration")) return "float";
  if (sampleValue && !isNaN(Number(sampleValue)) && sampleValue.trim() !== "") return "numeric";
  return "text";
}

function buildColumnSignature(headers: string[]): string {
  return headers.slice().sort().join(",");
}

export const uploadDatasetTool = createTool({
  id: "upload-dataset",
  description:
    "Register an uploaded CSV as a dataset record. " +
    "Call this after the user uploads a CSV file (csvUrl will be present in getSessionContext). " +
    "This tool profiles the CSV (columns, row count) and writes a record to the datasets table. " +
    "Returns a datasetId that links this dataset to the session. " +
    "After this succeeds, use the returned csvUrl in all executeCode calls.",
  inputSchema: z.object({
    sessionId: z.string().describe("Current session ID."),
    orgId: z.string().describe("Organization ID from session context."),
    csvUrl: z.string().describe("Public URL of the CSV in Supabase Storage (from getSessionContext)."),
    filename: z.string().optional().describe("Original filename. Inferred from URL if omitted."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    datasetId: z.string().optional(),
    rawUploadId: z.string().optional(),
    csvUrl: z.string().optional(),
    filename: z.string().optional(),
    columns: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
    rowCount: z.number().optional(),
    message: z.string(),
  }),
  execute: async (context) => {
    const { sessionId, orgId, csvUrl, filename: inputFilename } = context;
    const supabase = getSupabase();

    // ── 1. Fetch the CSV ───────────────────────────────────────────────────────
    let csvText: string;
    try {
      const response = await fetch(csvUrl);
      if (!response.ok) {
        return { success: false, message: `Could not fetch CSV at ${csvUrl}: HTTP ${response.status}` };
      }
      csvText = await response.text();
    } catch (err) {
      return { success: false, message: `Network error fetching CSV: ${(err as Error).message}` };
    }

    if (!csvText.trim()) {
      return { success: false, message: "CSV is empty." };
    }

    // ── 2. Parse headers and first data row ───────────────────────────────────
    const lines = csvText.trim().split(/\r?\n/);
    const rawHeaders = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const firstDataRow = lines[1]
      ? lines[1].split(",").map((v) => v.trim().replace(/^"|"$/g, ""))
      : [];

    const columns = rawHeaders.map((header, i) => ({
      name: header,
      type: inferColumnType(header, firstDataRow[i] ?? ""),
    }));

    const rowCount = Math.max(0, lines.length - 1); // subtract header row
    const columnSignature = buildColumnSignature(rawHeaders);
    const filename = inputFilename ?? csvUrl.split("/").pop() ?? "upload.csv";

    // ── 3. Write dataset record ────────────────────────────────────────────────
    const { data: dataset, error: insertError } = await supabase
      .from("datasets")
      .insert({
        org_id: orgId,
        upload_session_id: sessionId,
        filename,
        csv_url: csvUrl,
        row_count: rowCount,
        column_signature: columnSignature,
        schema_json: columns,
        source_type: "csv_upload",
      })
      .select("id")
      .single();

    if (insertError || !dataset) {
      return {
        success: false,
        message: `Failed to write dataset record: ${insertError?.message ?? "unknown error"}`,
      };
    }

    // ── 4. Write raw_data_uploads record ─────────────────────────────────────
    // Extract storage_path from csvUrl. The URL format is:
    // https://[project].supabase.co/storage/v1/object/public/csv-uploads/[path]
    const storagePathMatch = csvUrl.match(/\/csv-uploads\/(.+)$/);
    const storagePath = storagePathMatch ? storagePathMatch[1] : csvUrl;

    const { data: rawUpload, error: rawUploadError } = await supabase
      .from("raw_data_uploads")
      .insert({
        org_id: orgId,
        source_type: "csv_upload",
        filename,
        storage_path: storagePath,
        storage_url: csvUrl,
        row_count: rowCount,
        session_id: sessionId,
      })
      .select("id")
      .single();

    const rawUploadId = rawUpload?.id as string | undefined;

    // ── 5. Write csvUrl + raw_upload_id back to session ───────────────────────
    // Without this, the next turn's getSessionContext call finds no csvUrl and
    // the agent incorrectly concludes no data is loaded.
    await supabase
      .from("sessions")
      .update({
        csv_public_url: csvUrl,
        csv_filename: filename,
        ...(rawUploadId ? { raw_upload_id: rawUploadId } : {}),
      })
      .eq("id", sessionId);

    if (rawUploadError) {
      // Non-fatal — dataset record was written, raw_upload record failed.
      // Agent can proceed; M1.5 transform will be blocked but dataset is usable.
      console.error("raw_data_uploads insert failed:", rawUploadError.message);
    }

    return {
      success: true,
      datasetId: dataset.id as string,
      rawUploadId,
      csvUrl,
      filename,
      columns,
      rowCount,
      message: `Dataset registered: ${rowCount.toLocaleString()} rows, ${columns.length} columns.`,
    };
  },
});
