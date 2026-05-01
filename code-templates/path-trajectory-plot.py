"""
Template: path-trajectory-plot
Purpose:  Plot X/Y spatial trajectories for all paths in the time window.
          Each target_id gets a connected scatter line in a distinct color.
          Reveals spatial patterns: movement direction, clustering, fringe detections.

Inputs ({{PLACEHOLDER}} tokens):
  {{START_TIME}}        ISO timestamp string for window start
  {{END_TIME}}          ISO timestamp string for window end
  {{SENSOR_FILTER}}     Sensor name to filter on, or "" for all sensors
  {{X_MIN}}             X-axis display minimum (e.g., -3)
  {{X_MAX}}             X-axis display maximum (e.g., 3)
  {{Y_MIN}}             Y-axis display minimum (e.g., 0)
  {{Y_MAX}}             Y-axis display maximum (e.g., 5)
  {{CHART_TITLE}}       Chart title string

Output: chart envelope with Plotly connected scatter plot.
"""

import pandas as pd
import json
import uuid

# ── Load and filter ────────────────────────────────────────────────────────────
df = pd.read_csv('/sandbox/upload.csv', parse_dates=['log_creation_time'])

start_time = pd.Timestamp("{{START_TIME}}")
end_time = pd.Timestamp("{{END_TIME}}")
sensor_filter = "{{SENSOR_FILTER}}"

df = df[(df['log_creation_time'] >= start_time) & (df['log_creation_time'] <= end_time)]
if sensor_filter:
    df = df[df['sensor_name'] == sensor_filter]

df = df.sort_values(['target_id', 'log_creation_time'])

# ── Build Plotly traces ────────────────────────────────────────────────────────
# One trace per target_id for connected path lines
target_ids = df['target_id'].unique()
total_paths = len(target_ids)

# Plotly qualitative color palette
colors = [
    '#636EFA','#EF553B','#00CC96','#AB63FA','#FFA15A',
    '#19D3F3','#FF6692','#B6E880','#FF97FF','#FECB52'
]

traces = []
for i, tid in enumerate(target_ids):
    path_df = df[df['target_id'] == tid].sort_values('log_creation_time')
    dwell = (path_df['log_creation_time'].max() - path_df['log_creation_time'].min()).total_seconds()

    traces.append({
        "type": "scatter",
        "mode": "lines+markers",
        "x": path_df['x_m'].tolist(),
        "y": path_df['y_m'].tolist(),
        "name": f"{tid[:8]}... ({dwell:.1f}s)",
        "line": {"color": colors[i % len(colors)], "width": 1.5},
        "marker": {"size": 3, "color": colors[i % len(colors)]},
        "hovertemplate": f"x: %{{x:.2f}}m<br>y: %{{y:.2f}}m<br>path: {tid[:8]}<extra></extra>",
        "showlegend": False
    })

layout = {
    "title": {"text": "{{CHART_TITLE}}"},
    "xaxis": {
        "title": "X Position (meters)",
        "range": [{{X_MIN}}, {{X_MAX}}],
        "zeroline": True, "zerolinecolor": "#888", "zerolinewidth": 1
    },
    "yaxis": {
        "title": "Y Position (meters)",
        "range": [{{Y_MIN}}, {{Y_MAX}}],
        "scaleanchor": "x", "scaleratio": 1
    },
    "height": 500,
    "margin": {"l": 60, "r": 20, "t": 60, "b": 60},
    "plot_bgcolor": "#fafafa",
    "paper_bgcolor": "#ffffff"
}

# ── Build HTML envelope ────────────────────────────────────────────────────────
chart_id = f"plotly-{uuid.uuid4().hex[:8]}"

html = f"""
<div id="{chart_id}" style="width:100%;height:500px;"></div>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<script>
  Plotly.newPlot('{chart_id}', {json.dumps(traces)}, {json.dumps(layout)}, {{responsive: true}});
</script>
"""

# ── Compute summary stats for interpretation ───────────────────────────────────
dwell_series = df.groupby('target_id')['log_creation_time'].apply(
    lambda x: (x.max() - x.min()).total_seconds()
)
median_dwell = round(dwell_series.median(), 1)
x_range = round(df['x_m'].max() - df['x_m'].min(), 2)
y_range = round(df['y_m'].max() - df['y_m'].min(), 2)
sensor_label = f" | sensor: {sensor_filter}" if sensor_filter else ""

summary = (
    f"Trajectory plot: {total_paths} paths | "
    f"{start_time.date()} to {end_time.date()}{sensor_label}. "
    f"Spatial extent: x [{df['x_m'].min():.2f}, {df['x_m'].max():.2f}]m, "
    f"y [{df['y_m'].min():.2f}, {df['y_m'].max():.2f}]m. "
    f"Median dwell: {median_dwell}s."
)

print(json.dumps({
    "type": "chart",
    "title": "{{CHART_TITLE}}",
    "html": html,
    "data": {"data": traces, "layout": layout},
    "summary": summary
}))
