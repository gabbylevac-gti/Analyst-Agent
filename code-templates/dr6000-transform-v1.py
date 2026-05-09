"""
Template: dr6000-transform-v1
Stage:    Transformation (Stage 1 — Raw → Clean)
Type:     transformation
Purpose:  Standardizes raw DR6000 paths data to the platform's clean layer.
          Applies QR-1 (off-hours exclusion) and QR-2 (min point count),
          then aggregates raw per-row readings to one path-level record per
          target_id. Returns the clean paths dataset and a transformation
          summary for review before Postgres write.

          Ghost filter (QR-3) is NOT applied here. It is deployment-specific
          and applied at analysis time using confirmed thresholds from the
          org's Data Dictionary.

          The Mastra tool that calls this template reads data.clean_paths
          and writes each record to dataset_records (Postgres clean layer),
          linking to source_id, dictionary_id, and raw_upload_id.

          Run this:
            - After CSV upload or API fetch for any new data batch
            - Automatically (future): triggered on ingestion during /onboard
              historical load and nightly campaign data sync

Inputs ({{PLACEHOLDER}} tokens):
  {{STORE_OPEN_HOUR}}     First valid hour of day, inclusive (from Data Dictionary)
  {{STORE_CLOSE_HOUR}}    First invalid hour of day (from Data Dictionary)
  {{MIN_POINTS}}          Minimum readings per path (from Data Dictionary, default 2)

Note: CSV_URL is not a parameter — the tool writes the CSV to /sandbox/upload.csv before running this code.

Output: transform envelope — { type: "transform", rows: [...], summary: "..." }
        rows: list of path-level records written to dataset_records by executeTransform
        The tool reads this envelope and handles the Postgres write.
"""

import pandas as pd
import numpy as np
import json

# ── Parameters ─────────────────────────────────────────────────────────────────
STORE_OPEN_HOUR = {{STORE_OPEN_HOUR}}
STORE_CLOSE_HOUR = {{STORE_CLOSE_HOUR}}
MIN_POINTS = {{MIN_POINTS}}

# ── Load ───────────────────────────────────────────────────────────────────────
# The executeTransform tool writes the raw CSV to /sandbox/upload.csv before running this code.
df = pd.read_csv("/sandbox/upload.csv", parse_dates=["log_creation_time"])
total_rows_raw = len(df)
total_paths_raw = df["target_id"].nunique()

if total_rows_raw == 0:
    print(json.dumps({
        "type": "error", "title": "Empty Dataset",
        "message": "CSV returned 0 rows. Check the data source and time range.",
        "traceback": ""
    }))
    raise SystemExit

df["hour_of_day"] = df["log_creation_time"].dt.hour

# ── QR-1: Off-Hours Exclusion ──────────────────────────────────────────────────
off_hours_mask = (df["hour_of_day"] < STORE_OPEN_HOUR) | (df["hour_of_day"] >= STORE_CLOSE_HOUR)
rows_off_hours = int(off_hours_mask.sum())
paths_off_hours = int(df.loc[off_hours_mask, "target_id"].nunique())
df = df[~off_hours_mask].copy()

# ── QR-2: Minimum Point Count ──────────────────────────────────────────────────
path_counts = df.groupby("target_id").size()
short_path_ids = set(path_counts[path_counts < MIN_POINTS].index)
rows_short = int(df["target_id"].isin(short_path_ids).sum())
paths_short = len(short_path_ids)
df = df[~df["target_id"].isin(short_path_ids)].copy()

rows_retained = len(df)
paths_retained = df["target_id"].nunique()

if paths_retained == 0:
    print(json.dumps({
        "type": "error", "title": "No paths after quality rules",
        "message": (
            f"All {total_paths_raw} paths were removed by QR-1 (off-hours) or QR-2 (min points). "
            "Check store hours and MIN_POINTS settings."
        ),
        "traceback": ""
    }))
    raise SystemExit

# ── Aggregate to path level ────────────────────────────────────────────────────
paths = (
    df.groupby("target_id")
    .agg(
        start_time=("log_creation_time", "min"),
        end_time=("log_creation_time", "max"),
        point_count=("log_creation_time", "count"),
        centroid_x=("x_m", "mean"),
        centroid_y=("y_m", "mean"),
        std_x=("x_m", "std"),
        std_y=("y_m", "std"),
        range_x=("x_m", lambda x: x.max() - x.min()),
        range_y=("y_m", lambda x: x.max() - x.min()),
        sensor_name=("sensor_name", "first"),
    )
    .reset_index()
)

paths["dwell_seconds"] = (paths["end_time"] - paths["start_time"]).dt.total_seconds()
paths["std_x"] = paths["std_x"].fillna(0.0)
paths["std_y"] = paths["std_y"].fillna(0.0)
paths["start_hour"] = paths["start_time"].dt.hour
paths["session_date"] = paths["start_time"].dt.date.astype(str)

# Round for clean storage
for col in ["centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y"]:
    paths[col] = paths[col].round(3)
paths["dwell_seconds"] = paths["dwell_seconds"].round(2)

date_range_str = f"{paths['session_date'].min()} to {paths['session_date'].max()}"

# ── Clean paths for dataset_records ───────────────────────────────────────────
clean_paths = paths[[
    "target_id", "session_date", "start_time", "end_time",
    "dwell_seconds", "point_count",
    "centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y",
    "start_hour", "sensor_name",
]].copy()
clean_paths["start_time"] = clean_paths["start_time"].astype(str)
clean_paths["end_time"] = clean_paths["end_time"].astype(str)

# ── Output: transform contract ─────────────────────────────────────────────────
# executeTransform reads this envelope and writes rows to dataset_records.
# The summary becomes the agent's confirmation message after the write.
print(json.dumps({
    "type": "transform",
    "rows": clean_paths.to_dict(orient="records"),
    "summary": (
        f"Transformation: {paths_retained:,} clean path records from {total_paths_raw:,} raw paths "
        f"({date_range_str}). "
        f"QR-1 removed {paths_off_hours} off-hours paths. "
        f"QR-2 removed {paths_short} paths under {MIN_POINTS} readings. "
        f"Ghost filter (QR-3) deferred to analysis time."
    ),
}))
