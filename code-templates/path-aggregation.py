"""
Template: path-aggregation
Purpose:  Convert raw sensor position rows into one row per target_id (path).
          Computes dwell time, positional statistics, and movement features.
          This is the foundational step — all classification and engagement analysis
          builds on the output of this template.

Inputs ({{PLACEHOLDER}} tokens):
  {{START_TIME}}      ISO timestamp string for window start (e.g., "2026-04-06 07:00:00")
  {{END_TIME}}        ISO timestamp string for window end (e.g., "2026-04-10 20:00:00")
  {{SENSOR_FILTER}}   Sensor name to filter on (e.g., "radar-001"), or "" to include all sensors
  {{MIN_POINTS}}      Minimum number of position readings to include a path (e.g., 2)

Output: table envelope with one row per target_id.
"""

import pandas as pd
import numpy as np
import json
from datetime import datetime

# ── Load data ──────────────────────────────────────────────────────────────────
df = pd.read_csv('/sandbox/upload.csv', parse_dates=['log_creation_time', 'processed_at'])

# ── Apply filters ──────────────────────────────────────────────────────────────
start_time = pd.Timestamp("{{START_TIME}}")
end_time = pd.Timestamp("{{END_TIME}}")
sensor_filter = "{{SENSOR_FILTER}}"
min_points = {{MIN_POINTS}}

df = df[(df['log_creation_time'] >= start_time) & (df['log_creation_time'] <= end_time)]

if sensor_filter:
    df = df[df['sensor_name'] == sensor_filter]

# ── Aggregate to path level ────────────────────────────────────────────────────
path_summary = (
    df.groupby('target_id')
    .agg(
        start_time=('log_creation_time', 'min'),
        end_time=('log_creation_time', 'max'),
        point_count=('log_creation_time', 'count'),
        # Dwell
        dwell_seconds=('log_creation_time', lambda x: (x.max() - x.min()).total_seconds()),
        # X-axis statistics
        mean_x=('x_m', 'mean'),
        std_x=('x_m', 'std'),
        min_x=('x_m', 'min'),
        max_x=('x_m', 'max'),
        q1_x=('x_m', lambda x: x.quantile(0.25)),
        q3_x=('x_m', lambda x: x.quantile(0.75)),
        # Y-axis statistics
        mean_y=('y_m', 'mean'),
        std_y=('y_m', 'std'),
        min_y=('y_m', 'min'),
        max_y=('y_m', 'max'),
        q1_y=('y_m', lambda x: x.quantile(0.25)),
        q3_y=('y_m', lambda x: x.quantile(0.75)),
        # Derived features
        sensor_name=('sensor_name', 'first'),
    )
    .reset_index()
)

# Compute derived movement features
path_summary['range_x'] = path_summary['max_x'] - path_summary['min_x']
path_summary['range_y'] = path_summary['max_y'] - path_summary['min_y']
path_summary['pos_std_combined'] = np.sqrt(
    path_summary['std_x'].fillna(0)**2 + path_summary['std_y'].fillna(0)**2
)
path_summary['start_hour'] = path_summary['start_time'].dt.hour

# Filter minimum points
path_summary = path_summary[path_summary['point_count'] >= min_points]

# Sort by start_time descending
path_summary = path_summary.sort_values('start_time', ascending=False)

# Round floats
float_cols = path_summary.select_dtypes(include=['float64']).columns
path_summary[float_cols] = path_summary[float_cols].round(3)

# Convert timestamps to strings for JSON serialization
path_summary['start_time'] = path_summary['start_time'].dt.strftime('%Y-%m-%d %H:%M:%S')
path_summary['end_time'] = path_summary['end_time'].dt.strftime('%Y-%m-%d %H:%M:%S')

# ── Build output envelope ──────────────────────────────────────────────────────
total_paths = len(path_summary)
median_dwell = round(path_summary['dwell_seconds'].median(), 1)
max_dwell = round(path_summary['dwell_seconds'].max(), 1)
short_paths = int((path_summary['dwell_seconds'] < 3).sum())
pct_short = round(100 * short_paths / total_paths, 1) if total_paths > 0 else 0
sensor_label = f" | sensor: {sensor_filter}" if sensor_filter else ""

summary = (
    f"Path aggregation: {total_paths} unique paths | "
    f"{start_time.date()} to {end_time.date()}{sensor_label}. "
    f"Median dwell: {median_dwell}s, max: {max_dwell}s. "
    f"{short_paths} paths ({pct_short}%) under 3 seconds."
)

print(json.dumps({
    "type": "table",
    "title": f"Path Summary ({total_paths} paths)",
    "data": path_summary.to_dict(orient='records'),
    "columns": list(path_summary.columns),
    "summary": summary
}))
