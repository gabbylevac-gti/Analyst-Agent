"""
Template: path-classification-v1
Stage:    Analysis (Stage 2 — reads from dataset_records / clean layer)
Purpose:  Classify each path as ghost, passer-by, or engaged using deployment-specific
          thresholds confirmed in the org's Data Dictionary. Data is already path-level
          (QR-1 off-hours and QR-2 min-points applied by the transform step).
          Applies ghost filter (QR-3) at analysis time using confirmed thresholds.
          Produces a classification summary chart and a classified paths table.

          This is the definitive classification template. Use it when you need
          the full 3-way label for downstream analysis. For ghost-only filtering
          with a simpler output, use dr6000-ghost-filter-v1.py instead.

          Prerequisite: executeTransform must have run first to populate dataset_records.
          Ghost thresholds (GHOST_DWELL_S, GHOST_STD_M) and engaged threshold
          (ENGAGED_DWELL_S) must be confirmed in the org's Data Dictionary.

Inputs ({{PLACEHOLDER}} tokens — agent fills these before calling executeAnalysis):
  {{GHOST_DWELL_S}}       Ghost dwell threshold in seconds (from Data Dictionary)
  {{GHOST_STD_M}}         Ghost positional std threshold in meters (from Data Dictionary)
  {{ENGAGED_DWELL_S}}     Minimum dwell for engaged classification (from Data Dictionary)

Runtime env vars (injected by executeAnalysis tool — do not modify):
  DB_URL           Postgres connection string (session pooler, IPv4)
  RAW_UPLOAD_ID    raw_data_uploads.id to filter dataset_records

Output: multi envelope — classification summary chart + classified paths table
"""

import json
import os
import uuid

import psycopg2

import pandas as pd

# ── Parameters ─────────────────────────────────────────────────────────────────
GHOST_DWELL_S = {{GHOST_DWELL_S}}
GHOST_STD_M = {{GHOST_STD_M}}
ENGAGED_DWELL_S = {{ENGAGED_DWELL_S}}

RAW_UPLOAD_ID = os.environ["RAW_UPLOAD_ID"]

# ── Load from dataset_records via Postgres ─────────────────────────────────────
conn = psycopg2.connect(os.environ["DB_URL"])
cur = conn.cursor()
cur.execute(
    "SELECT data FROM dataset_records WHERE raw_upload_id = %s",
    (RAW_UPLOAD_ID,),
)
rows = [r[0] for r in cur.fetchall()]
cur.close()
conn.close()

if not rows:
    print(json.dumps({
        "type": "error", "title": "No Data",
        "message": (
            "No records found in dataset_records for this upload. "
            "Run executeTransform first to populate the clean data layer."
        ),
        "traceback": ""
    }))
    raise SystemExit

paths = pd.DataFrame(rows)

# ── Validate required columns ──────────────────────────────────────────────────
required = ["target_id", "dwell_seconds", "std_x", "std_y", "session_date", "sensor_name"]
missing = [c for c in required if c not in paths.columns]
if missing:
    print(json.dumps({
        "type": "error", "title": "Schema Mismatch",
        "message": f"dataset_records missing expected columns: {missing}. Re-run transform.",
        "traceback": ""
    }))
    raise SystemExit

paths["dwell_seconds"] = pd.to_numeric(paths["dwell_seconds"], errors="coerce").fillna(0.0)
paths["std_x"] = pd.to_numeric(paths["std_x"], errors="coerce").fillna(0.0)
paths["std_y"] = pd.to_numeric(paths["std_y"], errors="coerce").fillna(0.0)

# ── Classify ───────────────────────────────────────────────────────────────────
is_ghost = (
    (paths["dwell_seconds"] < GHOST_DWELL_S) &
    (paths["std_x"] < GHOST_STD_M) &
    (paths["std_y"] < GHOST_STD_M)
)
is_engaged = ~is_ghost & (paths["dwell_seconds"] >= ENGAGED_DWELL_S)
is_passer_by = ~is_ghost & ~is_engaged

paths["classification"] = "passer-by"
paths.loc[is_ghost, "classification"] = "ghost"
paths.loc[is_engaged, "classification"] = "engaged"

