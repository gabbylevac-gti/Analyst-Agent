"""
Template: path-classification-v1
Stage:    Analysis (reads from audience_observations — typed clean layer)
Purpose:  Show the classification breakdown for a given upload.
          audience_observations holds only engaged and passer_by paths — ghost paths
          were removed by QR-2 (min readings filter) at transform time.
          Produces a classification summary chart and a classified paths table.

          No classification thresholds needed here — classification is pre-applied.
          Use engagement-metrics-v1 for daily time-series and dwell distribution.

Runtime env vars (injected by executeAnalysis tool — do not modify):
  DB_URL           Postgres connection string (session pooler, IPv4)
  RAW_UPLOAD_ID    raw_data_uploads.id to filter audience_observations

Output: multi envelope — classification summary chart + classified paths table
"""

import json
import os
import uuid
from datetime import date, datetime
from decimal import Decimal

import psycopg2
import pandas as pd

def _j(obj):
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError

RAW_UPLOAD_ID = os.environ["RAW_UPLOAD_ID"]

# ── Load from audience_observations ───────────────────────────────────────────
conn = psycopg2.connect(os.environ["DB_URL"])
cur = conn.cursor()
cur.execute("""
    SELECT
        target_id, path_classification, dwell_seconds, point_count,
        centroid_x, centroid_y, std_x, std_y, range_x, range_y,
        session_date, sensor_name
    FROM audience_observations
    WHERE raw_upload_id = %s
    ORDER BY session_date, path_classification
""", (RAW_UPLOAD_ID,))
col_names = [desc[0] for desc in cur.description]
rows = cur.fetchall()
cur.close()
conn.close()

if not rows:
    print(json.dumps({
        "type": "error", "title": "No Data",
        "message": (
            "No records found in audience_observations for this upload. "
            "Run executeTransform first to populate the clean data layer."
        ),
        "traceback": ""
    }))
    raise SystemExit

paths = pd.DataFrame(rows, columns=col_names)

# ── Counts and rates ───────────────────────────────────────────────────────────
n_engaged = int((paths["path_classification"] == "engaged").sum())
n_passer = int((paths["path_classification"] == "passer_by").sum())
n_total = len(paths)

engagement_rate = round(100 * n_engaged / n_total, 1) if n_total > 0 else 0.0

# ── Chart: Classification breakdown ───────────────────────────────────────────
chart_id = f"plotly-{uuid.uuid4().hex[:8]}"

traces = [{
    "type": "bar",
    "x": ["Passer-by", "Engaged"],
    "y": [n_passer, n_engaged],
    "marker": {"color": ["#636EFA", "#00CC96"]},
    "text": [
        f"{n_passer} ({round(100*n_passer/n_total,1)}%)" if n_total else "0",
        f"{n_engaged} ({round(100*n_engaged/n_total,1)}%)" if n_total else "0",
    ],
    "textposition": "outside",
    "hovertemplate": "%{x}: %{y} paths<extra></extra>",
}]

layout = {
    "title": {
        "text": (
            f"Path Classification — {n_total} paths | "
            f"Engagement rate: {engagement_rate}%"
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
        f"{n_total} paths: {n_engaged} engaged ({round(100*n_engaged/n_total,1) if n_total else 0}%), "
        f"{n_passer} passer-by ({round(100*n_passer/n_total,1) if n_total else 0}%). "
        f"Engagement rate: {engagement_rate}%."
    ),
}

# ── Table: Classified paths ────────────────────────────────────────────────────
output_cols = [c for c in [
    "target_id", "path_classification", "dwell_seconds", "point_count",
    "centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y",
    "session_date", "sensor_name",
] if c in paths.columns]

paths_out = paths[output_cols].copy()
if "dwell_seconds" in paths_out.columns:
    paths_out["dwell_seconds"] = paths_out["dwell_seconds"].round(2)
for col in ["centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y"]:
    if col in paths_out.columns:
        paths_out[col] = paths_out[col].round(3)

table_envelope = {
    "type": "table",
    "title": f"Classified Paths ({n_total} total)",
    "data": paths_out.to_dict(orient="records"),
    "columns": output_cols,
    "summary": (
        f"Classified paths table: {n_engaged} engaged, {n_passer} passer-by. "
        f"Engagement rate: {engagement_rate}%."
    ),
}

# ── Output ─────────────────────────────────────────────────────────────────────
print(json.dumps({
    "type": "multi",
    "title": "Path Classification",
    "artifacts": [chart_envelope, table_envelope],
    "summary": (
        f"Classification: {n_total} paths. "
        f"Engaged: {n_engaged} ({round(100*n_engaged/n_total,1) if n_total else 0}%). "
        f"Passer-by: {n_passer} ({round(100*n_passer/n_total,1) if n_total else 0}%). "
        f"Engagement rate: {engagement_rate}%."
    ),
}, default=_j))
