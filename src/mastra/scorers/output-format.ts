import { createScorer } from "@mastra/core/evals";

// Checks that when the agent executed code, it produced and interpreted an artifact.
// Score 1.0 = executeCode called + text interpretation provided.
// Score 0.5 = no executeCode (neutral — analysis may not have been needed).
// Score 0.0 = executeCode called but no interpretation followed.

export const outputFormatScorer = createScorer({
  id: "output-format",
  description:
    "Verifies the agent ran executeCode for analysis tasks and provided a substantive interpretation of the artifact, not just a raw tool result.",
  type: "agent",
})
  .generateScore(({ run }) => {
    const output: any[] = run.output ?? [];

    const allParts = output.flatMap((msg: any) => msg.parts ?? []);
    const toolInvocations = allParts.filter(
      (p: any) => p.type === "tool-invocation"
    );
    const executeCodeCalls = toolInvocations.filter(
      (p: any) => p.toolInvocation?.toolName === "executeCode"
    );

    if (executeCodeCalls.length === 0) return 0.5;

    const substantiveText = allParts.filter(
      (p: any) => p.type === "text" && (p.text?.length ?? 0) > 80
    );

    return substantiveText.length > 0 ? 1.0 : 0.0;
  })
  .generateReason(({ run, score }) => {
    const output: any[] = run.output ?? [];
    const allParts = output.flatMap((msg: any) => msg.parts ?? []);
    const executeCodeCalls = allParts.filter(
      (p: any) =>
        p.type === "tool-invocation" &&
        p.toolInvocation?.toolName === "executeCode"
    );

    if (score === 1.0)
      return `executeCode called ${executeCodeCalls.length} time(s); substantive interpretation present.`;
    if (score === 0.5)
      return "No executeCode call — analysis may not have been required for this turn.";
    return "executeCode was called but no substantive text interpretation followed.";
  });
