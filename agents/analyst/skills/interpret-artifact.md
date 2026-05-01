# Skill: Interpret Artifact

## Purpose

After an artifact is produced and rendered, provide a narrative interpretation that helps the user understand what the data is saying. Interpretation is based on the artifact's `data` and `summary` fields — never the visual alone. Reference approved beliefs, flag anomalies, and invite discussion.

---

## When to Use

Immediately after `executeCode` returns a valid envelope and the artifact is surfaced to the user. Do not wait for the user to ask "what does this mean?" — offer interpretation proactively, but keep it concise. Leave room for dialogue.

---

## Procedure

### Step 1: Read the envelope

The artifact envelope contains:
- `summary` — plain-language description of what was computed (written by the analysis code)
- `data` — the underlying dataset or Plotly figure spec (structured, readable by you)
- `title` — the artifact's title

Read both `summary` and `data`. The `summary` is your starting point; `data` lets you go deeper.

### Step 2: Reference existing beliefs

Check whether any approved beliefs apply to what you're seeing. If they do, explicitly test them:

- **Belief confirmed**: "Our belief that ghost paths have dwell < 3s holds here — 73% of paths under 3 seconds are in the cluster we'd expect to flag."
- **Belief challenged**: "Interesting — we have a cluster of paths with dwell < 3s that show substantial movement (std > 0.3m), which contradicts our current ghost signature. Worth noting."
- **No relevant belief**: Proceed without referencing the knowledge graph.

Always frame beliefs as hypotheses being tested, not established facts.

### Step 3: Identify the most important 2–3 observations

Do not narrate every data point. Pick the observations that are:
1. Directly relevant to the session's stated objective
2. Surprising, anomalous, or worth investigation
3. Actionable — something the user can do with this information

Structure as: observation → what it means → implication or question.

**Example (path trajectory plot):**
> "Most paths cluster in the y = 1.8–2.0m band with very little x movement — these are the stationary detections we'd expect to investigate as ghosts. There are 4 paths that show clear linear movement across the full x range, which look like genuine walk-throughs. The outlier at (-1.1, 1.3) appears briefly and may be a reflection artifact — worth checking against the session's known noise patterns."

**Example (dwell time distribution):**
> "The distribution is heavily right-skewed with a median of 2.1s and a long tail up to 47s. The spike at 0–2s accounts for 61% of paths — consistent with our ghost hypothesis threshold. The 8 paths above 20s are strong engagement candidates. There's a small cluster at 8–12s that doesn't fit cleanly into either category; these might be passer-bys who slowed."

### Step 4: Invite discussion

End with an open question that advances the session objective. Not "Does that help?" but a specific prompt:

- "Want me to filter down to just the sub-3-second paths and look at their positional variance?"
- "Should we compare this to the prior session's distribution to see if the pattern is consistent?"
- "This 8–12s cluster is interesting — want to plot their trajectories individually?"

### Step 5: Listen for belief candidates

As the user responds, listen for:
- Generalizable claims ("I've seen this in other datasets too")
- Confirmations of existing hypotheses
- New pattern descriptions the user articulates
- Decisions about thresholds or classification rules

When you hear one, note it mentally. After the discussion concludes naturally, trigger `extract-belief`.

---

## Tone

- Direct. State what you see.
- Calibrated. Distinguish between "this is clear" (high confidence) and "this might be" (lower confidence).
- Specific. Reference actual values from `data`, not vague descriptors like "most paths."
- Curious. Frame observations as things worth investigating, not conclusions.

---

## Multi-Artifact Interpretation

When the envelope is `type: multi`, interpret the artifacts together — they were produced as a set for a reason. Lead with the most important finding, then reference how the other artifacts support or complicate it.

---

## What Not to Do

- Do not describe the visual aesthetics of the chart ("the blue line goes up"). Reason about the data values.
- Do not state conclusions with more confidence than the data warrants.
- Do not reference beliefs that are not loaded in the current session context — you can only apply what has been approved.
- Do not suggest "saving this as a belief" in the same message as the interpretation. Let the discussion unfold first.
