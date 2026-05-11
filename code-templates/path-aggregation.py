"""
Template: path-aggregation
Stage:    Analysis (reads from audience_observations — typed clean layer)
Purpose:  Return the classified path records for a given upload, optionally filtered
          by date range and sensor name. audience_observations holds one row per
          classified path after QR-1 (off-hours), QR-2 (min readings), and QR-3
          (engaged/passer_by classification) have been applied by the transform step.
          Use this to inspect what the clean layer contains before deeper analysis.

Inputs ({{PLACEHOLDER}} tokens — agent fills these before calling executeAnalysis):
  {{START_DATE}}      ISO date string for window start (e.g., "2026-04-06"), or "" for all
  {{END_DATE}}        ISO date string for window end (e.g., "2026-04-10"), or "" for all
  {{SENSOR_FILTER}}   Sensor name to filter on (e.g., "radar-001"), or "" to include all

Runtime env vars (injected by executeAnalysis tool — do not modify):
  DB_URL           Postgres connection string (session pooler, IPv4)
  RAW_UPLOAD_ID    raw_data_uploads.id to filter audience_observations

Output: table envelope with one row per path (target_id).
"""

import json
import os
from datetime import date, datetime
from decimal import Decimal

import psycopg2
import numpy as np
import pandas as pd

def _j(obj):
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError

# ── Parameters ─────────────────────────────────────────────────────────────────
START_DATE = "{{START_DATE}}"
END_DATE = "{{END_DATE}}"
SENSOR_FILTER = "{{SENSOR_FILTER}}"

RAW_UPLOAD_ID = os.environ["RAW_UPLOAD_ID"]

# ── Load from audience_observations ───────────────────────────────────────────
conn = psycopg2.connect(os.environ["DB_URL"])
cur = conn.cursor()

query = """
    SELECT
        target_id, sensor_name, session_date,
        path_classification,
        dwell_seconds, point_count, start_hour,
        centroid_x, centroid_y,
        std_x, std_y, range_x, range_y,
        start_time, end_time
    FROM audience_observations
    WHERE raw_upload_id = %s
"""
params = [RAW_UPLOAD_ID]

if START_DATE:
    query += " AND session_date >= %s"
    params.append(START_DATE)
if END_DATE:
    query += " AND session_date <= %s"
    params.append(END_DATE)
if SENSOR_FILTER:
    query += " AND sensor_name = %s"
    params.append(SENSOR_FILTER)

query += " ORDER BY start_time DESC"

cur.execute(query, params)
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

path_summary = pd.DataFrame(rows, columns=col_names)

# ── Compute derived features ───────────────────────────────────────────────────
if "std_x" in path_summary.columns and "std_y" in path_summary.columns:
    path_summary["pos_std_combined"] = (
        (path_summary["std_x"] ** 2 + path_summary["std_y"] ** 2) ** 0.5
    ).round(3)

# ── Round floats ──────────────────────────────────────────────────────────────
float_cols = path_summary.select_dtypes(include=["float64", "float32"]).columns
path_summary[float_cols] = path_summary[float_cols].round(3)

# ── Build output envelope ──────────────────────────────────────────────────────
total_paths = len(path_summary)

if total_paths == 0:
    print(json.dumps({
        "type": "error", "title": "No Paths After Filtering",
        "message": "No paths matched the filter criteria. Try wider date range or remove sensor filter.",
        "traceback": ""
    }))
    raise SystemExit

dwell_col = "dwell_seconds"
median_dwell = round(float(path_summary[dwell_col].median()), 1)
max_dwell = round(float(path_summary[dwell_col].max()), 1)
n_engaged = int((path_summary["path_classification"] == "engaged").sum())
n_passer = int((path_summary["path_classification"] == "passer_by").sum())
engagement_rate = round(100 * n_engaged / total_paths, 1) if total_paths > 0 else 0.0

sensor_label = f" | sensor: {SENSOR_FILTER}" if SENSOR_FILTER else ""
date_label = ""
if START_DATE or END_DATE:
    date_label = f" | {START_DATE or '...'} to {END_DATE or '...'}"

summary = (
    f"Path aggregation: {total_paths} classified paths{sensor_label}{date_label}. "
    f"Engaged: {n_engaged} ({engagement_rate}%), passer-by: {n_passer}. "
    f"Median dwell: {median_dwell}s, max: {max_dwell}s."
)

columns = list(path_summary.columns)

print(json.dumps({
    "type": "table",
    "title": f"Audience Observations ({total_paths} paths)",
    "data": path_summary.to_dict(orient="records"),
    "columns": columns,
    "summary": summary,
}, default=_j))
