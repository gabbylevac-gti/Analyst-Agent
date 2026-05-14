"""
Template: summary-statistics
Purpose:  Produce a dual-output summary: sensor-level statistics table + path-level
          descriptive stats text block. Equivalent to the R script's test_summary +
          path_summary analysis. Use at the start of any new dataset session to get
          a high-level picture before drilling into specifics.

Inputs ({{PLACEHOLDER}} tokens):
  {{START_TIME}}      ISO timestamp string for window start
  {{END_TIME}}        ISO timestamp string for window end
  {{SENSOR_FILTER}}   Sensor name to filter on, or "" for all sensors
  {{MIN_POINTS}}      Minimum points per path to include in path-level stats (e.g., 2)

Output: multi envelope containing a table (path-level stats) + text (sensor summary).
"""

import pandas as pd
import numpy as np
import json

# ── Load and filter ────────────────────────────────────────────────────────────
df = pd.read_csv('/sandbox/upload.csv', parse_dates=['log_creation_time'])

start_time = pd.Timestamp("{{START_TIME}}")
end_time = pd.Timestamp("{{END_TIME}}")
sensor_filter = "{{SENSOR_FILTER}}"
min_points = {{MIN_POINTS}}

df = df[(df['log_creation_time'] >= start_time) & (df['log_creation_time'] <= end_time)]
if sensor_filter:
    df = df[df['sensor_name'] == sensor_filter]

# ── Sensor-level statistics ────────────────────────────────────────────────────
sensor_stats = {}
for col, label in [('x_m', 'X'), ('y_m', 'Y')]:
    sensor_stats[f'min_{label.lower()}'] = round(df[col].min(), 3)
    sensor_stats[f'q1_{label.lower()}'] = round(df[col].quantile(0.25), 3)
    sensor_stats[f'mean_{label.lower()}'] = round(df[col].mean(), 3)
    sensor_stats[f'median_{label.lower()}'] = round(df[col].median(), 3)
    sensor_stats[f'q3_{label.lower()}'] = round(df[col].quantile(0.75), 3)
    sensor_stats[f'max_{label.lower()}'] = round(df[col].max(), 3)
    sensor_stats[f'sd_{label.lower()}'] = round(df[col].std(), 3)
    sensor_stats[f'bias_{label.lower()}'] = round(df[col].mean() - df[col].median(), 4)

sensor_stats['total_rows'] = len(df)
sensor_stats['distinct_paths'] = int(df['target_id'].nunique())
sensor_stats['time_start'] = str(df['log_creation_time'].min())
sensor_stats['time_end'] = str(df['log_creation_time'].max())

# ── Path-level statistics ──────────────────────────────────────────────────────
path_df = (
    df.groupby('target_id')
    .agg(
        dwell_seconds=('log_creation_time', lambda x: (x.max() - x.min()).total_seconds()),
        point_count=('log_creation_time', 'count'),
        std_x=('x_m', 'std'),
        std_y=('y_m', 'std'),
    )
    .reset_index()
)
path_df = path_df[path_df['point_count'] >= min_points]

# Path-level summary stats
path_stats = {
    "total_paths": len(path_df),
    "median_dwell_s": round(path_df['dwell_seconds'].median(), 2),
    "mean_dwell_s": round(path_df['dwell_seconds'].mean(), 2),
    "max_dwell_s": round(path_df['dwell_seconds'].max(), 2),
    "p25_dwell_s": round(path_df['dwell_seconds'].quantile(0.25), 2),
    "p75_dwell_s": round(path_df['dwell_seconds'].quantile(0.75), 2),
    "pct_under_3s": round(100 * (path_df['dwell_seconds'] < 3).sum() / len(path_df), 1),
    "pct_over_15s": round(100 * (path_df['dwell_seconds'] > 15).sum() / len(path_df), 1),
    "pct_over_30s": round(100 * (path_df['dwell_seconds'] > 30).sum() / len(path_df), 1),
    "median_std_x": round(path_df['std_x'].median(), 4),
    "median_std_y": round(path_df['std_y'].median(), 4),
}

# ── Sensor stats table ─────────────────────────────────────────────────────────
sensor_table_rows = [
    {"Metric": k.replace("_", " ").title(), "Value": v}
    for k, v in sensor_stats.items()
]

table_envelope = {
    "type": "table",
    "title": "Sensor Performance Summary",
    "data": sensor_table_rows,
    "columns": ["Metric", "Value"],
    "summary": (
        f"Sensor stats for {sensor_stats['distinct_paths']} paths over "
        f"{sensor_stats['time_start'][:10]} to {sensor_stats['time_end'][:10]}. "
        f"X range: [{sensor_stats['min_x']}, {sensor_stats['max_x']}]m. "
        f"Y range: [{sensor_stats['min_y']}, {sensor_stats['max_y']}]m."
    )
}

# ── Path stats text block ──────────────────────────────────────────────────────
text_content = f"""## Path-Level Statistics

**Total paths**: {path_stats['total_paths']} (min {min_points} readings)

**Dwell time distribution**:
- Median: {path_stats['median_dwell_s']}s | Mean: {path_stats['mean_dwell_s']}s | Max: {path_stats['max_dwell_s']}s
- P25: {path_stats['p25_dwell_s']}s | P75: {path_stats['p75_dwell_s']}s

**Classification indicators**:
- Under 3s (ghost candidates): {path_stats['pct_under_3s']}% of paths
- Over 15s (engaged candidates): {path_stats['pct_over_15s']}% of paths
- Over 30s (strong engagement): {path_stats['pct_over_30s']}% of paths

**Positional stability** (median standard deviation per path):
- X-axis: {path_stats['median_std_x']}m | Y-axis: {path_stats['median_std_y']}m
"""

text_envelope = {
    "type": "text",
    "title": "Path-Level Statistics",
    "content": text_content,
    "summary": (
        f"{path_stats['total_paths']} paths analyzed. "
        f"Median dwell: {path_stats['median_dwell_s']}s. "
        f"{path_stats['pct_under_3s']}% under 3s (ghost candidates), "
        f"{path_stats['pct_over_15s']}% over 15s (engaged candidates)."
    )
}

# ── Combined output ────────────────────────────────────────────────────────────
sensor_label = f" | sensor: {sensor_filter}" if sensor_filter else ""

print(json.dumps({
    "type": "multi",
    "title": f"Dataset Summary{sensor_label}",
    "artifacts": [table_envelope, text_envelope],
    "summary": (
        f"Summary statistics for {path_stats['total_paths']} paths | "
        f"{sensor_stats['time_start'][:10]} to {sensor_stats['time_end'][:10]}{sensor_label}. "
        f"Median dwell {path_stats['median_dwell_s']}s. "
        f"{path_stats['pct_under_3s']}% ghost candidates. "
        f"{path_stats['pct_over_15s']}% engaged candidates."
    )
}))
