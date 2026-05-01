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
import { anthropic } from "@ai-sdk/anthropic";
import { executeCodeTool } from "../tools/executeCode";
import { getSessionContextTool } from "../tools/getSessionContext";
import { readKnowledgeTool } from "../tools/readKnowledge";
import { writeBeliefTool } from "../tools/writeBelief";
import { saveCodeTemplateTool } from "../tools/saveCodeTemplate";
import {
  INSTRUCTIONS,
  SKILL_DRAFT_DATA_DICTIONARY,
  SKILL_WRITE_ANALYSIS_CODE,
  SKILL_INTERPRET_ARTIFACT,
  SKILL_EXTRACT_BELIEF,
  SKILL_SAVE_APPROVED_TEMPLATE,
  SKILL_SUMMARIZE_SESSION,
  OUTPUT_CONTRACT,
} from "../embedded-knowledge";

// ─── Instructions assembly ────────────────────────────────────────────────────

// All content is embedded as TypeScript string constants (see embedded-knowledge.ts)
// so that esbuild bundles them into the .mjs artifact on Mastra Platform.
// No filesystem reads at runtime — the container does not include source .md files.

const fullInstructions = [
  INSTRUCTIONS,
  "\n\n---\n\n## Skills\n\n",
  SKILL_DRAFT_DATA_DICTIONARY,
  SKILL_WRITE_ANALYSIS_CODE,
  SKILL_INTERPRET_ARTIFACT,
  SKILL_EXTRACT_BELIEF,
  SKILL_SAVE_APPROVED_TEMPLATE,
  SKILL_SUMMARIZE_SESSION,
  "\n\n---\n\n## Output Contract\n\n",
  OUTPUT_CONTRACT,
].join("\n\n---\n\n");

// ─── Agent ─────────────────────────────────────────────────────────────────────

export const analystAgent = new Agent({
  name: "analyst",
  instructions: fullInstructions,
  model: anthropic("claude-sonnet-4-6"),
  tools: {
    executeCode: executeCodeTool,
    getSessionContext: getSessionContextTool,
    readKnowledge: readKnowledgeTool,
    writeBelief: writeBeliefTool,
    saveCodeTemplate: saveCodeTemplateTool,
  },
});
