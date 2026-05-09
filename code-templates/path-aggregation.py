"""
Template: path-aggregation
Stage:    Analysis (Stage 2 — reads from dataset_records / clean layer)
Purpose:  Return the clean path-level records for a given upload, optionally filtered
          by date range and sensor name. The data in dataset_records is already
          aggregated to one row per target_id (path) by the transform step.
          Use this to inspect what the clean layer contains before running
          classification or engagement templates.

Inputs ({{PLACEHOLDER}} tokens — agent fills these before calling executeAnalysis):
  {{START_DATE}}      ISO date string for window start (e.g., "2026-04-06"), or "" for all
  {{END_DATE}}        ISO date string for window end (e.g., "2026-04-10"), or "" for all
  {{SENSOR_FILTER}}   Sensor name to filter on (e.g., "radar-001"), or "" to include all
  {{MIN_POINTS}}      Minimum point_count to include a path (e.g., 2)

Runtime env vars (injected by executeAnalysis tool — do not modify):
  SUPABASE_URL     Supabase project URL
  SUPABASE_KEY     Supabase service role key
  RAW_UPLOAD_ID    raw_data_uploads.id to filter dataset_records

Output: table envelope with one row per path (target_id).
"""

import json
import os

import requests

import numpy as np
import pandas as pd

# ── Parameters ─────────────────────────────────────────────────────────────────
START_DATE = "{{START_DATE}}"
END_DATE = "{{END_DATE}}"
SENSOR_FILTER = "{{SENSOR_FILTER}}"
MIN_POINTS = {{MIN_POINTS}}

RAW_UPLOAD_ID = os.environ["RAW_UPLOAD_ID"]

# ── Load from dataset_records (Supabase REST API) ──────────────────────────────
_headers = {
    "apikey": os.environ["SUPABASE_KEY"],
    "Authorization": f"Bearer {os.environ['SUPABASE_KEY']}",
}
rows, _offset = [], 0
while True:
    _resp = requests.get(
        f"{os.environ['SUPABASE_URL']}/rest/v1/dataset_records",
        headers={**_headers, "Range": f"{_offset}-{_offset+999}"},
        params={"raw_upload_id": f"eq.{RAW_UPLOAD_ID}", "select": "data"},
    )
    _batch = _resp.json()
    if not _batch:
        break
    rows.extend(b["data"] for b in _batch)
    if len(_batch) < 1000:
        break
    _offset += 1000

if not rows:
    print(json.dumps({
        "type": "error", "title": "No Data",
        "message": (
            "No records found in dataset_records for this upload. "
            "Run executeTransform first to populate the clean data layer."
        ),
        "traceback": ""
    }))
    raise SystemExit

path_summary = pd.DataFrame(rows)

# ── Apply filters ──────────────────────────────────────────────────────────────
if START_DATE and "session_date" in path_summary.columns:
    path_summary = path_summary[path_summary["session_date"] >= START_DATE]

if END_DATE and "session_date" in path_summary.columns:
    path_summary = path_summary[path_summary["session_date"] <= END_DATE]

if SENSOR_FILTER and "sensor_name" in path_summary.columns:
    path_summary = path_summary[path_summary["sensor_name"] == SENSOR_FILTER]

if "point_count" in path_summary.columns:
    path_summary["point_count"] = pd.to_numeric(path_summary["point_count"], errors="coerce").fillna(0)
    path_summary = path_summary[path_summary["point_count"] >= MIN_POINTS]

# ── Compute derived features ───────────────────────────────────────────────────
if "std_x" in path_summary.columns and "std_y" in path_summary.columns:
    path_summary["std_x"] = pd.to_numeric(path_summary["std_x"], errors="coerce").fillna(0.0)
    path_summary["std_y"] = pd.to_numeric(path_summary["std_y"], errors="coerce").fillna(0.0)
    path_summary["pos_std_combined"] = np.sqrt(
        path_summary["std_x"] ** 2 + path_summary["std_y"] ** 2
    ).round(3)

# ── Sort and round ─────────────────────────────────────────────────────────────
if "start_time" in path_summary.columns:
    path_summary = path_summary.sort_values("start_time", ascending=False)

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

dwell_col = "dwell_seconds" if "dwell_seconds" in path_summary.columns else None
median_dwell = round(pd.to_numeric(path_summary[dwell_col], errors="coerce").median(), 1) if dwell_col else 0.0
max_dwell = round(pd.to_numeric(path_summary[dwell_col], errors="coerce").max(), 1) if dwell_col else 0.0
short_paths = int((pd.to_numeric(path_summary[dwell_col], errors="coerce") < 3).sum()) if dwell_col else 0
pct_short = round(100 * short_paths / total_paths, 1) if total_paths > 0 else 0

sensor_label = f" | sensor: {SENSOR_FILTER}" if SENSOR_FILTER else ""
date_label = ""
if START_DATE or END_DATE:
    date_label = f" | {START_DATE or '...'} to {END_DATE or '...'}"

summary = (
    f"Path aggregation: {total_paths} clean paths{sensor_label}{date_label}. "
    f"Median dwell: {median_dwell}s, max: {max_dwell}s. "
    f"{short_paths} paths ({pct_short}%) under 3 seconds."
)

columns = list(path_summary.columns)

print(json.dumps({
    "type": "table",
    "title": f"Clean Path Records ({total_paths} paths)",
    "data": path_summary.to_dict(orient="records"),
    "columns": columns,
    "summary": summary,
}))
