"""
Template: quality-check-sensor-v1
Stage:    Transformation diagnostic (Stage 1 — run before dr6000-transform-v1.py)
Purpose:  Diagnostic check on a raw DR6000 paths CSV.
          Reports how many rows and paths QR-1 (off-hours) and QR-2 (min point count)
          would filter, WITHOUT modifying data. Also reports the observed x/y coordinate
          ranges (informational — the sensor validates positional bounds before output).
          Evaluates candidate ghost thresholds (QR-3) at path level.

          Use this to calibrate deployment-specific parameters before committing them
          to the Data Dictionary and running dr6000-transform-v1.py.

          Run this:
            - Before the first transformation run for any new deployment
            - After changing store hours or ghost thresholds in the Data Dictionary
            - When ghost rates seem unexpectedly high or low

Inputs ({{PLACEHOLDER}} tokens):
  {{CSV_URL}}             Public URL of the raw CSV file
  {{STORE_OPEN_HOUR}}     First valid hour of day, inclusive (from Data Dictionary)
  {{STORE_CLOSE_HOUR}}    First invalid hour of day (from Data Dictionary)
  {{MIN_POINTS}}          Minimum readings per path (from Data Dictionary, default 2)
  {{GHOST_DWELL_S}}       Ghost dwell threshold in seconds (from Data Dictionary — deployment-specific;
                          catalog starting point ~3.0s, confirm via trajectory inspection before finalizing)
  {{GHOST_STD_M}}         Ghost positional std threshold in meters (from Data Dictionary — deployment-specific;
                          catalog starting point ~0.15m, confirm via trajectory inspection before finalizing)

Output: multi envelope — QC summary table + text recommendations
"""

import pandas as pd
import numpy as np
import json

# ── Parameters ─────────────────────────────────────────────────────────────────
CSV_URL = "{{CSV_URL}}"
STORE_OPEN_HOUR = {{STORE_OPEN_HOUR}}
STORE_CLOSE_HOUR = {{STORE_CLOSE_HOUR}}
MIN_POINTS = {{MIN_POINTS}}
GHOST_DWELL_S = {{GHOST_DWELL_S}}
GHOST_STD_M = {{GHOST_STD_M}}

# ── Load ───────────────────────────────────────────────────────────────────────
df = pd.read_csv(CSV_URL, parse_dates=["log_creation_time"])
total_rows = len(df)
total_paths = df["target_id"].nunique()

if total_rows == 0:
    print(json.dumps({
        "type": "error", "title": "Empty Dataset",
        "message": "CSV returned 0 rows. Check the time range and endpoint.",
        "traceback": ""
    }))
    raise SystemExit

df["hour_of_day"] = df["log_creation_time"].dt.hour
results = []

# ── QR-1: Off-Hours Exclusion ──────────────────────────────────────────────────
off_hours_mask = (df["hour_of_day"] < STORE_OPEN_HOUR) | (df["hour_of_day"] >= STORE_CLOSE_HOUR)
oh_rows = int(off_hours_mask.sum())
oh_paths = int(df.loc[off_hours_mask, "target_id"].nunique())
results.append({
    "Rule": "QR-1: Off-Hours",
    "Threshold": f"hour < {STORE_OPEN_HOUR} or >= {STORE_CLOSE_HOUR}",
    "Rows Flagged": oh_rows,
    "Rows %": round(100 * oh_rows / total_rows, 1),
    "Paths Affected": oh_paths,
    "Action": "Apply" if oh_rows > 0 else "No off-hours data found",
})

# ── QR-2: Minimum Point Count ──────────────────────────────────────────────────
path_counts = df.groupby("target_id").size()
short_path_ids = set(path_counts[path_counts < MIN_POINTS].index)
short_rows = int(df["target_id"].isin(short_path_ids).sum())
short_paths = len(short_path_ids)
results.append({
    "Rule": "QR-2: Min Point Count",
    "Threshold": f"point_count < {MIN_POINTS}",
    "Rows Flagged": short_rows,
    "Rows %": round(100 * short_rows / total_rows, 1),
    "Paths Affected": short_paths,
    "Action": "Apply" if short_paths > 0 else "None found — clean",
})

# ── QR-3: Ghost Filter (applied to data passing QR-1 and QR-2) ────────────────
clean_df = df[~off_hours_mask & ~df["target_id"].isin(short_path_ids)].copy()
clean_total = clean_df["target_id"].nunique()

if clean_total > 0:
    path_agg = (
        clean_df.groupby("target_id")
        .agg(
            dwell_s=("log_creation_time", lambda x: (x.max() - x.min()).total_seconds()),
            std_x=("x_m", "std"),
            std_y=("y_m", "std"),
        )
        .fillna(0)
        .reset_index()
    )
    ghost_mask_path = (
        (path_agg["dwell_s"] < GHOST_DWELL_S) &
        (path_agg["std_x"] < GHOST_STD_M) &
        (path_agg["std_y"] < GHOST_STD_M)
    )
    ghost_paths = int(ghost_mask_path.sum())
    ghost_rate = round(100 * ghost_paths / clean_total, 1)
    ghost_rows = int(clean_df["target_id"].isin(path_agg.loc[ghost_mask_path, "target_id"]).sum())
