/**
 * Tool: saveDataDictionary
 *
 * Persists an approved data dictionary to the datasets table in Supabase.
 * Called only after explicit user approval — never autonomously.
 *
 * Upserts by column_signature so the same CSV schema always updates the
 * existing record rather than creating duplicates.
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

export const saveDataDictionaryTool = createTool({
  id: "save-data-dictionary",
  description:
    "Submit a data dictionary to the datasets table for user approval. " +
    "Always pass pendingApproval: true — the record is saved as pending and the user " +
    "approves it via the inline card in the chat UI. Do not wait for a text 'yes' first. " +
    "Matches by column_signature — uploading the same schema again updates the existing record.",
  inputSchema: z.object({
    sessionId: z.string().describe("Current session ID (stored as upload_session_id)"),
    filename: z.string().describe("CSV filename"),
    columnSignature: z
      .string()
      .describe("Comma-separated list of CSV column names — used to match this dictionary to future uploads"),
    schemaJson: z
      .record(z.unknown())
      .describe("Raw schema profile object from the executeCode inspection step"),
    dataDictionaryJson: z
      .array(z.unknown())
      .describe("Approved data dictionary rows (one object per column)"),
    pendingApproval: z
      .boolean()
      .default(true)
      .describe("Always true for agent calls. Saves the dictionary as pending so the user can approve via the UI."),
    deploymentContext: z
      .string()
      .optional()
      .describe("Physical location, coordinate system notes, known data quality issues"),
    orgId: z
      .string()
      .describe("Organization ID — use the orgId returned by getSessionContext"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    kind: z.literal("data-dictionary").optional(),
    approval_status: z.enum(["pending", "approved"]).optional(),
    filename: z.string().optional(),
    columnSignature: z.string().optional(),
    dataDictionaryJson: z.array(z.unknown()).optional(),
    deploymentContext: z.string().optional(),
    message: z.string(),
  }),
  execute: async (context) => {
    const supabase = getSupabase();

    try {
      const approvalStatus: "pending" | "approved" = context.pendingApproval ? "pending" : "approved";

      // Check for an existing record with this column signature
      const { data: existing } = await supabase
        .from("datasets")
        .select("id")
        .eq("column_signature", context.columnSignature)
        .limit(1)
        .maybeSingle();

      const sharedPayload = {
        filename: context.filename,
        schema_json: context.schemaJson,
        data_dictionary_json: context.dataDictionaryJson,
        deployment_context: context.deploymentContext ?? null,
        upload_session_id: context.sessionId,
        approval_status: approvalStatus,
        org_id: context.orgId,
      };

      let id: string | undefined;

      if (existing) {
        const { data, error } = await supabase
          .from("datasets")
          .update(sharedPayload)
          .eq("id", existing.id)
          .select("id")
          .single();
        if (error) throw error;
        id = data?.id;
      } else {
        const { data, error } = await supabase
          .from("datasets")
          .insert({ ...sharedPayload, column_signature: context.columnSignature })
          .select("id")
          .single();
        if (error) throw error;
        id = data?.id;
      }

      return {
        success: true,
        id,
        kind: "data-dictionary" as const,
        approval_status: approvalStatus,
        filename: context.filename,
        columnSignature: context.columnSignature,
        dataDictionaryJson: context.dataDictionaryJson,
        deploymentContext: context.deploymentContext,
        message: approvalStatus === "pending"
          ? "Data dictionary submitted for approval. The user will see an inline approval card."
          : "Data dictionary saved. Will be loaded automatically in future sessions with this CSV schema.",
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to save data dictionary: ${(err as Error).message}`,
      };
    }
  },
});
