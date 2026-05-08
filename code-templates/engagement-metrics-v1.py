"""
Template: engagement-metrics-v1
Stage:    Analysis (Stage 2 — reads from dataset_records / clean layer)
Purpose:  Core business metrics for DR6000 sensor deployments.
          Produces traffic volume, engagement rate, and dwell distribution
          for a given time window, broken down by day.

          Engagement rate definition: engaged paths / (engaged + passer-by paths)
          — of all real people who entered the zone, what % stopped and engaged.
          Ghost paths are excluded from both the numerator and denominator.

          Prerequisite: ghost thresholds (GHOST_DWELL_S, GHOST_STD_M) and engaged
          threshold (ENGAGED_DWELL_S) must be confirmed in the org's Data Dictionary
          before running this template. Run quality-check-sensor-v1.py and
          path-trajectory-plot.py first if thresholds have not been validated for
          this deployment.

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

Output: multi envelope — daily metrics chart + dwell distribution chart + summary text
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

# ── Load and quality filter ────────────────────────────────────────────────────
df = pd.read_csv(CSV_URL, parse_dates=["log_creation_time"])
df["hour_of_day"] = df["log_creation_time"].dt.hour

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
        session_date=("log_creation_time", lambda x: x.min().date()),
        dwell_seconds=("log_creation_time", lambda x: (x.max() - x.min()).total_seconds()),
        point_count=("log_creation_time", "count"),
        std_x=("x_m", "std"),
        std_y=("y_m", "std"),
    )
    .reset_index()
)
paths["std_x"] = paths["std_x"].fillna(0.0)
paths["std_y"] = paths["std_y"].fillna(0.0)
paths = paths[paths["point_count"] >= MIN_POINTS].copy()

# ── Classify ───────────────────────────────────────────────────────────────────
is_ghost = (
    (paths["dwell_seconds"] < GHOST_DWELL_S) &
    (paths["std_x"] < GHOST_STD_M) &
    (paths["std_y"] < GHOST_STD_M)
)
paths["classification"] = "passer-by"
paths.loc[is_ghost, "classification"] = "ghost"
paths.loc[~is_ghost & (paths["dwell_seconds"] >= ENGAGED_DWELL_S), "classification"] = "engaged"

real_paths = paths[paths["classification"] != "ghost"].copy()

# ── Overall metrics ────────────────────────────────────────────────────────────
n_total = len(paths)
n_ghost = int((paths["classification"] == "ghost").sum())
n_real = len(real_paths)
n_engaged = int((real_paths["classification"] == "engaged").sum())
n_passer = int((real_paths["classification"] == "passer-by").sum())

overall_engagement_rate = round(100 * n_engaged / n_real, 1) if n_real > 0 else 0.0
overall_ghost_rate = round(100 * n_ghost / n_total, 1) if n_total > 0 else 0.0
median_dwell_engaged = round(
    real_paths.loc[real_paths["classification"] == "engaged", "dwell_seconds"].median(), 1
) if n_engaged > 0 else 0.0

date_range_str = f"{paths['session_date'].min()} to {paths['session_date'].max()}"

# ── Daily metrics ──────────────────────────────────────────────────────────────
daily = (
    real_paths.groupby("session_date")
    .apply(lambda g: pd.Series({
        "traffic": len(g),
        "engaged": (g["classification"] == "engaged").sum(),
        "passer_by": (g["classification"] == "passer-by").sum(),
        "engagement_rate": round(
            100 * (g["classification"] == "engaged").sum() / len(g), 1
        ) if len(g) > 0 else 0.0,
    }))
    .reset_index()
    .sort_values("session_date")
)
daily["session_date"] = daily["session_date"].astype(str)

# ── Chart 1: Daily traffic volume + engagement rate ───────────────────────────
chart1_id = f"plotly-{uuid.uuid4().hex[:8]}"

traffic_trace = {
    "type": "bar",
    "name": "Real Paths (Traffic)",
    "x": daily["session_date"].tolist(),
    "y": daily["traffic"].tolist(),
    "marker": {"color": "#636EFA", "opacity": 0.7},
    "yaxis": "y1",
    "hovertemplate": "%{x}<br>Traffic: %{y} paths<extra></extra>",
}
engagement_trace = {
    "type": "scatter",
    "mode": "lines+markers",
    "name": "Engagement Rate (%)",
    "x": daily["session_date"].tolist(),
    "y": daily["engagement_rate"].tolist(),
    "marker": {"color": "#00CC96", "size": 8},
    "line": {"color": "#00CC96", "width": 2},
    "yaxis": "y2",
    "hovertemplate": "%{x}<br>Engagement: %{y}%<extra></extra>",
}

layout1 = {
    "title": {"text": f"Daily Traffic & Engagement Rate | {date_range_str}"},
    "xaxis": {"title": "Date", "tickangle": -30},
    "yaxis": {"title": "Path Count", "side": "left"},
    "yaxis2": {
        "title": "Engagement Rate (%)",
        "side": "right",
        "overlaying": "y",
        "range": [0, 100],
    },
    "legend": {"x": 0.01, "y": 0.99},
    "height": 420,
    "margin": {"l": 60, "r": 60, "t": 60, "b": 80},
    "plot_bgcolor": "#fafafa",
    "paper_bgcolor": "#ffffff",
}

html1 = f"""
<div id="{chart1_id}" style="width:100%;height:420px;"></div>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<script>
  Plotly.newPlot('{chart1_id}', {json.dumps([traffic_trace, engagement_trace])},
    {json.dumps(layout1)}, {{responsive: true}});
