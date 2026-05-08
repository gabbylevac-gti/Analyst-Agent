/**
 * Analyst Agent
 *
 * A conversational data analysis agent that accepts CSV uploads,
 * answers natural language questions by writing and executing Python code,
 * produces interactive Plotly.js visualizations, and compounds knowledge
 * across sessions via an explicit belief + template learning loop.
 *
 * @see agents/analyst/instructions.md
 */

import { Agent } from "@mastra/core/agent";
import type { CoreSystemMessage } from "@mastra/core/llm";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { executeCodeTool } from "../tools/executeCode";
import { getSessionContextTool } from "../tools/getSessionContext";
import { readKnowledgeTool } from "../tools/readKnowledge";
import { writeBeliefTool } from "../tools/writeBelief";
import { saveCodeTemplateTool } from "../tools/saveCodeTemplate";
import { saveDataDictionaryTool } from "../tools/saveDataDictionary";
import { setSessionNameTool } from "../tools/setSessionName";
import { fetchSensorDataTool } from "../tools/fetchSensorData";
import { uploadDatasetTool } from "../tools/uploadDataset";
import {
  INSTRUCTIONS,
  OUTPUT_CONTRACT,
  DOMAIN_RADAR_SENSORS,
  DOMAIN_PATH_CLASSIFICATION,
  DOMAIN_RETAIL_CONTEXT,
  DOMAIN_DR6000_SCHEMA,
  SEED_BELIEFS,
} from "../embedded-knowledge";

// ─── Instructions assembly ────────────────────────────────────────────────────
// Domain knowledge is bundled into the system prompt so it is:
//   (a) cached by Anthropic prompt caching — not re-billed on every turn
//   (b) NOT duplicated in getSessionContext tool results, which saves ~5k tokens
//       per session from accumulating in the conversation context window.

const instructionsText = [
  INSTRUCTIONS,
  "---",
  "## Output Contract",
  OUTPUT_CONTRACT,
  "---",
  "## Domain Knowledge",
  DOMAIN_RADAR_SENSORS,
  "---",
  DOMAIN_PATH_CLASSIFICATION,
  "---",
  DOMAIN_RETAIL_CONTEXT,
  "---",
  DOMAIN_DR6000_SCHEMA,
  "---",
  SEED_BELIEFS,
].join("\n\n");

// Static block — cached by Anthropic so repeated requests don't re-count all
// instruction tokens. Content never changes, so cache always hits.
const staticInstructions: CoreSystemMessage = {
  role: "system",
  content: instructionsText,
  providerOptions: {
    anthropic: { cacheControl: { type: "ephemeral" } },
  },
};

// Dynamic block — injected per request with session context from the verified
// request context (set by the edge function or Studio Variables panel).
// Small enough that it doesn't meaningfully affect token cost.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildInstructions(requestContext: any): CoreSystemMessage[] {
  const sessionId = requestContext.get("sessionId") as string | undefined;
  const orgId = requestContext.get("orgId") as string | undefined;
  if (!sessionId && !orgId) return [staticInstructions];
  const lines = ["## Active Session Context"];
  if (sessionId) lines.push(`- sessionId: ${sessionId}`);
  if (orgId) lines.push(`- orgId: ${orgId}`);
  lines.push(
    "\nWhen calling `getSessionContext`, always pass the sessionId above. " +
    "Never use \"current\" or any other placeholder."
  );
  const dynamic: CoreSystemMessage = { role: "system", content: lines.join("\n") };
  return [staticInstructions, dynamic];
}

// ─── Agent ─────────────────────────────────────────────────────────────────────

export const analystAgent = new Agent({
  id: "analyst",
  name: "analyst",
  instructions: ({ requestContext }) => buildInstructions(requestContext),
  model: anthropic("claude-sonnet-4-6"),
  requestContextSchema: z.object({
    sessionId: z.string().optional().describe("Current session ID"),
    orgId: z.string().optional().describe("Organization ID"),
    userId: z.string().optional().describe("Authenticated user ID"),
  }),
  tools: {
    executeCode: executeCodeTool,
    getSessionContext: getSessionContextTool,
    readKnowledge: readKnowledgeTool,
    writeBelief: writeBeliefTool,
    saveCodeTemplate: saveCodeTemplateTool,
    saveDataDictionary: saveDataDictionaryTool,
    setSessionName: setSessionNameTool,
    fetchSensorData: fetchSensorDataTool,
    uploadDataset: uploadDatasetTool,
  },
});
