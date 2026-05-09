# Output Contract

## Purpose

Every Python script executed in the E2B sandbox must emit exactly one JSON object as its final `stdout` line. This contract defines the shape of that object. Both the agent (for interpretation) and the frontend (for rendering) depend on it.

Violating this contract means the artifact cannot be rendered or interpreted. The agent must not execute a script it knows will not produce a valid envelope.

---

## Envelope Types

### `chart` — Interactive Plotly visualization

```json
{
  "type": "chart",
  "title": "Human-readable chart title",
  "html": "<div id='plotly-chart'>...</div><script>Plotly.newPlot(...)</script>",
  "data": { "data": [...], "layout": {...} },
  "summary": "Plain-language description of what this chart shows, including key values."
}
```

- `html`: Self-contained HTML fragment. Must load Plotly from CDN. Must use a unique element ID (use `plotly-{uuid}` pattern to avoid collisions in multi-artifact sessions).
- `data`: The full Plotly figure spec (traces + layout). This is what the agent reads to interpret the chart.
- `summary`: A plain-language description written by the analysis code author — not generic. Should include the key numerical observations the agent will build interpretation from.

### `table` — Structured data table

```json
{
  "type": "table",
  "title": "Human-readable table title",
  "data": [{ "col1": "val", "col2": "val" }, ...],
  "columns": ["col1", "col2"],
  "summary": "Plain-language description of what this table contains and what stands out."
}
```

- `data`: Array of row objects. Max 500 rows in a single table envelope — paginate or aggregate if larger.
- `columns`: Explicit column ordering for frontend rendering.
- `summary`: Highlight the most important rows or values (e.g., "Sorted by dwell_seconds descending. Top 5 paths have dwell > 30s.").

### `text` — Narrative or statistical summary

```json
{
  "type": "text",
  "title": "Summary title",
  "content": "Multi-line plain text or markdown content.",
  "summary": "One-sentence description of what this text contains."
}
```

- Use for statistical summaries, schema inspection results, error messages, or narrative outputs.
- `content` may contain markdown (the frontend renders it).

### `multi` — Multiple artifacts from one analysis

```json
{
  "type": "multi",
  "title": "Analysis title",
  "artifacts": [
    { ...chart_envelope... },
    { ...table_envelope... }
  ],
  "summary": "Combined summary of all artifacts produced."
}
```

- Use when a single question produces both a chart and a supporting table.
- Each item in `artifacts` must itself be a valid `chart`, `table`, or `text` envelope.
- The `summary` at the top level should synthesize across all artifacts, not just restate each one's summary.

---

## Plotly HTML Template

Every chart envelope's `html` field must follow this pattern exactly:

```python
import uuid
chart_id = f"plotly-{uuid.uuid4().hex[:8]}"

html = f"""
<div id="{chart_id}" style="width:100%;height:450px;"></div>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<script>
  Plotly.newPlot('{chart_id}', {json.dumps(traces)}, {json.dumps(layout)});
</script>
"""
```

**Why unique IDs**: Multiple charts may be rendered in the same chat session. Colliding element IDs cause charts to overwrite each other. Always use `uuid` to generate a unique ID per chart.

---

## Summary Field Requirements

The `summary` field is the agent's primary input for interpretation. It must:
- Be written in plain language (no code, no variable names)
- Include at least one specific numerical observation
- Be 1–3 sentences maximum
- Reference what question this artifact answers

**Good summary**: "Path aggregation table for 2,847 rows across April 6–10. 1,741 of 2,003 unique paths have dwell_seconds < 3. Median dwell is 2.1s; max is 47.3s (path 8d87c0b6)."

**Bad summary**: "Data processed successfully."

---

## Error Envelope

If the analysis code encounters an unrecoverable error, emit an error envelope rather than crashing:

```json
{
  "type": "error",
  "title": "Analysis Error",
  "message": "Description of what went wrong.",
  "traceback": "Optional Python traceback string."
}
```

The agent reads this and debugs before surfacing to the user.

---

---

## Artifact as Take-Away Draft

In the `/chat` and `/notebook` playbooks, every artifact that answers an analysis question is simultaneously the **Take-Away draft**. There is no separate card. The artifact envelope + the agent's response together form the approvable unit.

**What this means for the Python code:**

The `summary` field is the agent's primary interpretation input — it feeds the agent's Insights step (written as agent text after the charts). Write it as if it will be read aloud to someone who cannot see the chart.

**Optional `insights` field (chart and multi envelopes only) — reference data for the agent, not rendered in the frontend:**

