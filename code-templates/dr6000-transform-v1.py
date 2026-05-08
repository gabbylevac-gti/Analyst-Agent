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
  {{CSV_URL}}             URL of the raw CSV file (Supabase Storage or API response)
  {{STORE_OPEN_HOUR}}     First valid hour of day, inclusive (from Data Dictionary)
  {{STORE_CLOSE_HOUR}}    First invalid hour of day (from Data Dictionary)
  {{MIN_POINTS}}          Minimum readings per path (from Data Dictionary, default 2)
  {{ORG_ID}}              Organization ID (passed through to output for Mastra write)
  {{SOURCE_ID}}           data_sources.id for this sensor/dataset
  {{DICTIONARY_ID}}       data_dictionaries.id for this org's DR6000 Data Dictionary
  {{RAW_UPLOAD_ID}}       raw_data_uploads.id if CSV upload; empty string if API pull

Output: multi envelope — transformation summary table + clean paths data + text summary
        data.clean_paths: list of path-level records ready for dataset_records write
        data.provenance: org_id, source_id, dictionary_id, raw_upload_id for the write
"""

import pandas as pd
import numpy as np
import json

# ── Parameters ─────────────────────────────────────────────────────────────────
CSV_URL = "{{CSV_URL}}"
STORE_OPEN_HOUR = {{STORE_OPEN_HOUR}}
STORE_CLOSE_HOUR = {{STORE_CLOSE_HOUR}}
MIN_POINTS = {{MIN_POINTS}}
ORG_ID = "{{ORG_ID}}"
SOURCE_ID = "{{SOURCE_ID}}"
DICTIONARY_ID = "{{DICTIONARY_ID}}"
RAW_UPLOAD_ID = "{{RAW_UPLOAD_ID}}" or None

# ── Load ───────────────────────────────────────────────────────────────────────
df = pd.read_csv(CSV_URL, parse_dates=["log_creation_time"])
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

# ── QR filter summary ──────────────────────────────────────────────────────────
filter_summary = [
    {
        "Rule": "QR-1: Off-Hours",
        "Threshold": f"hour < {STORE_OPEN_HOUR} or >= {STORE_CLOSE_HOUR}",
        "Rows Removed": rows_off_hours,
        "Rows % Removed": round(100 * rows_off_hours / total_rows_raw, 1),
        "Paths Removed": paths_off_hours,
        "Status": "Applied",
    },
    {
        "Rule": "QR-2: Min Point Count",
        "Threshold": f"point_count < {MIN_POINTS}",
        "Rows Removed": rows_short,
        "Rows % Removed": round(100 * rows_short / total_rows_raw, 1),
        "Paths Removed": paths_short,
        "Status": "Applied",
    },
    {
        "Rule": "QR-3: Ghost Filter",
        "Threshold": "deployment-specific — applied at analysis time",
        "Rows Removed": 0,
        "Rows % Removed": 0.0,
        "Paths Removed": 0,
        "Status": "Deferred to analysis — confirm thresholds in Data Dictionary first",
    },
]

# ── Clean paths output (for dataset_records write) ────────────────────────────
clean_paths = paths[[
    "target_id", "session_date", "start_time", "end_time",
    "dwell_seconds", "point_count",
    "centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y",
    "start_hour", "sensor_name",
]].copy()
clean_paths["start_time"] = clean_paths["start_time"].astype(str)
clean_paths["end_time"] = clean_paths["end_time"].astype(str)

provenance = {
    "org_id": ORG_ID,
    "source_id": SOURCE_ID,
    "dictionary_id": DICTIONARY_ID,
    "raw_upload_id": RAW_UPLOAD_ID if RAW_UPLOAD_ID else None,
}

# ── Summary envelope ───────────────────────────────────────────────────────────
summary_table_envelope = {
    "type": "table",
    "title": f"Transformation Summary — {paths_retained} clean paths",
    "data": filter_summary,
    "columns": ["Rule", "Threshold", "Rows Removed", "Rows % Removed", "Paths Removed", "Status"],
    "summary": (
        f"Transformation applied to {total_rows_raw:,} rows / {total_paths_raw} paths. "
        f"QR-1 removed {paths_off_hours} paths (off-hours). "
        f"QR-2 removed {paths_short} paths (< {MIN_POINTS} points). "
        f"{paths_retained} clean paths retained ({date_range_str})."
    ),
}

text_content = f"""## Transformation Summary

**Period:** {date_range_str}
**Input:** {total_rows_raw:,} raw rows | {total_paths_raw} paths

### Quality Rules Applied
| Rule | Paths Removed | Notes |
|------|--------------|-------|
| QR-1 Off-Hours | {paths_off_hours} | Outside {STORE_OPEN_HOUR}:00–{STORE_CLOSE_HOUR}:00 |
| QR-2 Min Points | {paths_short} | Fewer than {MIN_POINTS} readings |

### Output
- **Clean paths written:** {paths_retained} path records
- **Date range:** {date_range_str}

### Not Applied Here
- **QR-3 Ghost Filter** — deployment-specific. Confirm GHOST_DWELL_S and GHOST_STD_M
  in the Data Dictionary (run `quality-check-sensor-v1.py` + `path-trajectory-plot.py`
  if not yet done), then apply at analysis time via `path-classification-v1.py`.

### Next Steps
1. Review this summary and confirm the clean path count looks reasonable
2. Approve → Mastra tool writes {paths_retained} records to `dataset_records`
3. Run `path-classification-v1.py` or `engagement-metrics-v1.py` for analysis
"""

text_envelope = {
    "type": "text",
    "title": "Transformation Summary",
    "content": text_content,
    "summary": (
        f"Transformation complete. {paths_retained} of {total_paths_raw} paths retained "
        f"after QR-1 and QR-2. QR-3 ghost filter deferred to analysis time. "
        f"Period: {date_range_str}."
    ),
}

# ── Output ─────────────────────────────────────────────────────────────────────
print(json.dumps({
    "type": "multi",
    "title": f"DR6000 Transformation — {paths_retained} clean paths",
    "artifacts": [summary_table_envelope, text_envelope],
    "data": {
        "clean_paths": clean_paths.to_dict(orient="records"),
        "provenance": provenance,
        "paths_retained": paths_retained,
        "date_range": date_range_str,
    },
    "summary": (
        f"Transformation: {paths_retained} clean path records from {total_paths_raw} raw paths "
        f"({date_range_str}). QR-1 removed {paths_off_hours} off-hours paths; "
        f"QR-2 removed {paths_short} short paths. Ghost filter deferred to analysis."
    ),
}))
