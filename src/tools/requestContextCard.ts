import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const contextFieldEnum = z.enum(["endpointId", "storeHours", "category", "knownInterference"]);

export const requestContextCardTool = createTool({
  id: "request-context-card",
  description:
    "Request deployment context from the user via a structured in-chat card. " +
    "Use trigger='csv-upload' immediately after updateSession(active_dataset_id: ...) — always include 'endpointId' in requiredFields. " +
    "Use trigger='template-requirements' before executeTransform when a template placeholder value is null — " +
    "list only the missing context fields in requiredFields (e.g. ['storeHours']). " +
    "Do NOT call this if all context is already present (endpointCategory non-null, storeHours non-null, endpointKnownInterference non-null). " +
    "After the user fills the card they send a [Context set] message — extract values from it and proceed without asking text questions.",
  inputSchema: z.object({
    sessionId: z.string().describe("Current session ID"),
    orgId: z.string().describe("Organization ID — used to load endpoint and store options in the card"),
    trigger: z.enum(["csv-upload", "template-requirements"]).describe(
      "csv-upload: user uploaded a CSV and needs to associate an endpoint. " +
      "template-requirements: a transform template requires null context values before it can run."
    ),
    requiredFields: z.array(contextFieldEnum).describe(
      "Fields the agent needs before proceeding — Apply button is disabled until these are filled. " +
      "For csv-upload: always ['endpointId']. For template-requirements: e.g. ['storeHours']."
    ),
    optionalFields: z.array(contextFieldEnum).optional().describe(
      "Fields the template uses if available — shown in the card but not required for Apply."
    ),
    templateName: z.string().optional().describe(
      "For template-requirements trigger: the template being prepared (e.g. 'dr6000-transform-v1')."
    ),
  }),
  outputSchema: z.object({
    cardType: z.literal("context-card"),
    sessionId: z.string(),
    orgId: z.string(),
    trigger: z.string(),
    requiredFields: z.array(z.string()),
    optionalFields: z.array(z.string()),
    templateName: z.string().optional(),
    status: z.literal("pending"),
  }),
  execute: async (context) => ({
    cardType: "context-card" as const,
    sessionId: context.sessionId,
    orgId: context.orgId,
    trigger: context.trigger,
    requiredFields: context.requiredFields,
    optionalFields: context.optionalFields ?? [],
    templateName: context.templateName,
    status: "pending" as const,
  }),
});
