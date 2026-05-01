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

import { Agent } from "@mastra/core";
import { anthropic } from "@ai-sdk/anthropic";
import * as fs from "fs";
import * as path from "path";
import { executeCodeTool } from "../tools/executeCode";
import { getSessionContextTool } from "../tools/getSessionContext";
import { readKnowledgeTool } from "../tools/readKnowledge";
import { writeBeliefTool } from "../tools/writeBelief";
import { saveCodeTemplateTool } from "../tools/saveCodeTemplate";

// ─── Instruction loader ────────────────────────────────────────────────────────

function loadFile(relPath: string): string {
  return fs.existsSync(relPath)
    ? fs.readFileSync(relPath, "utf-8")
    : `[Not found: ${relPath}]`;
}

const instructions = loadFile(path.join("agents", "analyst", "instructions.md"));

const skills = [
  "draft-data-dictionary.md",
  "write-analysis-code.md",
  "interpret-artifact.md",
  "extract-belief.md",
  "save-approved-template.md",
  "summarize-session.md",
].map((s) => loadFile(path.join("agents", "analyst", "skills", s)));

// Output contract is injected directly so the agent always has it available
// without needing a tool call — it's needed before every code execution.
const outputContract = loadFile(path.join("knowledge", "output-contract.md"));

const fullInstructions = [
  instructions,
  "\n\n---\n\n## Skills\n\n",
  ...skills,
  "\n\n---\n\n## Output Contract\n\n",
  outputContract,
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
