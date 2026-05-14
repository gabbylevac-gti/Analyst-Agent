"""
Multi-Endpoint Comparison
=========================
Purpose : Side-by-side engagement metrics for two or more sensor endpoints
          over a shared date range. Each endpoint appears as a separate trace.
Inputs  : {{ORG_ID}}         - organisation UUID
          {{ENDPOINT_IDS}}   - comma-separated list of end_points.id UUIDs
          {{DATE_START}}     - inclusive start date (YYYY-MM-DD)
          {{DATE_END}}       - inclusive end date   (YYYY-MM-DD)
Outputs : multi_endpoint_chart envelope with one trace per endpoint
          (engagement_rate, avg_dwell_s, path_count per day)
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

COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899"]

traces       = []
summary_rows = []

for i, ep_id in enumerate(ENDPOINT_IDS):
    ep_name = endpoint_names.get(ep_id, ep_id[:8])
    color   = COLORS[i % len(COLORS)]

    cur.execute(
        """
        SELECT
            date::text,
            path_count,
            engaged_count,
            CASE WHEN path_count > 0
                 THEN ROUND((engaged_count::numeric / path_count) * 100, 1)
                 ELSE 0 END AS engagement_rate,
            ROUND(avg_dwell_s::numeric, 1) AS avg_dwell_s
        FROM audience_day_agg
        WHERE org_id = %s
          AND endpoint_id = %s
          AND date BETWEEN %s AND %s
        ORDER BY date
        """,
        (ORG_ID, ep_id, DATE_START, DATE_END),
    )
    rows = cur.fetchall()

    if not rows:
        continue

    dates            = [r[0] for r in rows]
    path_counts      = [r[1] for r in rows]
    engagement_rates = [float(r[3]) for r in rows]
    avg_dwells       = [float(r[4]) for r in rows]

    total_paths    = sum(path_counts)
    mean_engage    = round(sum(engagement_rates) / len(engagement_rates), 1) if engagement_rates else 0
    mean_dwell     = round(sum(avg_dwells) / len(avg_dwells), 1) if avg_dwells else 0

    summary_rows.append({
        "endpoint": ep_name,
        "total_paths": total_paths,
        "avg_engagement_rate_pct": mean_engage,
        "avg_dwell_s": mean_dwell,
        "days": len(rows),
    })

    traces.append({
        "endpointName": ep_name,
        "endpointId":   ep_id,
        "color":        color,
        "data": {
            "dates":            dates,
            "path_counts":      path_counts,
            "engagement_rates": engagement_rates,
            "avg_dwells":       avg_dwells,
        },
    })

cur.close()
conn.close()

# ── Build Plotly figure ───────────────────────────────────────────────────────
fig = go.Figure()

for t in traces:
    d = t["data"]
    fig.add_trace(go.Scatter(
        x=d["dates"],
        y=d["engagement_rates"],
        mode="lines+markers",
        name=t["endpointName"],
        line=dict(color=t["color"], width=2),
        marker=dict(size=5),
        hovertemplate=(
            "%{x}<br>"
            "Engagement rate: %{y}%<br>"
            f"Endpoint: {t['endpointName']}"
            "<extra></extra>"
        ),
    ))

fig.update_layout(
    title=f"Engagement Rate by Endpoint ({DATE_START} – {DATE_END})",
    xaxis_title="Date",
    yaxis_title="Engagement Rate (%)",
    legend_title="Endpoint",
    template="plotly_white",
    hovermode="x unified",
)

chart_html = fig.to_html(include_plotlyjs="cdn", full_html=False)

insights = []
if len(summary_rows) >= 2:
    top = max(summary_rows, key=lambda r: r["avg_engagement_rate_pct"])
    bot = min(summary_rows, key=lambda r: r["avg_engagement_rate_pct"])
    diff = round(top["avg_engagement_rate_pct"] - bot["avg_engagement_rate_pct"], 1)
    insights.append(
        f"{top['endpoint']} had the highest average engagement rate ({top['avg_engagement_rate_pct']}%) "
        f"vs {bot['endpoint']} ({bot['avg_engagement_rate_pct']}%) — a {diff}pp difference."
    )
    insights.append(
        f"Traffic ranged from {min(r['total_paths'] for r in summary_rows):,} to "
        f"{max(r['total_paths'] for r in summary_rows):,} paths across endpoints over the period."
    )

print(json.dumps({
    "type":    "multi_endpoint_chart",
    "html":    chart_html,
    "traces":  traces,
    "summary": summary_rows,
    "insights": insights,
    "data": {
        "endpoint_summaries": summary_rows,
        "date_range":         {"start": DATE_START, "end": DATE_END},
    },
}))
