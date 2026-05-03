/**
 * Analyst Agent — Mastra Entry Point
 *
 * Registers the Analyst agent with Mastra.
 * No workflows — this is a pure conversational agent.
 *
 * Dev server:  npx mastra dev   → http://localhost:4111
 * Deploy:      mastra server deploy
 *
 * @see ANALYST-IMPORT-GUIDE.md
 */

import { Mastra } from "@mastra/core";
import { MastraEditor } from "@mastra/editor";
import { analystAgent } from "../agents/analystAgent";
import {
  Observability,
  DefaultExporter,
  CloudExporter,
  SensitiveDataFilter,
} from "@mastra/observability";
import {
  outputFormatScorer,
  toolDisciplineScorer,
  beliefGateScorer,
} from "./scorers";

export const mastra = new Mastra({
  agents: {
    analyst: analystAgent,
  },
  editor: new MastraEditor(),
  scorers: {
    outputFormat: outputFormatScorer,
    toolDiscipline: toolDisciplineScorer,
    beliefGate: beliefGateScorer,
  },
  observability: new Observability({
    configs: {
      default: {
        serviceName: "analyst-agent",
        exporters: [new DefaultExporter(), new CloudExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