else:
    ghost_paths, ghost_rate, ghost_rows = 0, 0.0, 0

results.append({
    "Rule": "QR-3: Ghost Filter",
    "Threshold": f"dwell < {GHOST_DWELL_S}s AND std_x,y < {GHOST_STD_M}m",
    "Rows Flagged": ghost_rows,
    "Rows %": round(100 * ghost_rows / total_rows, 1) if total_rows > 0 else 0.0,
    "Paths Affected": ghost_paths,
    "Action": (
        "⚠ Very high ghost rate — check sensor calibration"
        if ghost_rate > 60
        else "⚠ High ghost rate — validate thresholds with trajectory plot before committing to Data Dictionary"
        if ghost_rate > 30
        else "Thresholds look reasonable — validate with trajectory plot before committing to Data Dictionary" if ghost_rate > 5
        else "Low ghost rate — thresholds may be too strict or deployment is unusually clean"
    ),
})

# ── Post-filter estimate ───────────────────────────────────────────────────────
retained_paths = clean_total - ghost_paths
pct_retained = round(100 * retained_paths / total_paths, 1) if total_paths > 0 else 0.0

# ── Actual x/y ranges (informational — sensor validates bounds before output) ──
x_actual_min = round(float(df["x_m"].dropna().min()), 2) if df["x_m"].notna().any() else None
x_actual_max = round(float(df["x_m"].dropna().max()), 2) if df["x_m"].notna().any() else None
y_actual_min = round(float(df["y_m"].dropna().min()), 2) if df["y_m"].notna().any() else None
y_actual_max = round(float(df["y_m"].dropna().max()), 2) if df["y_m"].notna().any() else None

# ── Table envelope ─────────────────────────────────────────────────────────────
table_envelope = {
    "type": "table",
    "title": f"Quality Check — {total_paths} paths, {total_rows:,} rows",
    "data": results,
    "columns": ["Rule", "Threshold", "Rows Flagged", "Rows %", "Paths Affected", "Action"],
    "summary": (
        f"QC on {total_rows:,} rows / {total_paths} paths. "
        f"Off-hours: {results[0]['Rows %']}% of rows. "
        f"Ghost rate at candidate threshold (after QR-1+QR-2): {ghost_rate}%. "
        f"Estimated {retained_paths} paths ({pct_retained}%) retained after all rules."
    ),
}

# ── Text recommendations ───────────────────────────────────────────────────────
date_range = (
    f"{df['log_creation_time'].min().date()} to {df['log_creation_time'].max().date()}"
)
sensor_names = (
    ", ".join(df["sensor_name"].dropna().unique().tolist())
    if "sensor_name" in df.columns else "unknown"
)

coord_note = (
    f"Observed x range: [{x_actual_min}, {x_actual_max}]m  |  "
    f"Observed y range: [{y_actual_min}, {y_actual_max}]m\n"
    "Note: x=0 is directly in front of the sensor; negative x is left (both valid). "
    "The sensor validates positional bounds before output — this is informational only."
)

text_content = f"""## Quality Check Results

**Dataset:** {total_rows:,} rows | {total_paths} unique paths | {date_range}
**Sensors:** {sensor_names}

**After QR-1 + QR-2 + QR-3 (ghost at candidate threshold):**
- Estimated clean paths: **{retained_paths} of {total_paths} ({pct_retained}%)**
- Ghost rate at candidate threshold: **{ghost_rate}%**

**Observed coordinate ranges (informational):**
{coord_note}

**Rules with impact:**
""" + "\n".join([
    f"- **{r['Rule']}**: {r['Paths Affected']} paths — {r['Action']}"
    for r in results
    if r["Paths Affected"] > 0
]) + f"""

**Ghost threshold validation required (QR-3):**
Thresholds (dwell < {GHOST_DWELL_S}s, std < {GHOST_STD_M}m) are deployment-specific.
Platform confidence in catalog starting points: 0.60–0.65. Before committing to the
Data Dictionary, run `path-trajectory-plot.py` on 10–20 borderline paths (dwell 2–5s)
to confirm they are artifacts, not genuine short engagements. Confidence increases to
≥0.80 after trajectory inspection is complete.

**Recommended next step:**
Run `path-trajectory-plot.py` to validate ghost thresholds visually. Once confirmed,
record in the Data Dictionary, then run `dr6000-transform-v1.py` to write clean data to Postgres.
"""

text_envelope = {
    "type": "text",
    "title": "QC Recommendations",
    "content": text_content,
    "summary": (
        f"QC complete. {retained_paths}/{total_paths} paths pass all rules ({pct_retained}%). "
        f"Ghost rate {ghost_rate}% on filtered data."
    ),
}

# ── Output ─────────────────────────────────────────────────────────────────────
print(json.dumps({
    "type": "multi",
    "title": "DR6000 Data Quality Check",
    "artifacts": [table_envelope, text_envelope],
    "summary": (
        f"Quality check: {total_rows:,} rows, {total_paths} paths. "
        f"Estimated {retained_paths} paths ({pct_retained}%) pass all rules. "
        f"Ghost rate {ghost_rate}% (threshold: dwell < {GHOST_DWELL_S}s, std < {GHOST_STD_M}m)."
    ),
}))
