/**
 * Tool: getTransformPipeline
 *
 * Given an integrationId (e.g. 'dr6000-radar'), returns the approved
 * transformation template for that integration type plus pre-resolved values
 * for all 'org_config' parameters from the interpretation_configs table.
 *
 * The agent calls this after uploadDataset/fetchSensorData to know:
 *   1. Which template to pass to executeTransform (templateId)
 *   2. What parameters the template needs (parameters array)
 *   3. What org_config values are already configured (resolvedOrgConfig)
 *
 * Parameter resolution by source:
 *   deployment_context → agent reads from getSessionContext output
 *   org_config         → pre-resolved here; agent reads from resolvedOrgConfig
 *   user_input         → agent triggers requestContextCard if value missing
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

const parameterSchema = z.object({
  name: z.string(),
  type: z.string(),
  source: z.enum(["deployment_context", "org_config", "user_input"]),
  source_field: z.string().optional(),
  default: z.unknown().optional(),
  description: z.string(),
  required: z.boolean(),
});

export const getTransformPipelineTool = createTool({
  id: "get-transform-pipeline",
  description:
    "Get the approved transform template for a given integration type. " +
    "Returns templateId, templateName, the parameter schema, and pre-resolved " +
    "org_config values from interpretation_configs. " +
    "Call this after uploadDataset or fetchSensorData to know what params to " +
    "collect before calling executeTransform. " +
    "If found is false, no approved transform exists for this integration — " +
    "do not write transform code; surface a clear message to the user.",
  inputSchema: z.object({
    integrationId: z
      .string()
      .describe("Integration type identifier (e.g. 'dr6000-radar'). From raw_data_uploads.integration_type returned by uploadDataset or fetchSensorData."),
    orgId: z.string().describe("Organization ID from session context."),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    templateId: z.string().optional(),
    templateName: z.string().optional(),
    parameters: z.array(parameterSchema).optional(),
    resolvedOrgConfig: z
      .record(z.string())
      .optional()
      .describe(
        "Pre-resolved values for all 'org_config' params from interpretation_configs. " +
        "Keys are source_field names (e.g. 'min_points_per_path'). " +
        "Use these directly — do not query interpretation_configs yourself."
      ),
    error: z.string().optional(),
  }),
  execute: async (context) => {
    const { integrationId, orgId } = context;
    const supabase = getSupabase();

    // ── 1. Look up approved transform template ─────────────────────────────────
    // Prefer org-specific templates over global (org_id IS NULL) ones.
    // Within each scope, take the most recently updated version.
    const { data: templates, error: templateError } = await supabase
      .from("code_templates")
      .select("id, name, parameters, org_id")
      .eq("integration_type", integrationId)
      .eq("approval_status", "approved")
      .contains("tags", ["transformation"])
      .order("approved_at", { ascending: false });

    if (templateError) {
      return {
        found: false,
        error: `Template lookup failed: ${templateError.message}`,
      };
    }

    if (!templates || templates.length === 0) {
      return {
        found: false,
        error: `No approved transformation template found for integration type '${integrationId}'.`,
      };
    }

    // Prefer org-specific template over a global seed
    const template =
      templates.find((t) => t.org_id === orgId) ?? templates[0];

    // Parse parameter schema — tolerate malformed JSONB gracefully
    let parameters: z.infer<typeof parameterSchema>[] = [];
    if (template.parameters) {
      try {
        const raw = Array.isArray(template.parameters)
          ? template.parameters
          : JSON.parse(template.parameters as string);
        parameters = raw
          .map((p: unknown) => {
            const parsed = parameterSchema.safeParse(p);
            return parsed.success ? parsed.data : null;
          })
          .filter(Boolean) as z.infer<typeof parameterSchema>[];
      } catch {
        // Parameters unreadable — return template but with empty params.
        // executeTransform will fail at validation if required params are missing.
      }
    }

    // ── 2. Resolve org_config params from interpretation_configs ───────────────
    const orgConfigParams = parameters.filter((p) => p.source === "org_config");
    const resolvedOrgConfig: Record<string, string> = {};

    if (orgConfigParams.length > 0) {
      const keys = orgConfigParams
        .map((p) => p.source_field)
        .filter(Boolean) as string[];

      const { data: configs } = await supabase
        .from("interpretation_configs")
        .select("key, value")
        .eq("org_id", orgId)
        .eq("integration_type", integrationId)
        .in("key", keys);

      for (const row of configs ?? []) {
        resolvedOrgConfig[row.key] = row.value;
      }

      // Fill in schema defaults for any keys not yet configured
      for (const param of orgConfigParams) {
        const field = param.source_field;
        if (field && !(field in resolvedOrgConfig) && param.default !== undefined) {
          resolvedOrgConfig[field] = String(param.default);
        }
      }
    }

    return {
      found: true,
      templateId: template.id as string,
      templateName: template.name as string,
      parameters,
      resolvedOrgConfig,
    };
  },
});
