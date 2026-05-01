# Skill: Write Analysis Code

## Purpose

Translate the user's natural language question into Python code, execute it in the E2B sandbox, and return a valid output envelope. All analysis code must follow the Output Contract exactly.

---

## When to Use

Whenever the user asks an analytical question about the current dataset:
- "How many unique paths are in this file?"
- "Show me the path trajectories"
- "What's the distribution of dwell times?"
- "Which paths are likely ghosts?"

---

## Procedure

### Step 1: Check available templates

Call `getSessionContext` and inspect `available_templates`. If an approved template matches the user's question, use it — fill in parameters, do not rewrite.

Template match heuristics:
- "path summary" / "per-path stats" / "dwell time" → `path-aggregation.py`
- "trajectory" / "path plot" / "where did they go" → `path-trajectory-plot.py`
- "position over time" / "x over time" / "y over time" → `position-over-time.py`
- "summary stats" / "sensor performance" / "distribution" → `summary-statistics.py`
- Any template name in `available_templates` that matches the intent → use it

If using a template, say so: "I'll use the path-aggregation template we've approved. Filling in parameters for this dataset..."

### Step 2: Incorporate existing beliefs as hypotheses

Load approved beliefs from `getSessionContext`. When writing analysis code that could test an existing belief, encode it explicitly:

```python
# Hypothesis from approved belief (confidence 0.72):
# Ghost paths have dwell_seconds < 3 AND positional_std < 0.15m
GHOST_DWELL_THRESHOLD = 3.0
GHOST_POSITION_STD_THRESHOLD = 0.15
```

This makes the analysis a test of the hypothesis, not just a description of the data. The interpretation step can then confirm, contradict, or refine the belief.

### Step 3: Write the code

All code must:
1. Load data from `/sandbox/upload.csv` using pandas
2. Perform the requested analysis
3. Produce one or more artifacts (chart, table, or text)
4. Print a valid JSON output envelope as the **final line** of the script

**Output envelope rules** (see `knowledge/output-contract.md`):
- Every script prints exactly one JSON object as its final stdout line
- The object must have `type`, `title`, `summary`, and either `html` (for charts) or `data` (for tables/text)
- For `multi` type, use an `artifacts` array
- `summary` must be a plain-language description the agent can read to interpret the result

**Chart code pattern (Plotly.js):**

```python
import pandas as pd
import json

df = pd.read_csv('/sandbox/upload.csv')

# ... analysis ...

# Build Plotly figure spec
fig = {
    "data": [...],   # Plotly trace objects
    "layout": {
        "title": "Chart Title",
        "xaxis": {"title": "X Label"},
        "yaxis": {"title": "Y Label"},
        "height": 450
    }
}

html = f"""
<div id="plotly-chart" style="width:100%;height:450px"></div>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<script>
  Plotly.newPlot('plotly-chart', {json.dumps(fig['data'])}, {json.dumps(fig['layout'])});
</script>
"""

summary = "Plain-language description of what this chart shows and key values to note."

print(json.dumps({
    "type": "chart",
    "title": "Chart Title",
    "html": html,
    "data": fig,
    "summary": summary
}))
```

**Table code pattern:**

```python
print(json.dumps({
    "type": "table",
    "title": "Table Title",
    "data": df_result.to_dict(orient='records'),
    "columns": list(df_result.columns),
    "summary": "Plain-language description of what this table shows."
}))
```

**Multi-artifact pattern (chart + table together):**

```python
print(json.dumps({
    "type": "multi",
    "title": "Analysis Title",
    "artifacts": [chart_envelope, table_envelope],
    "summary": "Combined summary of what was produced."
}))
```

### Step 4: Execute and parse

Call `executeCode` tool with the script. The tool returns:
```json
{
  "stdout": "...",
  "stderr": "...",
  "envelope": { ... }   // parsed from final JSON line of stdout
}
```

If `stderr` is non-empty, debug before surfacing to the user. Common issues:
- Import errors → add to pip install block at top of script
- KeyError on column names → check against approved data dictionary
- Empty dataframe after filter → adjust filter logic, report to user

### Step 5: Surface the artifact

Return `envelope.html` to the frontend to render. Do not describe the chart before the user has seen it.

After the chart renders, invoke `interpret-artifact` skill.

---

## Code Quality Rules

- Always filter for the relevant time window if one is established in the session context
- Use `log_creation_time` for time-based operations, not `processed_at`
- Group by `target_id` to derive path-level metrics; never treat individual rows as paths
- When plotting multiple targets, use distinct colors per `target_id` — assign via `px.colors.qualitative.Plotly` or similar
- Round float outputs to 2 decimal places in tables
- Include row counts and time window in every summary string

---

## Pip Install Pattern

If a library beyond pandas/json/datetime is needed, add this block at the top of the script:

```python
import subprocess
subprocess.run(['pip', 'install', 'plotly', '--quiet'], check=True)
import plotly.express as px
```

Preferred libraries: `pandas`, `numpy`, `plotly`, `scipy`. Avoid matplotlib (we use Plotly for all charts).
