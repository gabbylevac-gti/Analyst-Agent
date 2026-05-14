"""
Endpoint Traffic Heatmap
========================
Purpose : Hourly traffic heatmap with one row per endpoint.
          Reveals when each endpoint is busiest — useful for comparing
          peak-hour patterns across doors or store locations.
Inputs  : {{ORG_ID}}         - organisation UUID
          {{ENDPOINT_IDS}}   - comma-separated list of end_points.id UUIDs
          {{DATE_START}}     - inclusive start date (YYYY-MM-DD)
          {{DATE_END}}       - inclusive end date   (YYYY-MM-DD)
Outputs : chart envelope with a Plotly heatmap (hour × endpoint)
"""

import json
import os
import psycopg2
import plotly.graph_objects as go

DB_URL       = os.environ["DB_URL"]
ORG_ID       = "{{ORG_ID}}"
ENDPOINT_IDS = [e.strip() for e in "{{ENDPOINT_IDS}}".split(",")]
DATE_START   = "{{DATE_START}}"
DATE_END     = "{{DATE_END}}"

conn = psycopg2.connect(DB_URL)
cur  = conn.cursor()

# Resolve endpoint names
cur.execute(
    "SELECT id, end_point FROM end_points WHERE id = ANY(%s) AND org_id = %s",
    (ENDPOINT_IDS, ORG_ID),
)
endpoint_names = {row[0]: row[1] for row in cur.fetchall()}

# Hourly aggregation from audience_15min_agg (4 buckets per hour → sum)
cur.execute(
    """
    SELECT
        endpoint_id::text,
        EXTRACT(HOUR FROM window_start AT TIME ZONE 'UTC')::int AS hour,
        SUM(path_count)::int AS paths
    FROM audience_15min_agg
    WHERE org_id = %s
      AND endpoint_id = ANY(%s)
      AND window_start::date BETWEEN %s AND %s
    GROUP BY endpoint_id, hour
    ORDER BY endpoint_id, hour
    """,
    (ORG_ID, ENDPOINT_IDS, DATE_START, DATE_END),
)
rows = cur.fetchall()

cur.close()
conn.close()

# Pivot: endpoint → hour → paths
from collections import defaultdict
hourly: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
for ep_id, hour, paths in rows:
    hourly[ep_id][hour] += paths

hours = list(range(24))
ep_labels = [endpoint_names.get(ep, ep[:8]) for ep in ENDPOINT_IDS]
z_matrix  = []

for ep_id in ENDPOINT_IDS:
    row = [hourly[ep_id].get(h, 0) for h in hours]
    z_matrix.append(row)

hour_labels = [f"{h:02d}:00" for h in hours]

fig = go.Figure(go.Heatmap(
    z=z_matrix,
    x=hour_labels,
    y=ep_labels,
    colorscale="Blues",
    colorbar=dict(title="Paths"),
    hovertemplate="Hour: %{x}<br>Endpoint: %{y}<br>Paths: %{z}<extra></extra>",
))

fig.update_layout(
    title=f"Hourly Traffic by Endpoint ({DATE_START} – {DATE_END})",
    xaxis_title="Hour of Day",
    yaxis_title="Endpoint",
    template="plotly_white",
)

chart_html = fig.to_html(include_plotlyjs="cdn", full_html=False)

# Summary: peak hour per endpoint
summary = []
insights = []
for i, ep_id in enumerate(ENDPOINT_IDS):
    ep_name   = endpoint_names.get(ep_id, ep_id[:8])
    row_data  = z_matrix[i]
    total     = sum(row_data)
    peak_hour = hours[row_data.index(max(row_data))] if row_data else 0
    summary.append({
        "endpoint": ep_name,
        "total_paths": total,
        "peak_hour": f"{peak_hour:02d}:00",
        "peak_paths": max(row_data) if row_data else 0,
    })
    insights.append(
        f"{ep_name}: peak traffic at {peak_hour:02d}:00 ({max(row_data) if row_data else 0} paths/day avg)."
    )

print(json.dumps({
    "type":     "chart",
    "html":     chart_html,
    "summary":  summary,
    "insights": insights,
    "data": {
        "endpoint_summaries": summary,
        "date_range": {"start": DATE_START, "end": DATE_END},
        "hours": hour_labels,
    },
}))