# ── Counts and rates ───────────────────────────────────────────────────────────
counts = paths["classification"].value_counts()
n_ghost = int(counts.get("ghost", 0))
n_passer = int(counts.get("passer-by", 0))
n_engaged = int(counts.get("engaged", 0))
n_real = n_passer + n_engaged
n_total = len(paths)

engagement_rate = round(100 * n_engaged / n_real, 1) if n_real > 0 else 0.0
ghost_rate = round(100 * n_ghost / n_total, 1) if n_total > 0 else 0.0

# ── Chart: Classification breakdown ───────────────────────────────────────────
chart_id = f"plotly-{uuid.uuid4().hex[:8]}"

traces = [{
    "type": "bar",
    "x": ["Ghost", "Passer-by", "Engaged"],
    "y": [n_ghost, n_passer, n_engaged],
    "marker": {"color": ["#EF553B", "#636EFA", "#00CC96"]},
    "text": [
        f"{n_ghost} ({ghost_rate}%)",
        f"{n_passer} ({round(100*n_passer/n_total,1)}%)",
        f"{n_engaged} ({round(100*n_engaged/n_total,1)}%)"
    ],
    "textposition": "outside",
    "hovertemplate": "%{x}: %{y} paths<extra></extra>",
}]

layout = {
    "title": {
        "text": (
            f"Path Classification — {n_total} paths | "
            f"Engagement rate: {engagement_rate}% | Ghost rate: {ghost_rate}%"
        )
    },
    "xaxis": {"title": "Classification"},
    "yaxis": {"title": "Path Count"},
    "height": 420,
    "margin": {"l": 60, "r": 20, "t": 80, "b": 60},
    "plot_bgcolor": "#fafafa",
    "paper_bgcolor": "#ffffff",
}

html = f"""
<div id="{chart_id}" style="width:100%;height:420px;"></div>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<script>
  Plotly.newPlot('{chart_id}', {json.dumps(traces)}, {json.dumps(layout)}, {{responsive: true}});
</script>
"""

chart_envelope = {
    "type": "chart",
    "title": "Path Classification Summary",
    "html": html,
    "data": {"data": traces, "layout": layout},
    "summary": (
        f"{n_total} paths classified: {n_engaged} engaged ({round(100*n_engaged/n_total,1)}%), "
        f"{n_passer} passer-by ({round(100*n_passer/n_total,1)}%), "
        f"{n_ghost} ghost ({ghost_rate}%). "
        f"Engagement rate (engaged / real paths): {engagement_rate}%."
    ),
}

# ── Table: Classified paths ────────────────────────────────────────────────────
output_cols = [c for c in [
    "target_id", "classification", "dwell_seconds", "point_count",
    "centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y",
    "session_date", "sensor_name",
] if c in paths.columns]

paths_out = paths[output_cols].copy()
if "dwell_seconds" in paths_out.columns:
    paths_out["dwell_seconds"] = paths_out["dwell_seconds"].round(2)
for col in ["centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y"]:
    if col in paths_out.columns:
        paths_out[col] = paths_out[col].round(3)
paths_out = paths_out.sort_values("classification")

table_envelope = {
    "type": "table",
    "title": f"Classified Paths ({n_total} total)",
    "data": paths_out.to_dict(orient="records"),
    "columns": output_cols,
    "summary": (
        f"Classified paths table: {n_engaged} engaged, {n_passer} passer-by, {n_ghost} ghost. "
        f"Engagement rate: {engagement_rate}%. Thresholds: ghost dwell < {GHOST_DWELL_S}s, "
        f"std < {GHOST_STD_M}m; engaged dwell >= {ENGAGED_DWELL_S}s."
    ),
}

# ── Output ─────────────────────────────────────────────────────────────────────
print(json.dumps({
    "type": "multi",
    "title": "Path Classification",
    "artifacts": [chart_envelope, table_envelope],
    "summary": (
        f"Classification complete: {n_total} paths. "
        f"Engaged: {n_engaged} ({round(100*n_engaged/n_total,1)}%). "
        f"Passer-by: {n_passer} ({round(100*n_passer/n_total,1)}%). "
        f"Ghost: {n_ghost} ({ghost_rate}%). "
        f"Engagement rate: {engagement_rate}%."
    ),
}))