Analysis code may include a pre-computed `insights` array to assist the agent in drafting the Insights step (2–5 bullets written as agent text after the last chart). The frontend does NOT render this field — it is agent-facing only. If present, the agent uses it as a starting point; if absent, the agent derives insights from `data`.

```json
{
  "type": "chart",
  "title": "...",
  "html": "...",
  "data": {...},
  "summary": "...",
  "insights": [
    "76% of paths (1,523 of 2,003) have dwell < 5s — likely ghost or passer-by dominated.",
    "Median dwell for non-ghost paths is 18.4s, consistent with active engagement.",
    "Ghost rate is highest between 06:00–08:00 (87%) and 21:00–22:00 (79%)."
  ]
}
```

- Each insight is a 1-sentence claim with a supporting number.
- 2–5 insights maximum.
- Insights must reference values from `data` — no fabrication.
- If an insight would require the agent to re-run analysis, omit it and let the agent derive it.

**Take-Away response lifecycle:**

```
Agent response turn
  ├── Take-Away: 1-2 sentences with real numbers (from queryData output)
  ├── Evidence: 1-4 executeAnalysis calls — one chart/table card each
  ├── Insights: 2-5 bullet points as agent text after the last chart
  ├── Actions: 1-3 next questions/actions (only if clearly warranted)
  └── Take-Away draft card (pending):
        headline = chart title
        evidence = summary + key insight values
        [Approve as Take-Away] [Edit] [Discard]
```

Approved Take-Aways are written to the `knowledge_beliefs` table via `writeBelief`. The artifact HTML is NOT stored — only the headline, summary, and insights are stored as the belief content.

---

---

## queryData Exploration Contract

The `queryData` tool runs exploration code to give the agent real statistics before it writes the Take-Away. **This is not an artifact envelope** — the tool does not render a chart or table card in the frontend. The user sees only a collapsed tool indicator.

### Exploration code pattern

```python
import psycopg2, os, json
import pandas as pd

conn = psycopg2.connect(os.environ["DB_URL"])
cur = conn.cursor()
cur.execute(
    "SELECT data FROM dataset_records WHERE raw_upload_id = %s",
    (os.environ["RAW_UPLOAD_ID"],),
)
rows = [r[0] for r in cur.fetchall()]
cur.close()
conn.close()
df = pd.DataFrame(rows)
# ... compute statistics ...
print(json.dumps({
    "n_paths": 847,
    "engagement_rate": 23.4,
    "median_dwell_s": 18.4,
    "summary": "847 clean paths. Engagement rate 23.4%. Median dwell 18.4s for non-ghost paths."
}))
```

### Rules

- The final `print` must output a JSON object — not a chart envelope.
- Include a `summary` key with a plain-language sentence summarizing the key findings.
- All other keys are named statistics the agent will reference in its Take-Away.
- Do NOT include `type`, `html`, `data`, or `artifacts` — those are artifact envelope fields and will cause the tool to error.
- Do NOT write to `analysis_artifacts` — this tool is exploration-only.
- Pre-installed libraries: `pandas`, `numpy`, `psycopg2-binary`. Do NOT use `plotly` in exploration code.

---

## Transform Contract (executeTransform only)

Transform templates output a single JSON envelope that the `executeTransform` tool reads and uses to write rows to `dataset_records`. This is a different contract from the analysis envelope above.

```json
{
  "type": "transform",
  "rows": [ { "target_id": "...", "dwell_seconds": 12.3, ... }, ... ],
  "summary": "5,847 paths written. QR-1 removed 420 off-hours paths. QR-2 removed 83 short paths."
}
```

- `type` must be exactly `"transform"` — the tool validates this.
- `rows` is an array of path-level record objects, one per `target_id`. Each object becomes one row in `dataset_records.data` (JSONB).
- `summary` is displayed to the agent as confirmation after the write. Include row count and filter stats.
- Do NOT include HTML, charts, or analysis output in a transform envelope — the tool only reads `rows` and `summary`.

---

## Validation Checklist (agent pre-flight before calling executeAnalysis)

- [ ] Script ends with exactly one `print(json.dumps({...}))` statement
- [ ] The printed object has `type`, `title`, and `summary` at minimum
- [ ] Chart envelopes include both `html` and `data`
- [ ] Chart HTML uses a unique element ID (uuid-based)
- [ ] Plotly CDN loaded from `https://cdn.plot.ly/plotly-latest.min.js`
- [ ] Table envelopes include both `data` (array) and `columns` (array)
- [ ] Multi envelopes have an `artifacts` array with valid sub-envelopes
- [ ] `summary` is specific and includes numerical values
- [ ] If `insights` is present: each is 1 sentence with a specific number, max 5 items
