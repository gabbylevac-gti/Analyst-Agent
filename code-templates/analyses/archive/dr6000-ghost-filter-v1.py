import pandas as pd
import json

# ── Parameters ────────────────────────────────────────────────────────────────
CSV_URL = "{{CSV_URL}}"
DWELL_THRESHOLD_SECONDS = {{DWELL_THRESHOLD_SECONDS}}   # ghost if dwell < this
POS_STD_THRESHOLD_M = {{POS_STD_THRESHOLD_M}}           # ghost if std_x AND std_y < this

# ── Load DR6000 paths report ──────────────────────────────────────────────────
df = pd.read_csv(CSV_URL, parse_dates=["log_creation_time"])

# ── Aggregate to path level ───────────────────────────────────────────────────
paths = df.groupby("target_id").agg(
    start_time=("log_creation_time", "min"),
    end_time=("log_creation_time", "max"),
    point_count=("log_creation_time", "count"),
    std_x=("x_m", "std"),
    std_y=("y_m", "std"),
    centroid_x=("x_m", "mean"),
    centroid_y=("y_m", "mean"),
).reset_index()

paths["dwell_seconds"] = (
    paths["end_time"] - paths["start_time"]
).dt.total_seconds()

# Single-point paths have NaN std — treat as 0 (did not move)
paths["std_x"] = paths["std_x"].fillna(0.0)
paths["std_y"] = paths["std_y"].fillna(0.0)

# ── Ghost classification ───────────────────────────────────────────────────────
is_low_dwell = paths["dwell_seconds"] < DWELL_THRESHOLD_SECONDS
is_stationary = (
    (paths["std_x"] < POS_STD_THRESHOLD_M) &
    (paths["std_y"] < POS_STD_THRESHOLD_M)
)

paths["ghost_reason"] = "real"
paths.loc[is_low_dwell & ~is_stationary, "ghost_reason"] = "low_dwell"
paths.loc[~is_low_dwell & is_stationary, "ghost_reason"] = "stationary"
paths.loc[is_low_dwell & is_stationary, "ghost_reason"] = "low_dwell+stationary"

# ── Summary ───────────────────────────────────────────────────────────────────
total = len(paths)
ghost_count = int((paths["ghost_reason"] != "real").sum())
real_count = total - ghost_count
ghost_rate = round(ghost_count / total * 100, 1) if total > 0 else 0.0
reason_counts = paths["ghost_reason"].value_counts().to_dict()

out = paths[[
    "target_id", "ghost_reason", "dwell_seconds", "std_x", "std_y", "point_count"
]].copy()
out["dwell_seconds"] = out["dwell_seconds"].round(2)
out["std_x"] = out["std_x"].round(3)
out["std_y"] = out["std_y"].round(3)
out = out.sort_values("ghost_reason")

print(json.dumps({
    "type": "table",
    "title": f"Ghost Filter — {ghost_rate}% Ghost Rate ({ghost_count}/{total} paths removed)",
    "data": out.to_dict(orient="records"),
    "columns": ["target_id", "ghost_reason", "dwell_seconds", "std_x", "std_y", "point_count"],
    "summary": (
        f"{total} paths: {real_count} real, {ghost_count} ghost ({ghost_rate}%). "
        f"Thresholds: dwell < {DWELL_THRESHOLD_SECONDS}s OR pos_std < {POS_STD_THRESHOLD_M}m. "
        f"Reasons: {reason_counts}."
    ),
    "meta": {
        "total_paths": total,
        "real_paths": real_count,
        "ghost_paths": ghost_count,
        "ghost_rate_pct": ghost_rate,
        "reason_breakdown": reason_counts,
        "thresholds": {
            "dwell_seconds": DWELL_THRESHOLD_SECONDS,
            "pos_std_m": POS_STD_THRESHOLD_M,
        },
    },
}))