</script>
"""

chart1_envelope = {
    "type": "chart",
    "title": "Daily Traffic & Engagement Rate",
    "html": html1,
    "data": {"data": [traffic_trace, engagement_trace], "layout": layout1},
    "summary": (
        f"Daily traffic and engagement rate over {date_range_str}. "
        f"Overall: {n_real} real paths, {overall_engagement_rate}% engagement rate. "
        f"Day with highest traffic: {daily.loc[daily['traffic'].idxmax(), 'session_date']} "
        f"({int(daily['traffic'].max())} paths)."
    ),
}

# ── Chart 2: Dwell distribution for real paths ────────────────────────────────
chart2_id = f"plotly-{uuid.uuid4().hex[:8]}"

engaged_dwell = real_paths.loc[
    real_paths["classification"] == "engaged", "dwell_seconds"
].clip(upper=300).tolist()
passer_dwell = real_paths.loc[
    real_paths["classification"] == "passer-by", "dwell_seconds"
].tolist()

dwell_traces = [
    {
        "type": "histogram",
        "name": f"Passer-by (n={n_passer})",
        "x": passer_dwell,
        "opacity": 0.65,
        "marker": {"color": "#636EFA"},
        "nbinsx": 30,
        "hovertemplate": "Dwell %{x:.0f}s: %{y} paths<extra></extra>",
    },
    {
        "type": "histogram",
        "name": f"Engaged (n={n_engaged})",
        "x": engaged_dwell,
        "opacity": 0.65,
        "marker": {"color": "#00CC96"},
        "nbinsx": 30,
        "hovertemplate": "Dwell %{x:.0f}s: %{y} paths<extra></extra>",
    },
]

layout2 = {
    "title": {"text": f"Dwell Time Distribution — Real Paths (ghost-filtered)"},
    "xaxis": {"title": "Dwell Time (seconds)"},
    "yaxis": {"title": "Path Count"},
    "barmode": "overlay",
    "shapes": [{
        "type": "line",
        "x0": ENGAGED_DWELL_S, "x1": ENGAGED_DWELL_S,
        "y0": 0, "y1": 1, "yref": "paper",
        "line": {"color": "#FF6692", "width": 1.5, "dash": "dash"},
    }],
    "annotations": [{
        "x": ENGAGED_DWELL_S, "y": 0.95, "yref": "paper",
        "text": f"Engaged threshold ({ENGAGED_DWELL_S}s)",
        "showarrow": False, "xanchor": "left",
        "font": {"color": "#FF6692", "size": 11},
    }],
    "height": 380,
    "margin": {"l": 60, "r": 20, "t": 60, "b": 60},
    "plot_bgcolor": "#fafafa",
    "paper_bgcolor": "#ffffff",
}

html2 = f"""
<div id="{chart2_id}" style="width:100%;height:380px;"></div>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<script>
  Plotly.newPlot('{chart2_id}', {json.dumps(dwell_traces)},
    {json.dumps(layout2)}, {{responsive: true}});
</script>
"""

dwell_p75_engaged = round(
    real_paths.loc[real_paths["classification"] == "engaged", "dwell_seconds"].quantile(0.75), 1
) if n_engaged > 0 else 0.0

chart2_envelope = {
    "type": "chart",
    "title": "Dwell Time Distribution",
    "html": html2,
    "data": {"data": dwell_traces, "layout": layout2},
    "summary": (
        f"Dwell distribution for {n_real} real paths. "
        f"Engaged paths (n={n_engaged}): median {median_dwell_engaged}s, P75 {dwell_p75_engaged}s. "
        f"Passer-by paths (n={n_passer}): all under {ENGAGED_DWELL_S}s threshold."
    ),
}

# ── Summary text ───────────────────────────────────────────────────────────────
text_content = f"""## Engagement Metrics Summary

**Period:** {date_range_str}
**Total paths detected:** {n_total} ({n_ghost} ghost, {n_real} real)
**Ghost rate:** {overall_ghost_rate}%

### Key Metrics
| Metric | Value |
|--------|-------|
| **Traffic (real paths)** | {n_real} |
| **Engaged paths** | {n_engaged} |
| **Passer-by paths** | {n_passer} |
| **Engagement rate** | **{overall_engagement_rate}%** |
| **Median dwell (engaged)** | {median_dwell_engaged}s |

### Day-by-Day Range
- Traffic range: {int(daily['traffic'].min())}–{int(daily['traffic'].max())} real paths/day
- Engagement rate range: {round(daily['engagement_rate'].min(), 1)}%–{round(daily['engagement_rate'].max(), 1)}%

### Classification Thresholds Used
- Ghost: dwell < {GHOST_DWELL_S}s AND positional std < {GHOST_STD_M}m *(pending validation)*
- Engaged: dwell ≥ {ENGAGED_DWELL_S}s *(adjust per deployment)*
- Passer-by: all other real paths
"""

text_envelope = {
    "type": "text",
    "title": "Engagement Metrics Summary",
    "content": text_content,
    "summary": (
        f"Engagement metrics for {date_range_str}: {n_real} real paths, "
        f"{overall_engagement_rate}% engagement rate, median engaged dwell {median_dwell_engaged}s. "
        f"Ghost rate: {overall_ghost_rate}%."
    ),
}

# ── Output ─────────────────────────────────────────────────────────────────────
print(json.dumps({
    "type": "multi",
    "title": f"Engagement Metrics — {date_range_str}",
    "artifacts": [chart1_envelope, chart2_envelope, text_envelope],
    "summary": (
        f"Engagement metrics: {n_real} real paths over {date_range_str}. "
        f"Engagement rate: {overall_engagement_rate}% ({n_engaged} engaged, {n_passer} passer-by). "
        f"Median engaged dwell: {median_dwell_engaged}s. Ghost rate: {overall_ghost_rate}%."
    ),
}))
