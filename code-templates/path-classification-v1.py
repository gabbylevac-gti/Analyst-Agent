"""
Template: path-classification-v1
Stage:    Analysis (Stage 2 — reads from dataset_records / clean layer)
Purpose:  Classify each path as ghost, passer-by, or engaged using deployment-specific
          thresholds confirmed in the org's Data Dictionary. Applies quality filters
          (off-hours, range, min points) then classification. Produces a classified
          paths table and a classification summary chart.

          This is the definitive classification template. Use it when you need
          the full 3-way label for downstream analysis. For ghost-only filtering
          with a simpler output, use dr6000-ghost-filter-v1.py instead.

          Prerequisite: ghost thresholds (GHOST_DWELL_S, GHOST_STD_M) and engaged
          threshold (ENGAGED_DWELL_S) must be confirmed in the org's Data Dictionary
          before running this template. Run quality-check-sensor-v1.py and
          path-trajectory-plot.py first if thresholds have not been validated.

Inputs ({{PLACEHOLDER}} tokens):
  {{CSV_URL}}             Public URL of the raw CSV file (POC: direct CSV; target: reads from dataset_records)
  {{STORE_OPEN_HOUR}}     First valid hour of day (from Data Dictionary)
  {{STORE_CLOSE_HOUR}}    First invalid hour of day (from Data Dictionary)
  {{X_MIN}}, {{X_MAX}}    Valid x coordinate bounds in meters (from Data Dictionary — deployment-specific)
  {{Y_MIN}}, {{Y_MAX}}    Valid y coordinate bounds in meters (from Data Dictionary — deployment-specific)
  {{MIN_POINTS}}          Minimum readings per path (from Data Dictionary)
  {{GHOST_DWELL_S}}       Ghost dwell threshold in seconds (from Data Dictionary — deployment-specific)
  {{GHOST_STD_M}}         Ghost positional std threshold in meters (from Data Dictionary — deployment-specific)
  {{ENGAGED_DWELL_S}}     Minimum dwell for engaged classification (from Data Dictionary — deployment-specific)

Output: multi envelope — classification summary chart + classified paths table
"""

import pandas as pd
import numpy as np
import json
import uuid

# ── Parameters ─────────────────────────────────────────────────────────────────
CSV_URL = "{{CSV_URL}}"
STORE_OPEN_HOUR = {{STORE_OPEN_HOUR}}
STORE_CLOSE_HOUR = {{STORE_CLOSE_HOUR}}
X_MIN, X_MAX = {{X_MIN}}, {{X_MAX}}
Y_MIN, Y_MAX = {{Y_MIN}}, {{Y_MAX}}
MIN_POINTS = {{MIN_POINTS}}
GHOST_DWELL_S = {{GHOST_DWELL_S}}
GHOST_STD_M = {{GHOST_STD_M}}
ENGAGED_DWELL_S = {{ENGAGED_DWELL_S}}

# ── Load and filter ────────────────────────────────────────────────────────────
df = pd.read_csv(CSV_URL, parse_dates=["log_creation_time"])
df["hour_of_day"] = df["log_creation_time"].dt.hour

# Apply quality filters
df = df[
    (df["hour_of_day"] >= STORE_OPEN_HOUR) &
    (df["hour_of_day"] < STORE_CLOSE_HOUR) &
    df["x_m"].notna() & df["y_m"].notna() &
    (df["x_m"] >= X_MIN) & (df["x_m"] <= X_MAX) &
    (df["y_m"] >= Y_MIN) & (df["y_m"] <= Y_MAX)
]

if len(df) == 0:
    print(json.dumps({
        "type": "error", "title": "No data after quality filters",
        "message": "All rows were removed by quality filters. Check store hours and zone bounds.",
        "traceback": ""
    }))
    raise SystemExit

# ── Aggregate to path level ────────────────────────────────────────────────────
paths = (
    df.groupby("target_id")
    .agg(
        start_time=("log_creation_time", "min"),
        end_time=("log_creation_time", "max"),
        point_count=("log_creation_time", "count"),
        centroid_x=("x_m", "mean"),
        centroid_y=("y_m", "mean"),
        std_x=("x_m", "std"),
        std_y=("y_m", "std"),
        range_x=("x_m", lambda x: x.max() - x.min()),
        range_y=("y_m", lambda x: x.max() - x.min()),
        sensor_name=("sensor_name", "first"),
    )
    .reset_index()
)
paths["dwell_seconds"] = (paths["end_time"] - paths["start_time"]).dt.total_seconds()
paths["std_x"] = paths["std_x"].fillna(0.0)
paths["std_y"] = paths["std_y"].fillna(0.0)
paths["start_hour"] = paths["start_time"].dt.hour

# Apply minimum point count
paths = paths[paths["point_count"] >= MIN_POINTS].copy()

# ── is_fringe: centroid near detection zone edge ───────────────────────────────
# Fringe = top 20% of y range or outermost 15% of x range
y_fringe_threshold = Y_MIN + 0.80 * (Y_MAX - Y_MIN)
x_fringe_threshold = 0.85 * X_MAX
paths["is_fringe"] = (
    (paths["centroid_y"] > y_fringe_threshold) |
    (paths["centroid_x"].abs() > x_fringe_threshold)
)

# ── Classify ───────────────────────────────────────────────────────────────────
# Step 1: Ghost — short dwell AND near-zero movement
is_ghost = (
    (paths["dwell_seconds"] < GHOST_DWELL_S) &
    (paths["std_x"] < GHOST_STD_M) &
    (paths["std_y"] < GHOST_STD_M)
)

# Step 2: Among non-ghosts, engaged vs passer-by by dwell threshold
is_engaged = ~is_ghost & (paths["dwell_seconds"] >= ENGAGED_DWELL_S)
is_passer_by = ~is_ghost & ~is_engaged

paths["classification"] = "passer-by"
paths.loc[is_ghost, "classification"] = "ghost"
paths.loc[is_engaged, "classification"] = "engaged"

# ── Counts and engagement rate ─────────────────────────────────────────────────
counts = paths["classification"].value_counts()
n_ghost = int(counts.get("ghost", 0))
n_passer = int(counts.get("passer-by", 0))
n_engaged = int(counts.get("engaged", 0))
n_real = n_passer + n_engaged
n_total = len(paths)

engagement_rate = round(100 * n_engaged / n_real, 1) if n_real > 0 else 0.0
ghost_rate = round(100 * n_ghost / n_total, 1) if n_total > 0 else 0.0

# ── Summary chart: Classification breakdown ────────────────────────────────────
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

# ── Paths table (classified) ───────────────────────────────────────────────────
output_cols = [
    "target_id", "classification", "dwell_seconds", "point_count",
    "centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y",
    "is_fringe", "start_hour", "sensor_name",
]
paths_out = paths[output_cols].copy()
paths_out["dwell_seconds"] = paths_out["dwell_seconds"].round(2)
for col in ["centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y"]:
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
