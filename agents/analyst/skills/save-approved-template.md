# Skill: Save Approved Template

## Purpose

Package a piece of analysis code that has been used and found useful into a reusable, parameterized template. Saved templates are stored in Supabase and available to all future sessions — the agent uses them instead of rewriting equivalent code.

---

## When to Use

Trigger this skill when:
- The user says "save this," "remember how to do this," or "let's reuse this"
- The agent notices it just wrote code that solves a problem it has solved before (de-duplication)
- An analysis produces a clean, generalizable result and the user reacts positively ("this is exactly what I needed")
- A classification algorithm (e.g., ghost classifier) is tested and shows acceptable performance

Do **not** propose saving every analysis. Only code that would be useful on a future dataset with a different CSV belongs in templates. Highly specific one-off queries don't qualify.

---

## Template Quality Criteria

Good template candidates:
- Solve a recurring analytical question (path summary, trajectory visualization, distribution analysis)
- Are parameterized — the column names, thresholds, or time windows are variables, not hardcoded
- Produce a valid output envelope (chart, table, or text) per the Output Contract
- Have been executed successfully at least once in this session

Poor candidates:
- Hardcoded to specific `target_id` values or a specific time window
- Produce raw print statements instead of a structured output envelope
- Too complex to be understood without deep session context

---

## Procedure

### Step 1: Retrieve the code from the session

Identify the code block from the current session that the user wants to save. If unclear, ask: "Which analysis should I package — the path summary table, the trajectory plot, or both?"

### Step 2: Parameterize it

Replace hardcoded values with `{{PLACEHOLDER}}` tokens that the agent fills in when calling the template:
- Specific column names that might vary → `{{TARGET_ID_COLUMN}}`, `{{X_COLUMN}}`, `{{Y_COLUMN}}`
- Time window filters → `{{START_TIME}}`, `{{END_TIME}}`
- Classification thresholds → `{{DWELL_THRESHOLD_SECONDS}}`, `{{POSITION_STD_THRESHOLD_M}}`
- Chart titles → `{{CHART_TITLE}}`

Show the parameterized version to the user before saving.

### Step 3: Draft the template record

```
Name:        [short slug: path-aggregation, ghost-classifier-v2, etc.]
Description: [One sentence: what question does this answer?]
Tags:        [path-summary | trajectory | classification | distribution | sensor-stats]
Parameters:  [List of {{PLACEHOLDER}} tokens with descriptions]
Code:        [Full parameterized Python script]
Version:     [v1 for new; increment for updates to an existing template]
```

### Step 4: Surface for approval

Present the template record:

> "Here's what I'll save:
>
> **Name**: `ghost-classifier-v1`
> **Description**: Classifies paths as ghost, passer-by, or engaged using dwell time and positional standard deviation thresholds.
> **Parameters**: `DWELL_GHOST_MAX` (seconds), `POS_STD_MAX` (meters), `DWELL_ENGAGED_MIN` (seconds)
>
> Should I save this? You can also suggest a better name or adjust the description."

Wait for explicit approval.

### Step 5: Save on approval

Call `saveCodeTemplate` tool with the structured template. Confirm: "Saved as `ghost-classifier-v1`. I'll use this as the starting point for path classification in future sessions."

If a template with this name already exists in Supabase, propose an incremented version: "A `ghost-classifier-v1` already exists. Should I save this as `ghost-classifier-v2` and preserve the original?"

---

## Template Naming Conventions

- Use kebab-case
- Include version suffix when logic evolves: `ghost-classifier-v1`, `ghost-classifier-v2`
- Be descriptive: `path-dwell-distribution` not `analysis-1`
- Prefix by category: `plot-*` for visualizations, `classify-*` for classifiers, `aggregate-*` for summarization

---

## Template Evolution

When a saved template is used in a future session and the user improves the logic:
1. The improved version is tested and confirmed
2. This skill is triggered again
3. The new version is saved with an incremented version number
4. The prior version is preserved (not overwritten) — it's a historical record
5. A belief should be proposed that describes what changed and why (`Algorithm Version` type)

The progression `ghost-classifier-v1 → v2 → v3` with corresponding beliefs is the system learning.
