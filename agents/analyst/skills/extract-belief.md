# Skill: Extract Belief

## Purpose

When a generalizable insight emerges from a session discussion, surface it as a structured belief for the user to approve. Approved beliefs are written to Supabase and loaded in all future sessions. They become the hypotheses that future analysis code tests.

---

## When to Use

Trigger this skill when:
- The user makes a claim that applies beyond this specific dataset ("ghost paths always seem to cluster in the early morning")
- An analysis confirms or contradicts an existing belief with new evidence
- A classification threshold is established through testing ("under 3 seconds is the right cutoff")
- The user explicitly says "remember this" or "that's a pattern"
- A discussion produces a repeatable rule the agent should carry forward

Do **not** trigger after every analysis. Wait for the discussion to produce something genuinely generalizable. Ephemeral observations about a specific file don't qualify.

---

## Belief Categories

**Take-Away** — an observation about this dataset or this deployment that may generalize. Moderate confidence. "In this deployment, the sensor's y-axis runs from the entrance wall (y=0) toward the product display (y=3m)."

**Belief** — a confirmed pattern that holds across multiple sessions or datasets. High confidence. "Ghost paths in retail radar deployments consistently have dwell_seconds < 3 AND positional_std_x < 0.15m."

**False-Belief** — something we thought was true but evidence contradicts. Records what was wrong and why. "Initial hypothesis that time-of-day alone predicts ghost paths was not supported — noise occurs at all hours near sensor 001."

**Algorithm Version** — an approved classification function with defined logic and known performance. "ghost_classifier_v2: dwell < 3s AND pos_std < 0.15m AND not within 10 minutes of session start. Precision 0.81, Recall 0.74 on test set from session 2026-04-14."

---

## Procedure

### Step 1: Formulate the belief draft

Structure the belief as:
```
Content:    [The claim in plain language]
Type:       [Take-Away | Belief | False-Belief | Algorithm Version]
Confidence: [0.0–1.0]
Evidence:   [What in this session supports it — reference artifact title + session ID]
Tags:       [ghost-detection | path-classification | sensor-behavior | coordinate-system | etc.]
```

**Confidence guidelines:**
- 0.90+: Multiple sessions confirm; quantitative evidence strong
- 0.70–0.89: Single session with clear evidence; directionally consistent with prior beliefs
- 0.50–0.69: Plausible but limited evidence; flag as preliminary — propose without asking for approval, store as `pending` type
- Below 0.50: Not worth storing yet; continue gathering evidence

### Step 2: Check for existing beliefs to update

Call `readKnowledge` with relevant tags. If a related belief already exists:
- If new evidence **supports** it: propose a confidence upgrade ("We have more evidence for this — I'd like to increase its confidence from 0.72 to 0.81")
- If new evidence **contradicts** it: propose a revision or false-belief ("This challenges our current belief. Should we revise it or record a counterpoint?")
- If it's **new ground**: proceed to proposal

Do not create duplicate beliefs. Update existing ones.

### Step 3: Surface one belief at a time

Present the belief draft clearly:

> "Based on our analysis today, I'd like to record the following belief:
>
> **Claim**: Ghost paths in retail radar deployments consistently have dwell < 3 seconds and positional standard deviation < 0.15m in both axes.
> **Confidence**: 0.78 — supported by today's dataset (61% of sub-3s paths fit this profile) and consistent with our session from April 14.
> **Tags**: ghost-detection, path-classification
>
> Shall I save this to the knowledge graph?"

Wait for explicit approval before calling `writeBelief`. Accept "yes," "save it," "approved," or similar. Treat silence or "maybe later" as a deferral — do not write.

### Step 4: Handle the response

**Approved**: Call `writeBelief` with the structured belief. Confirm: "Saved. This will be available as a working hypothesis in all future sessions."

**Edited**: Incorporate the user's edits, re-present the revised belief, ask for confirmation again.

**Rejected**: Note the reason if given ("this was specific to this dataset, not general"). Do not store. Move on.

**Pending (confidence 0.50–0.69)**: Store automatically in Supabase as `type: pending` without asking for approval. Mention it briefly: "I've flagged this as a preliminary observation — we'll revisit it when we have more evidence."

### Step 5: Queue remaining beliefs

If multiple beliefs emerged from the discussion, queue them and surface one at a time. After the first is resolved: "There's one more pattern worth capturing. Ready?"

---

## What Makes a Good Belief

A good belief is:
- **Generalizable**: applies beyond this specific file or session
- **Testable**: can be confirmed or contradicted by future analysis
- **Specific**: includes concrete thresholds or conditions, not vague descriptors
- **Earned**: backed by evidence from actual analysis, not speculation

A bad belief is:
- "This dataset has 873 paths" — too specific, not generalizable
- "Ghost paths are weird" — too vague, not testable
- "The sensor seems to have issues" — speculation without evidence
