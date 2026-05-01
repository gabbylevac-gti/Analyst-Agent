"""
Template: position-over-time
Purpose:  Plot X or Y coordinate vs. log_creation_time for all paths.
          Each target_id gets its own color. Reveals temporal patterns:
          when paths are active, movement over time, clustering by hour.

Inputs ({{PLACEHOLDER}} tokens):
  {{START_TIME}}       ISO timestamp string for window start
  {{END_TIME}}         ISO timestamp string for window end
  {{SENSOR_FILTER}}    Sensor name to filter on, or "" for all sensors
  {{AXIS}}             Which axis to plot: "x" or "y"
  {{CHART_TITLE}}      Chart title string

Output: chart envelope with Plotly scatter plot (time on x-axis, position on y-axis).
"""

import pandas as pd
import json
import uuid

# ── Load and filter ────────────────────────────────────────────────────────────
df = pd.read_csv('/sandbox/upload.csv', parse_dates=['log_creation_time'])

start_time = pd.Timestamp("{{START_TIME}}")
end_time = pd.Timestamp("{{END_TIME}}")
sensor_filter = "{{SENSOR_FILTER}}"
axis = "{{AXIS}}"  # "x" or "y"

df = df[(df['log_creation_time'] >= start_time) & (df['log_creation_time'] <= end_time)]
if sensor_filter:
    df = df[df['sensor_name'] == sensor_filter]

df = df.sort_values(['target_id', 'log_creation_time'])

position_col = f"{axis}_m"
axis_label = f"{axis.upper()} Position (meters)"

# ── Build Plotly traces ────────────────────────────────────────────────────────
target_ids = df['target_id'].unique()
total_paths = len(target_ids)

colors = [
    '#636EFA','#EF553B','#00CC96','#AB63FA','#FFA15A',
    '#19D3F3','#FF6692','#B6E880','#FF97FF','#FECB52'
]

traces = []
for i, tid in enumerate(target_ids):
    path_df = df[df['target_id'] == tid].sort_values('log_creation_time')

    traces.append({
        "type": "scatter",
        "mode": "markers",
        "x": path_df['log_creation_time'].dt.strftime('%Y-%m-%dT%H:%M:%S').tolist(),
        "y": path_df[position_col].tolist(),
        "name": tid[:8],
        "marker": {
            "size": 4,
            "color": colors[i % len(colors)],
            "opacity": 0.6
        },
        "hovertemplate": f"time: %{{x}}<br>{axis_label}: %{{y:.2f}}m<extra></extra>",
        "showlegend": False
    })

layout = {
    "title": {"text": "{{CHART_TITLE}}"},
    "xaxis": {
        "title": "Time",
        "type": "date"
    },
    "yaxis": {
        "title": axis_label
    },
    "height": 450,
    "margin": {"l": 60, "r": 20, "t": 60, "b": 60},
    "plot_bgcolor": "#fafafa",
    "paper_bgcolor": "#ffffff"
}

# ── Build HTML envelope ────────────────────────────────────────────────────────
chart_id = f"plotly-{uuid.uuid4().hex[:8]}"

html = f"""
<div id="{chart_id}" style="width:100%;height:450px;"></div>
<script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
<script>
  Plotly.newPlot('{chart_id}', {json.dumps(traces)}, {json.dumps(layout)}, {{responsive: true}});
</script>
"""

# ── Summary stats ──────────────────────────────────────────────────────────────
pos_mean = round(df[position_col].mean(), 3)
pos_std = round(df[position_col].std(), 3)
pos_min = round(df[position_col].min(), 3)
pos_max = round(df[position_col].max(), 3)
sensor_label = f" | sensor: {sensor_filter}" if sensor_filter else ""

summary = (
    f"{axis.upper()}-position over time: {total_paths} paths | "
    f"{start_time.date()} to {end_time.date()}{sensor_label}. "
    f"{axis.upper()}-range: [{pos_min}, {pos_max}]m. "
    f"Mean: {pos_mean}m, SD: {pos_std}m."
)

print(json.dumps({
    "type": "chart",
    "title": "{{CHART_TITLE}}",
    "html": html,
    "data": {"data": traces, "layout": layout},
    "summary": summary
}))
