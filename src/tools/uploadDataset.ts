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

function inferColumnType(header: string, sampleValue: string): string {
  const h = header.toLowerCase();
  if (h.includes("_at") || h.includes("time") || h.includes("date")) return "timestamp";
  if (h.includes("_id") || h === "id") return "uuid";
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

    // ── 4. Write csvUrl back to session so getSessionContext returns it ────────
    // Without this, the next turn's getSessionContext call finds no csvUrl and
    // the agent incorrectly concludes no data is loaded.
    await supabase
      .from("sessions")
      .update({ csv_public_url: csvUrl, csv_filename: filename })
      .eq("id", sessionId);

    return {
      success: true,
      datasetId: dataset.id as string,
      csvUrl,
      filename,
      columns,
      rowCount,
      message: `Dataset registered: ${rowCount.toLocaleString()} rows, ${columns.length} columns.`,
    };
  },
});
