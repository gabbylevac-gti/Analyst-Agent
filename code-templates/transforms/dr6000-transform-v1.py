"""
Template: dr6000-transform-v1
Stage:    Transformation (Stage 1 — Raw → Clean)
Type:     transformation
Purpose:  Standardizes raw DR6000 paths data to the typed clean layer.
          Applies QR-1 (off-hours exclusion), QR-2 (min point count), and
          QR-3 (path classification: engaged vs passer_by), then writes
          classified observations and pre-computed aggregations to Postgres.

Inputs ({{PLACEHOLDER}} tokens):
  {{STORE_OPEN_HOUR}}      First valid hour of day, inclusive
  {{STORE_CLOSE_HOUR}}     First invalid hour of day, exclusive
  {{MIN_POINTS}}           Minimum readings per path (paths below this are ghost noise — removed)
  {{ENGAGED_THRESHOLD}}    Dwell seconds threshold for 'engaged' vs 'passer_by' classification

System env vars (injected by executeTransform — not in template parameters JSONB):
  RAW_UPLOAD_ID  — raw_data_uploads.id
  ORG_ID         — organizations.id
  DATASET_ID     — datasets.id (may be empty string if not yet linked)
  DB_URL         — Postgres connection string for psycopg2

Outputs written to Postgres:
  audience_observations — one row per classified path
  audience_15min_agg    — 15-minute aggregation windows
  audience_day_agg      — daily aggregations

Output envelope: {
  type, observationsWritten, agg15minWritten, aggDayWritten,
  classificationCounts, qualityRules, summary
}
"""

import os
import json
import psycopg2
import psycopg2.extras
import pandas as pd
import numpy as np

# ── Parameters ─────────────────────────────────────────────────────────────────
STORE_OPEN_HOUR   = {{STORE_OPEN_HOUR}}
STORE_CLOSE_HOUR  = {{STORE_CLOSE_HOUR}}
MIN_POINTS        = {{MIN_POINTS}}
ENGAGED_THRESHOLD = {{ENGAGED_THRESHOLD}}

# ── System params (injected via env vars, not template placeholders) ────────────
RAW_UPLOAD_ID  = os.environ["RAW_UPLOAD_ID"]
ORG_ID         = os.environ["ORG_ID"]
DATASET_ID     = os.environ.get("DATASET_ID") or None
DB_URL         = os.environ["DB_URL"]
VENDOR_SOURCE  = "datalogiq"
HARDWARE_MODEL = "DR6000"

# ── Load ───────────────────────────────────────────────────────────────────────
df = pd.read_csv("/sandbox/upload.csv", parse_dates=["log_creation_time"])
total_rows_raw  = len(df)
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
off_hours_mask  = (df["hour_of_day"] < STORE_OPEN_HOUR) | (df["hour_of_day"] >= STORE_CLOSE_HOUR)
rows_off_hours  = int(off_hours_mask.sum())
paths_off_hours = int(df.loc[off_hours_mask, "target_id"].nunique())
df = df[~off_hours_mask].copy()

# ── QR-2: Minimum Point Count (removes ghost/noise paths) ─────────────────────
path_counts    = df.groupby("target_id").size()
short_path_ids = set(path_counts[path_counts < MIN_POINTS].index)
rows_short     = int(df["target_id"].isin(short_path_ids).sum())
paths_short    = len(short_path_ids)
df = df[~df["target_id"].isin(short_path_ids)].copy()

if df["target_id"].nunique() == 0:
    print(json.dumps({
        "type": "error", "title": "No paths after quality rules",
        "message": (
            f"All {total_paths_raw} paths removed by QR-1 (off-hours) or QR-2 (min readings). "
            "Check store hours and MIN_POINTS settings."
        ),
        "traceback": ""
    }))
    raise SystemExit

# ── Aggregate to path level ────────────────────────────────────────────────────
paths = (
    df.groupby("target_id")
    .agg(
        start_time   = ("log_creation_time", "min"),
        end_time     = ("log_creation_time", "max"),
        point_count  = ("log_creation_time", "count"),
        centroid_x   = ("x_m", "mean"),
        centroid_y   = ("y_m", "mean"),
        std_x        = ("x_m", "std"),
        std_y        = ("y_m", "std"),
        range_x      = ("x_m", lambda x: x.max() - x.min()),
        range_y      = ("y_m", lambda x: x.max() - x.min()),
        sensor_name  = ("sensor_name", "first"),
    )
    .reset_index()
)

