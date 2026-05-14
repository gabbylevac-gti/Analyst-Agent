"""
Template: engagement-metrics-v1
Stage:    Analysis (reads from audience_day_agg + audience_observations)
Purpose:  Core business metrics for DR6000 sensor deployments.
          Produces traffic volume, engagement rate, and dwell distribution
          for a given upload, broken down by day.

          Data is already classified (engaged / passer_by) — ghost paths were
          removed at transform time. No ghost filtering needed here.

          Engagement rate definition: engaged paths / (engaged + passer_by paths)
          — of all real people who entered the zone, what % stopped and engaged.

          Uses audience_day_agg for pre-computed daily totals, and
          audience_observations for the dwell distribution histogram.

          Prerequisite: executeTransform must have run first.

Runtime env vars (injected by executeAnalysis tool — do not modify):
  DB_URL           Postgres connection string (session pooler, IPv4)
  RAW_UPLOAD_ID    raw_data_uploads.id to filter tables

Output: multi envelope — daily metrics chart + dwell distribution chart + summary text
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

# ── Load daily aggregates ──────────────────────────────────────────────────────
conn = psycopg2.connect(os.environ["DB_URL"])
cur = conn.cursor()

cur.execute("""
    SELECT
        date, engaged_count, passer_by_count, total_paths,
        avg_dwell_engaged_seconds, peak_hour,
        engaged_dwell_seconds_array
    FROM audience_day_agg
    WHERE raw_upload_id = %s
    ORDER BY date
""", (RAW_UPLOAD_ID,))
day_cols = [desc[0] for desc in cur.description]
day_rows = cur.fetchall()

if not day_rows:
    print(json.dumps({
        "type": "error", "title": "No Aggregated Data",
        "message": (
            "No records found in audience_day_agg for this upload. "
            "Run executeTransform first to populate the clean data layer."
        ),
        "traceback": ""
    }))
    cur.close()
    conn.close()
    raise SystemExit

daily = pd.DataFrame(day_rows, columns=day_cols)
daily["date"] = daily["date"].apply(lambda d: d.isoformat() if hasattr(d, "isoformat") else str(d))

# ── Load dwell values from observations for histogram ──────────────────────────
cur.execute("""
    SELECT path_classification, dwell_seconds
    FROM audience_observations
    WHERE raw_upload_id = %s
