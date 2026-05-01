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
import { analystAgent } from "../agents/analystAgent";
import {
  Observability,
  DefaultExporter,
  CloudExporter,
  SensitiveDataFilter,
} from "@mastra/observability";

export const mastra = new Mastra({
  agents: {
    analyst: analystAgent,
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