paths["dwell_seconds"] = (paths["end_time"] - paths["start_time"]).dt.total_seconds()
paths["std_x"]        = paths["std_x"].fillna(0.0)
paths["std_y"]        = paths["std_y"].fillna(0.0)
paths["start_hour"]   = paths["start_time"].dt.hour
paths["session_date"] = paths["start_time"].dt.date

for col in ["centroid_x", "centroid_y", "std_x", "std_y", "range_x", "range_y"]:
    paths[col] = paths[col].round(3)
paths["dwell_seconds"] = paths["dwell_seconds"].round(2)

# ── QR-3: Path Classification ──────────────────────────────────────────────────
# Ghost paths (sensor noise) already removed by QR-2.
# Remaining paths: engaged (dwell >= threshold) or passer_by (dwell < threshold).
paths["path_classification"] = paths["dwell_seconds"].apply(
    lambda d: "engaged" if d >= ENGAGED_THRESHOLD else "passer_by"
)

engaged_total   = int((paths["path_classification"] == "engaged").sum())
passer_by_total = int((paths["path_classification"] == "passer_by").sum())
obs_count       = len(paths)
date_range_str  = f"{paths['session_date'].min()} to {paths['session_date'].max()}"

# ── Compute aggregations ───────────────────────────────────────────────────────
paths["period_start"] = paths["start_time"].dt.floor("15min")
paths["period_end"]   = paths["period_start"] + pd.Timedelta(minutes=15)

engaged_paths = paths[paths["path_classification"] == "engaged"]

agg_15_base = paths.groupby(["period_start", "period_end"]).agg(
    engaged_count   = ("path_classification", lambda x: (x == "engaged").sum()),
    passer_by_count = ("path_classification", lambda x: (x == "passer_by").sum()),
    total_paths     = ("path_classification", "count"),
).reset_index()

agg_15_dwell = engaged_paths.groupby("period_start").agg(
    avg_dwell_engaged_seconds    = ("dwell_seconds", "mean"),
    median_dwell_engaged_seconds = ("dwell_seconds", "median"),
    engaged_dwell_seconds_array  = ("dwell_seconds", list),
).reset_index()

agg_15 = agg_15_base.merge(agg_15_dwell, on="period_start", how="left")

agg_day_base = paths.groupby("session_date").agg(
    engaged_count   = ("path_classification", lambda x: (x == "engaged").sum()),
    passer_by_count = ("path_classification", lambda x: (x == "passer_by").sum()),
    total_paths     = ("path_classification", "count"),
).reset_index()

agg_day_dwell = engaged_paths.groupby("session_date").agg(
    avg_dwell_engaged_seconds   = ("dwell_seconds", "mean"),
    engaged_dwell_seconds_array = ("dwell_seconds", list),
).reset_index()

peak_hours_df = (
    paths.groupby(["session_date", "start_hour"])
    .size()
    .reset_index(name="hour_count")
)
peak_hours_df = (
    peak_hours_df
    .loc[peak_hours_df.groupby("session_date")["hour_count"].idxmax()]
    .rename(columns={"start_hour": "peak_hour", "hour_count": "peak_hour_count"})
)

agg_day = agg_day_base.merge(agg_day_dwell, on="session_date", how="left")
agg_day = agg_day.merge(
    peak_hours_df[["session_date", "peak_hour", "peak_hour_count"]],
    on="session_date", how="left"
)

