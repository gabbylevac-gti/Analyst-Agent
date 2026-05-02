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
    "Persist an approved data dictionary to the datasets table. Call only after explicit user approval. " +
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
    deploymentContext: z
      .string()
      .optional()
      .describe("Physical location, coordinate system notes, known data quality issues"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    id: z.string().optional(),
    message: z.string(),
  }),
  execute: async (context) => {
    const supabase = getSupabase();

    try {
      // Check for an existing record with this column signature
      const { data: existing } = await supabase
        .from("datasets")
        .select("id")
        .eq("column_signature", context.columnSignature)
        .limit(1)
        .maybeSingle();

      if (existing) {
        const { data, error } = await supabase
          .from("datasets")
          .update({
            filename: context.filename,
            schema_json: context.schemaJson,
            data_dictionary_json: context.dataDictionaryJson,
            deployment_context: context.deploymentContext ?? null,
            upload_session_id: context.sessionId,
          })
          .eq("id", existing.id)
          .select("id")
          .single();

        if (error) throw error;
        return {
          success: true,
          id: data?.id,
          message: "Data dictionary updated. Will be loaded automatically in future sessions with this CSV schema.",
        };
      }

      const { data, error } = await supabase
        .from("datasets")
        .insert({
          filename: context.filename,
          column_signature: context.columnSignature,
          schema_json: context.schemaJson,
          data_dictionary_json: context.dataDictionaryJson,
          deployment_context: context.deploymentContext ?? null,
          upload_session_id: context.sessionId,
        })
        .select("id")
        .single();

      if (error) throw error;
      return {
        success: true,
        id: data?.id,
        message: "Data dictionary saved. Will be loaded automatically in future sessions with this CSV schema.",
      };
    } catch (err) {
      return {
        success: false,
        message: `Failed to save data dictionary: ${(err as Error).message}`,
      };
    }
  },
});
