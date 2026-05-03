import { createScorer } from "@mastra/core/evals";

// Checks that the agent follows the required tool-use discipline:
// - getSessionContext is called at session start (present in input or output)
// - executeCode is used for analysis (never fabricated)
// - writeBelief is never called with pendingApproval: false
//
// Score is an average across the three checks that apply to this turn.

function getToolCalls(messages: any[]): { name: string; args: any }[] {
  return messages
    .flatMap((msg: any) => msg.parts ?? [])
    .filter((p: any) => p.type === "tool-invocation")
    .map((p: any) => ({
      name: p.toolInvocation?.toolName ?? "",
      args: p.toolInvocation?.args ?? {},
    }));
}

export const toolDisciplineScorer = createScorer({
  id: "tool-discipline",
  description:
    "Checks that the agent used getSessionContext at session start, relied on executeCode for analysis, and did not bypass the belief approval gate.",
  type: "agent",
})
  .generateScore(({ run }) => {
    const inputMessages: any[] = run.input?.inputMessages ?? [];
    const output: any[] = run.output ?? [];

    const inputTools = getToolCalls(inputMessages);
    const outputTools = getToolCalls(output);
    const allTools = [...inputTools, ...outputTools];

    const scores: number[] = [];

    // Check 1: getSessionContext was called (in input context or output)
    const hasSessionContext = allTools.some(
      (t) => t.name === "getSessionContext"
    );
    scores.push(hasSessionContext ? 1.0 : 0.0);

    // Check 2: if analysis output present, executeCode must have been called
    const hasAnalysisText = output
      .flatMap((msg: any) => msg.parts ?? [])
      .some((p: any) => p.type === "text" && (p.text ?? "").includes("```"));
    if (hasAnalysisText) {
      const hasExecuteCode = outputTools.some((t) => t.name === "executeCode");
      scores.push(hasExecuteCode ? 1.0 : 0.0);
    }

    // Check 3: writeBelief must always have pendingApproval: true
    const beliefWrites = outputTools.filter((t) => t.name === "writeBelief");
    if (beliefWrites.length > 0) {
      const allPending = beliefWrites.every(
        (t) => t.args?.pendingApproval === true
      );
      scores.push(allPending ? 1.0 : 0.0);
    }

    if (scores.length === 0) return 1.0;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  })
  .generateReason(({ run, score }) => {
    const inputMessages: any[] = run.input?.inputMessages ?? [];
    const output: any[] = run.output ?? [];
    const allTools = [
      ...getToolCalls(inputMessages),
      ...getToolCalls(output),
    ];

    const issues: string[] = [];
    const passes: string[] = [];

    if (allTools.some((t) => t.name === "getSessionContext")) {
      passes.push("getSessionContext called");
    } else {
      issues.push("getSessionContext not found");
    }

    const beliefWrites = getToolCalls(output).filter(
      (t) => t.name === "writeBelief"
    );
    if (beliefWrites.length > 0) {
      const unapproved = beliefWrites.filter(
        (t) => t.args?.pendingApproval !== true
      );
      if (unapproved.length > 0) {
        issues.push(
          `${unapproved.length} writeBelief call(s) missing pendingApproval`
        );
      } else {
        passes.push("all writeBelief calls had pendingApproval: true");
      }
    }

    const parts = [
      passes.length > 0 ? `Passed: ${passes.join(", ")}.` : "",
      issues.length > 0 ? `Issues: ${issues.join("; ")}.` : "",
    ].filter(Boolean);

    return parts.join(" ") || `Score ${score.toFixed(2)} — no relevant tool calls in this turn.`;
  });