# ── Write to Postgres ──────────────────────────────────────────────────────────
conn = psycopg2.connect(DB_URL)
try:
    cur = conn.cursor()

    obs_rows = [
        (
            ORG_ID, RAW_UPLOAD_ID, DATASET_ID,
            str(row["target_id"]),
            str(row["sensor_name"]) if pd.notna(row["sensor_name"]) else None,
            row["session_date"],
            VENDOR_SOURCE, HARDWARE_MODEL,
            str(row["start_time"]), str(row["end_time"]),
            float(row["dwell_seconds"]),
            float(row["centroid_x"]) if pd.notna(row["centroid_x"]) else None,
            float(row["centroid_y"]) if pd.notna(row["centroid_y"]) else None,
            float(row["std_x"])      if pd.notna(row["std_x"])      else None,
            float(row["std_y"])      if pd.notna(row["std_y"])      else None,
            float(row["range_x"])    if pd.notna(row["range_x"])    else None,
            float(row["range_y"])    if pd.notna(row["range_y"])    else None,
            int(row["start_hour"])   if pd.notna(row["start_hour"]) else None,
            int(row["point_count"]),
            row["path_classification"],
        )
        for _, row in paths.iterrows()
    ]

    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO audience_observations (
            org_id, raw_upload_id, dataset_id,
            target_id, sensor_name, session_date,
            vendor_source, hardware_model,
            start_time, end_time, dwell_seconds,
            centroid_x, centroid_y, std_x, std_y, range_x, range_y,
            start_hour, point_count, path_classification
        ) VALUES %s
        """,
        obs_rows,
        page_size=500,
    )

    agg_15_rows = [
        (
            ORG_ID, RAW_UPLOAD_ID, DATASET_ID,
            str(row["period_start"]), str(row["period_end"]),
            int(row["engaged_count"]), int(row["passer_by_count"]), int(row["total_paths"]),
            float(row["avg_dwell_engaged_seconds"])    if pd.notna(row.get("avg_dwell_engaged_seconds"))    else None,
            float(row["median_dwell_engaged_seconds"]) if pd.notna(row.get("median_dwell_engaged_seconds")) else None,
            row.get("engaged_dwell_seconds_array") if isinstance(row.get("engaged_dwell_seconds_array"), list) else None,
        )
        for _, row in agg_15.iterrows()
    ]

    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO audience_15min_agg (
            org_id, raw_upload_id, dataset_id,
            period_start, period_end,
            engaged_count, passer_by_count, total_paths,
            avg_dwell_engaged_seconds, median_dwell_engaged_seconds,
            engaged_dwell_seconds_array
        ) VALUES %s
        """,
        agg_15_rows,
        page_size=500,
    )

    agg_day_rows = [
        (
            ORG_ID, RAW_UPLOAD_ID, DATASET_ID,
            row["session_date"],
            int(row["engaged_count"]), int(row["passer_by_count"]), int(row["total_paths"]),
            float(row["avg_dwell_engaged_seconds"]) if pd.notna(row.get("avg_dwell_engaged_seconds")) else None,
            int(row["peak_hour"])       if pd.notna(row.get("peak_hour"))       else None,
            int(row["peak_hour_count"]) if pd.notna(row.get("peak_hour_count")) else None,
            row.get("engaged_dwell_seconds_array") if isinstance(row.get("engaged_dwell_seconds_array"), list) else None,
        )
        for _, row in agg_day.iterrows()
    ]

    psycopg2.extras.execute_values(
        cur,
        """
        INSERT INTO audience_day_agg (
            org_id, raw_upload_id, dataset_id,
            date,
            engaged_count, passer_by_count, total_paths,
            avg_dwell_engaged_seconds,
            peak_hour, peak_hour_count,
            engaged_dwell_seconds_array
        ) VALUES %s
        """,
        agg_day_rows,
        page_size=500,
    )

    conn.commit()
    cur.close()

except Exception as e:
    conn.rollback()
    conn.close()
    print(json.dumps({
        "type": "error", "title": "Database write failed",
        "message": str(e),
        "traceback": ""
    }))
    raise SystemExit

conn.close()

print(json.dumps({
    "type": "transform",
    "observationsWritten": obs_count,
    "agg15minWritten": len(agg_15_rows),
    "aggDayWritten": len(agg_day_rows),
    "classificationCounts": {"engaged": engaged_total, "passer_by": passer_by_total},
    "qualityRules": {"offHoursRemoved": paths_off_hours, "belowMinPointsRemoved": paths_short},
    "summary": (
        f"Transform complete: {obs_count:,} paths written ({engaged_total:,} engaged, "
        f"{passer_by_total:,} passer-by) from {date_range_str}. "
        f"QR-1 removed {paths_off_hours} off-hours paths. "
        f"QR-2 removed {paths_short} noise paths under {MIN_POINTS} readings. "
        f"QR-3 classified at {ENGAGED_THRESHOLD}s threshold. "
        f"{len(agg_15_rows)} 15-min windows and {len(agg_day_rows)} day summaries computed."
    ),
}))