""", (RAW_UPLOAD_ID,))
obs_rows = cur.fetchall()
cur.close()
conn.close()

obs = pd.DataFrame(obs_rows, columns=["path_classification", "dwell_seconds"])

# ── Overall metrics ────────────────────────────────────────────────────────────
n_engaged_total = int(daily["engaged_count"].sum())
n_passer_total = int(daily["passer_by_count"].sum())
n_real = n_engaged_total + n_passer_total

overall_engagement_rate = round(100 * n_engaged_total / n_real, 1) if n_real > 0 else 0.0

median_dwell_engaged = 0.0
if not obs.empty:
    engaged_obs = obs[obs["path_classification"] == "engaged"]["dwell_seconds"]
    if len(engaged_obs) > 0:
        median_dwell_engaged = round(float(engaged_obs.median()), 1)

date_range_str = f"{daily['date'].min()} to {daily['date'].max()}"

# ── Daily engagement rate ──────────────────────────────────────────────────────
daily["engagement_rate"] = (
    100 * daily["engaged_count"] / daily["total_paths"].replace(0, 1)
).round(1)

# ── Chart 1: Daily traffic + engagement rate ───────────────────────────────────
chart1_id = f"plotly-{uuid.uuid4().hex[:8]}"

traffic_trace = {
    "type": "bar",
    "name": "Total Paths (Traffic)",
    "x": daily["date"].tolist(),
    "y": daily["total_paths"].tolist(),
    "marker": {"color": "#636EFA", "opacity": 0.7},
    "yaxis": "y1",
    "hovertemplate": "%{x}<br>Traffic: %{y} paths<extra></extra>",
}
engagement_trace = {
    "type": "scatter",
    "mode": "lines+markers",
    "name": "Engagement Rate (%)",
    "x": daily["date"].tolist(),
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
        f"Peak day: {daily.loc[daily['total_paths'].idxmax(), 'date']} "
        f"({int(daily['total_paths'].max())} paths)."
    ),
}

# ── Chart 2: Dwell distribution ────────────────────────────────────────────────
chart2_id = f"plotly-{uuid.uuid4().hex[:8]}"

n_engaged_obs = int((obs["path_classification"] == "engaged").sum())
n_passer_obs = int((obs["path_classification"] == "passer_by").sum())

engaged_dwell = obs[obs["path_classification"] == "engaged"]["dwell_seconds"].clip(upper=300).tolist()
passer_dwell = obs[obs["path_classification"] == "passer_by"]["dwell_seconds"].tolist()

dwell_traces = [
    {
        "type": "histogram",
        "name": f"Passer-by (n={n_passer_obs})",
        "x": passer_dwell,
        "opacity": 0.65,
        "marker": {"color": "#636EFA"},
        "nbinsx": 30,
        "hovertemplate": "Dwell %{x:.0f}s: %{y} paths<extra></extra>",
    },
    {
        "type": "histogram",
        "name": f"Engaged (n={n_engaged_obs})",
        "x": engaged_dwell,
        "opacity": 0.65,
        "marker": {"color": "#00CC96"},
        "nbinsx": 30,
        "hovertemplate": "Dwell %{x:.0f}s: %{y} paths<extra></extra>",
    },
]

layout2 = {
    "title": {"text": "Dwell Time Distribution by Classification"},
    "xaxis": {"title": "Dwell Time (seconds)"},
    "yaxis": {"title": "Path Count"},
    "barmode": "overlay",
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

dwell_p75_engaged = 0.0
if n_engaged_obs > 0:
    dwell_p75_engaged = round(float(obs[obs["path_classification"] == "engaged"]["dwell_seconds"].quantile(0.75)), 1)

chart2_envelope = {
    "type": "chart",
    "title": "Dwell Time Distribution",
    "html": html2,
    "data": {"data": dwell_traces, "layout": layout2},
    "summary": (
        f"Dwell distribution for {n_real} paths. "
        f"Engaged (n={n_engaged_obs}): median {median_dwell_engaged}s, P75 {dwell_p75_engaged}s. "
        f"Passer-by (n={n_passer_obs})."
    ),
}

# ── Summary text ───────────────────────────────────────────────────────────────
text_content = f"""## Engagement Metrics Summary

**Period:** {date_range_str}
**Total paths:** {n_real}

### Key Metrics
| Metric | Value |
|--------|-------|
| **Engaged paths** | {n_engaged_total} |
| **Passer-by paths** | {n_passer_total} |
| **Engagement rate** | **{overall_engagement_rate}%** |
| **Median dwell (engaged)** | {median_dwell_engaged}s |

### Day-by-Day Range
- Traffic range: {int(daily['total_paths'].min())}–{int(daily['total_paths'].max())} paths/day
- Engagement rate range: {round(daily['engagement_rate'].min(), 1)}%–{round(daily['engagement_rate'].max(), 1)}%
"""

text_envelope = {
    "type": "text",
    "title": "Engagement Metrics Summary",
    "content": text_content,
    "summary": (
        f"Engagement metrics for {date_range_str}: {n_real} paths, "
        f"{overall_engagement_rate}% engagement rate, median engaged dwell {median_dwell_engaged}s."
    ),
}

# ── Output ─────────────────────────────────────────────────────────────────────
print(json.dumps({
    "type": "multi",
    "title": f"Engagement Metrics — {date_range_str}",
    "artifacts": [chart1_envelope, chart2_envelope, text_envelope],
    "summary": (
        f"Engagement metrics: {n_real} paths over {date_range_str}. "
        f"Engagement rate: {overall_engagement_rate}% ({n_engaged_total} engaged, {n_passer_total} passer-by). "
        f"Median engaged dwell: {median_dwell_engaged}s."
    ),
}, default=_j))
