/**
 * Tool: triggerPipelineRun
 *
 * Single entry point for automated pipeline executions (learn, resync, onboarding).
 * Orchestrates: fetch sensor data from DR6000 → upload raw CSV → run E2B transform
 * → write audience tables → write pipeline_run_log in one atomic call.
 *
 * Use this tool for non-interactive runs where no dictionary approval gate is needed
 * (data structure already known — template and params pre-resolved).
 *
 * For chat-triggered runs requiring dictionary approval: still use fetchSensorData
 * (Step 1) followed by the approval gate and then executeTransform (Step 4).
 *
 * Caller should resolve templateId + params via getTransformPipeline first.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );
}

const DR6000_BASE_URL = "https://app.datarealities.com/api/sensor-logs";

const transformOutputSchema = z.object({
  type: z.literal("transform"),
  observationsWritten: z.number(),
  agg15minWritten: z.number(),
  aggDayWritten: z.number(),
  classificationCounts: z.object({ engaged: z.number(), passer_by: z.number() }),
  qualityRules: z.object({ offHoursRemoved: z.number(), belowMinPointsRemoved: z.number() }),
  summary: z.string(),
});

export const triggerPipelineRunTool = createTool({
  id: "trigger-pipeline-run",
  description:
    "Single entry point for automated (non-interactive) pipeline runs. " +
    "Orchestrates DR6000 fetch → raw upload → E2B transform → audience tables → pipeline_run_log. " +
    "Use for reason='learn' (scheduled), 'resync' (admin reprocess), or 'onboarding'. " +
    "Call getTransformPipeline first to resolve templateId and params. " +
    "For chat runs requiring a dictionary approval gate, use fetchSensorData + executeTransform instead.",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    endPointId: z.string().describe("Endpoint to fetch data from (end_points.id)"),
    startTime: z.string().describe("ISO 8601 start of fetch range"),
    endTime: z.string().describe("ISO 8601 end of fetch range"),
    templateId: z.string().describe("code_templates.id — resolve via getTransformPipeline first"),
    params: z
      .record(z.unknown())
      .optional()
      .describe("Resolved template parameter values keyed by placeholder name"),
    reason: z
      .enum(["chat", "learn", "onboarding", "resync"])
      .describe("Trigger reason written to pipeline_run_log audit trail"),
    sessionId: z
      .string()
      .optional()
      .describe("Session ID — when provided, links raw upload to session and updates csv_public_url"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    rawUploadId: z.string().optional(),
    observationsWritten: z.number().optional(),
    agg15minWritten: z.number().optional(),
    aggDayWritten: z.number().optional(),
    classificationCounts: z.object({ engaged: z.number(), passer_by: z.number() }).optional(),
    summary: z.string(),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { orgId, endPointId, startTime, endTime, templateId, params, reason, sessionId } = context;
    const supabase = getSupabase();

    // ── 1. Resolve endpoint → mac_address ─────────────────────────────────────
    const { data: endPoint, error: endPointError } = await supabase
      .from("end_points")
      .select("mac_address, org_id")
      .eq("id", endPointId)
      .single();

    if (endPointError || !endPoint) {
      return {
        success: false,
        summary: `Endpoint ${endPointId} not found: ${endPointError?.message ?? "no row"}`,
        error: endPointError?.message ?? "not found",
      };
    }

    if (!endPoint.mac_address) {
      return {
        success: false,
        summary: `Endpoint ${endPointId} has no mac_address configured.`,
        error: "missing mac_address",
      };
    }

    // ── 2. Resolve integration → api_key ──────────────────────────────────────
    const { data: integration, error: integrationError } = await supabase
      .from("integrations")
      .select("api_key")
      .eq("org_id", orgId)
      .eq("vendor", "data-realities-radar")
      .single();

    if (integrationError || !integration) {
      return {
        success: false,
        summary: `No DR6000 integration for org ${orgId}: ${integrationError?.message ?? "not found"}`,
        error: integrationError?.message ?? "not found",
      };
    }

    if (!integration.api_key) {
      return {
        success: false,
        summary: `DR6000 integration for org ${orgId} has no api_key configured.`,
        error: "missing api_key",
      };
    }

    // ── 3. Fetch from DR6000 API ───────────────────────────────────────────────
    const queryParams = new URLSearchParams({
      mac_address: endPoint.mac_address as string,
      start_time: startTime,
      end_time: endTime,
      type: "csv",
    });

    let csvText: string;
    try {
      const response = await fetch(
        `${DR6000_BASE_URL}/paths?${queryParams.toString()}`,
        { headers: { "x-api-key": integration.api_key as string } }
      );

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          success: false,
          summary: `DR6000 API error ${response.status}: ${body || response.statusText}`,
          error: `HTTP ${response.status}`,
        };
      }

      csvText = await response.text();
    } catch (fetchErr) {
      return {
        success: false,
        summary: `Failed to reach DR6000 API: ${(fetchErr as Error).message}`,
        error: (fetchErr as Error).message,
      };
    }

    if (!csvText.trim()) {
      return { success: false, summary: "DR6000 API returned an empty response.", error: "empty response" };
    }

    const rowCount = csvText.trim().split("\n").length - 1;

    // ── 4. Upload CSV to Supabase Storage ──────────────────────────────────────
    const safeStart = startTime.replace(/[^0-9T]/g, "-");
    const safeEnd = endTime.replace(/[^0-9T]/g, "-");
    const filename = `dr6000_paths_${safeStart}_${safeEnd}.csv`;
    const storagePath = sessionId
      ? `sessions/${sessionId}/${filename}`
      : `pipeline/${orgId}/${filename}`;

    const { error: storageError } = await supabase.storage
      .from("csv-uploads")
      .upload(storagePath, new Blob([csvText], { type: "text/csv" }), {
        upsert: true,
        contentType: "text/csv",
      });

    if (storageError) {
      return {
        success: false,
        summary: `Storage upload failed: ${storageError.message}`,
        error: storageError.message,
      };
    }

    const { data: urlData } = supabase.storage.from("csv-uploads").getPublicUrl(storagePath);
    const csvUrl = urlData.publicUrl;

    // ── 5. Write raw_data_uploads ──────────────────────────────────────────────
    const { data: rawUpload, error: rawUploadError } = await supabase
      .from("raw_data_uploads")
      .insert({
        org_id: orgId,
        source_type: "api_fetch",
        filename,
        storage_path: storagePath,
        storage_url: csvUrl,
        row_count: rowCount,
        session_id: sessionId ?? null,
        integration_type: "dr6000-radar",
        endpoint_id: endPointId,
        range_start: startTime,
        range_end: endTime,
      })
      .select("id")
      .single();

    if (rawUploadError || !rawUpload) {
      return {
        success: false,
        summary: `Failed to write raw_data_uploads: ${rawUploadError?.message ?? "no row returned"}`,
        error: rawUploadError?.message,
      };
    }

    const rawUploadId = rawUpload.id as string;

    // ── 6. Link session if provided ────────────────────────────────────────────
    if (sessionId) {
      await supabase
        .from("sessions")
        .update({
          csv_public_url: csvUrl,
          csv_storage_path: storagePath,
          raw_upload_id: rawUploadId,
        })
        .eq("id", sessionId);
    }

    // ── 7. Fetch template code ─────────────────────────────────────────────────
    const { data: template, error: templateError } = await supabase
      .from("code_templates")
      .select("code, parameters, name")
      .eq("id", templateId)
      .single();

    if (templateError || !template) {
      return {
        success: false,
        summary: `Template ${templateId} not found: ${templateError?.message ?? "no row"}`,
        error: templateError?.message,
        rawUploadId,
      };
    }

    // Validate required params
    if (template.parameters && Array.isArray(template.parameters)) {
      const missing: string[] = [];
      for (const p of template.parameters as Array<{ name: string; required: boolean }>) {
        if (p.required && (params?.[p.name] === undefined || params?.[p.name] === null || params?.[p.name] === "")) {
          missing.push(p.name);
        }
      }
      if (missing.length > 0) {
        return {
          success: false,
          summary: `Missing required template params: ${missing.join(", ")}`,
          error: `Missing params: ${missing.join(", ")}`,
          rawUploadId,
        };
      }
    }

    // Fill {{PLACEHOLDER}} tokens
    let code = template.code as string;
    if (params) {
      code = code.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const val = params[key];
        return val !== undefined && val !== null ? String(val) : `{{${key}}}`;
      });
    }

    const unfilled = code.match(/\{\{\w+\}\}/g);
    if (unfilled) {
      return {
        success: false,
        summary: `Unfilled template placeholders: ${[...new Set(unfilled)].join(", ")}`,
        error: `Unfilled: ${[...new Set(unfilled)].join(", ")}`,
        rawUploadId,
      };
    }

    // ── 8. Run E2B transform ───────────────────────────────────────────────────
    const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });

    try {
      // Download CSV into sandbox
      const csvResponse = await fetch(csvUrl);
      if (!csvResponse.ok) {
        return {
          success: false,
          summary: `Failed to load CSV from storage: HTTP ${csvResponse.status}`,
          rawUploadId,
        };
      }
      const csvBuffer = await csvResponse.arrayBuffer();
      await sandbox.files.write("/sandbox/upload.csv", csvBuffer);

      // Install dependencies
      await sandbox.runCode(
        "import subprocess; subprocess.run(['pip', 'install', 'pandas', 'numpy', 'psycopg2-binary', '--quiet', '--root-user-action=ignore'], check=True, capture_output=True)",
        { language: "python" }
      );

      // Run transform
      const dbPassword = encodeURIComponent(process.env.SUPABASE_DB_PASSWORD ?? "");
      const dbUrl = `postgresql://postgres.ftshahsqtkxxjmpsmyhp:${dbPassword}@aws-1-us-east-2.pooler.supabase.com:5432/postgres?sslmode=require`;

      const exec = await sandbox.runCode(code, {
        language: "python",
        envs: {
          SUPABASE_URL: process.env.SUPABASE_URL ?? "",
          SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          RAW_UPLOAD_ID: rawUploadId,
          ORG_ID: orgId,
          DATASET_ID: "",
          DB_URL: dbUrl,
        },
      });

      const stdout = exec.logs.stdout.join("\n");
      const outputLines = stdout.trim().split("\n").filter(Boolean);
      const lastLine = outputLines[outputLines.length - 1];

      const writeFailLog = async (errMsg: string) => {
        await supabase.from("pipeline_run_log").insert({
          org_id: orgId,
          endpoint_id: endPointId,
          trigger_reason: reason,
          range_start: startTime,
          range_end: endTime,
          template_id: templateId,
          status: "failed",
          error: errMsg,
        });
      };

      if (!lastLine) {
        const errMsg = exec.error
          ? `${exec.error.name}: ${exec.error.value}`
          : "Script produced no output";
        await writeFailLog(errMsg);
        return { success: false, summary: `Transform failed: ${errMsg}`, error: errMsg, rawUploadId };
      }

      let transformOutput: z.infer<typeof transformOutputSchema>;
      try {
        transformOutput = transformOutputSchema.parse(JSON.parse(lastLine));
      } catch {
        const errMsg = `Transform output did not match contract. Got: ${lastLine.slice(0, 200)}`;
        await writeFailLog(errMsg);
        return { success: false, summary: errMsg, error: errMsg, rawUploadId };
      }

      const { observationsWritten, agg15minWritten, aggDayWritten, classificationCounts, summary } = transformOutput;

      // ── 9. Write template_id to audience_observations ─────────────────────
      await supabase
        .from("audience_observations")
        .update({ template_id: templateId })
        .eq("raw_upload_id", rawUploadId)
        .eq("org_id", orgId);

      // ── 10. Write pipeline_run_log ─────────────────────────────────────────
      await supabase.from("pipeline_run_log").insert({
        org_id: orgId,
        endpoint_id: endPointId,
        trigger_reason: reason,
        range_start: startTime,
        range_end: endTime,
        template_id: templateId,
        status: "complete",
        rows_written: observationsWritten,
      });

      return {
        success: true,
        rawUploadId,
        observationsWritten,
        agg15minWritten,
        aggDayWritten,
        classificationCounts,
        summary,
      };
    } finally {
      await sandbox.kill();
    }
  },
});
