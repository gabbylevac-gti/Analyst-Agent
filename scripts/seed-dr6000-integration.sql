-- =============================================================================
-- Seed: Data Realities Radar (DR6000) Integration
-- =============================================================================
-- Run this after a new data-realities-radar integration is created for an org.
--
-- Replace YOUR_ORG_ID_HERE with the actual org UUID before running.
--
-- Seeds:
--   1. datasets         — data dictionaries for sessions + paths reports
--   2. knowledge_beliefs — 5 DR6000-specific seed beliefs
--   3. code_templates   — dr6000-ghost-filter-v1
--
-- Idempotent: uses EXISTS checks so re-running is safe.
--
-- Automated trigger: the app calls supabase.rpc('seed_integration', { p_org_id, p_vendor })
-- after creating an integration. See scripts/create-seed-integration-rpc.sql.
-- =============================================================================

DO $$
DECLARE
  v_org_id UUID := 'YOUR_ORG_ID_HERE';  -- <-- replace this
BEGIN

-- =============================================================================
-- 1. DATA DICTIONARIES
-- =============================================================================

-- DR6000 Paths Report ─────────────────────────────────────────────────────────
-- Use for: spatial movement, trajectories, heatmaps, ghost path detection
INSERT INTO datasets (
  org_id, vendor, filename, column_signature,
  schema_json, data_dictionary_json,
  deployment_context, approval_status, upload_session_id
)
SELECT
  v_org_id,
  'data-realities-radar',
  'dr6000_paths_report.csv',
  'processed_at,account_id,device_id,log_creation_time,timezone_offset,timezone_label,sensor_id,sensor_name,mac_address,target_id,x_m,y_m',
  '{"source": "DR6000 API v2.0", "report_type": "paths", "row_unit": "one row per ~1-second position reading per target"}'::jsonb,
  '[
    {"column": "processed_at",     "display_name": "Processed At",        "data_type": "timestamp",    "description": "Pipeline processing timestamp.",                                                                               "units": null,      "notes": "Do NOT use for temporal analysis. Use log_creation_time."},
    {"column": "account_id",       "display_name": "Account ID",          "data_type": "identifier",   "description": "Account ID associated with the sensor.",                                                                      "units": null,      "notes": null},
    {"column": "device_id",        "display_name": "Device ID",           "data_type": "identifier",   "description": "ID of the edge device the sensor is associated with.",                                                        "units": null,      "notes": null},
    {"column": "log_creation_time","display_name": "Log Creation Time",   "data_type": "timestamp",    "description": "Timestamp of the position reading. Use this for ALL temporal analysis.",                                      "units": null,      "notes": "Primary time field. Always use this, never processed_at."},
    {"column": "timezone_offset",  "display_name": "Timezone Offset",     "data_type": "categorical",  "description": "Numeric offset from UTC in minutes.",                                                                         "units": "minutes", "notes": "e.g. -300 = UTC-5 (EST)"},
    {"column": "timezone_label",   "display_name": "Timezone Label",      "data_type": "categorical",  "description": "IANA timezone name.",                                                                                         "units": null,      "notes": "e.g. America/New_York"},
    {"column": "sensor_id",        "display_name": "Sensor ID",           "data_type": "identifier",   "description": "Unique identifier for the sensor device.",                                                                    "units": null,      "notes": null},
    {"column": "sensor_name",      "display_name": "Sensor Name",         "data_type": "categorical",  "description": "User-defined name for the sensor.",                                                                          "units": null,      "notes": "Multiple sensors may appear in one file. Analyze each separately unless cross-sensor alignment is the objective."},
    {"column": "mac_address",      "display_name": "MAC Address",         "data_type": "identifier",   "description": "Hardware MAC address of the edge device.",                                                                    "units": null,      "notes": null},
    {"column": "target_id",        "display_name": "Target ID",           "data_type": "identifier",   "description": "UUID assigned to a tracked entity for one continuous detection. Not persistent across separate appearances.", "units": null,      "notes": "Group by target_id for path-level aggregation."},
    {"column": "x_m",              "display_name": "X Position (m)",      "data_type": "coordinate",   "description": "Horizontal position from sensor centerline. Negative = left, positive = right.",                              "units": "meters",  "notes": "Sensor-local coordinate. 0 = sensor centerline."},
    {"column": "y_m",              "display_name": "Y Position (m)",      "data_type": "coordinate",   "description": "Depth from sensor. 0 = directly below sensor, positive = moving away.",                                      "units": "meters",  "notes": "Sensor-local coordinate. Physical orientation depends on sensor mounting direction."}
  ]'::jsonb,
  'DR6000 radar sensor paths report. One row per ~1-second position reading per detected target. Use for spatial analysis, heatmaps, trajectory visualization, and ghost path detection (requires x/y variance to compute positional std dev).',
  'approved',
  null
WHERE NOT EXISTS (
  SELECT 1 FROM datasets
  WHERE org_id = v_org_id
    AND column_signature = 'processed_at,account_id,device_id,log_creation_time,timezone_offset,timezone_label,sensor_id,sensor_name,mac_address,target_id,x_m,y_m'
);

-- DR6000 Sessions Report ──────────────────────────────────────────────────────
-- Use for: traffic volume, dwell time, engagement rates, zone analysis, proximity
INSERT INTO datasets (
  org_id, vendor, filename, column_signature,
  schema_json, data_dictionary_json,
  deployment_context, approval_status, upload_session_id
)
SELECT
  v_org_id,
  'data-realities-radar',
  'dr6000_sessions_report.csv',
  'processed_at,account_id,device_id,log_creation_time,timezone_offset,timezone_label,sensor_id,sensor_name,mac_address,target_id,dwell_tracking_area_sec,zone_dwell_times_json,proximity_m',
  '{"source": "DR6000 API v2.0", "report_type": "sessions", "row_unit": "one row per person-visit (target entering and leaving sensor field of view)"}'::jsonb,
  '[
    {"column": "processed_at",              "display_name": "Processed At",          "data_type": "timestamp",    "description": "Pipeline processing timestamp.",                                                                               "units": null,      "notes": "Do NOT use for temporal analysis. Use log_creation_time."},
    {"column": "account_id",                "display_name": "Account ID",            "data_type": "identifier",   "description": "Account ID associated with the sensor.",                                                                      "units": null,      "notes": null},
    {"column": "device_id",                 "display_name": "Device ID",             "data_type": "identifier",   "description": "ID of the edge device the sensor is associated with.",                                                        "units": null,      "notes": null},
    {"column": "log_creation_time",         "display_name": "Log Creation Time",     "data_type": "timestamp",    "description": "Timestamp of the session (when the visit was recorded). Use this for ALL temporal analysis.",                  "units": null,      "notes": "Primary time field. Always use this, never processed_at."},
    {"column": "timezone_offset",           "display_name": "Timezone Offset",       "data_type": "categorical",  "description": "Numeric offset from UTC in minutes.",                                                                         "units": "minutes", "notes": "e.g. -300 = UTC-5 (EST)"},
    {"column": "timezone_label",            "display_name": "Timezone Label",        "data_type": "categorical",  "description": "IANA timezone name.",                                                                                         "units": null,      "notes": "e.g. America/New_York"},
    {"column": "sensor_id",                 "display_name": "Sensor ID",             "data_type": "identifier",   "description": "Unique identifier for the sensor device.",                                                                    "units": null,      "notes": null},
    {"column": "sensor_name",               "display_name": "Sensor Name",           "data_type": "categorical",  "description": "User-defined name for the sensor.",                                                                          "units": null,      "notes": "Multiple sensors may appear in one file."},
    {"column": "mac_address",               "display_name": "MAC Address",           "data_type": "identifier",   "description": "Hardware MAC address of the edge device.",                                                                    "units": null,      "notes": null},
    {"column": "target_id",                 "display_name": "Target ID",             "data_type": "identifier",   "description": "UUID for this visit. Not persistent across separate appearances — new target_id assigned each time.",         "units": null,      "notes": "Each row is one visit. target_id is unique per row in the sessions report."},
    {"column": "dwell_tracking_area_sec",   "display_name": "Dwell Time (sec)",      "data_type": "measurement",  "description": "Seconds the target spent in the sensor full field of view (Tracking Area).",                                  "units": "seconds", "notes": "Primary engagement signal. Apply ghost filter before computing engagement rates."},
    {"column": "zone_dwell_times_json",     "display_name": "Zone Dwell Times",      "data_type": "measurement",  "description": "JSON string of zone names and dwell time per zone.",                                                          "units": "seconds", "notes": "Parse as JSON to access per-zone metrics. Format: {\"zone 1\",\"3.2\";\"zone 2\",\"0.0\"}."},
    {"column": "proximity_m",              "display_name": "Closest Proximity (m)", "data_type": "measurement",  "description": "Closest distance in meters the target reached toward the sensor during the visit.",                          "units": "meters",  "notes": "Lower value = target came closer. Useful for engagement intensity scoring."}
  ]'::jsonb,
  'DR6000 radar sensor sessions report. One row per person-visit. Use for traffic volume, dwell time, engagement rates, zone analysis, and proximity metrics. Apply ghost filter (dwell threshold) before computing engagement rates.',
  'approved',
  null
WHERE NOT EXISTS (
  SELECT 1 FROM datasets
  WHERE org_id = v_org_id
    AND column_signature = 'processed_at,account_id,device_id,log_creation_time,timezone_offset,timezone_label,sensor_id,sensor_name,mac_address,target_id,dwell_tracking_area_sec,zone_dwell_times_json,proximity_m'
);


-- =============================================================================
-- 2. SEED BELIEFS
-- =============================================================================

INSERT INTO knowledge_beliefs (org_id, content, type, confidence, tags, approval_status)
SELECT v_org_id, content, type::text, confidence, tags, 'approved'
FROM (VALUES
  (
    'Ghost paths in retail radar deployments have dwell times shorter than genuine human paths. A dwell threshold of 1–5 seconds is a reasonable starting point for the ghost filter. The exact threshold is deployment-specific and should be refined with session data.',
    'pending',
    0.60,
    ARRAY['ghost-detection', 'path-classification', 'dwell-time']
  ),
  (
    'Ghost paths caused by multipath reflection or static clutter have near-zero positional variance — the target does not move. Genuine human paths show non-trivial movement even when stationary. A positional standard deviation threshold of 0.10–0.20m in both x and y is a reasonable ghost indicator.',
    'pending',
    0.65,
    ARRAY['ghost-detection', 'path-classification', 'positional-variance']
  ),
  (
    'Short paths at the edge of the detection zone (high y values, near maximum sensor range) are disproportionately likely to be fringe artifacts rather than genuine paths. Sensor detection reliability decreases at range extremes.',
    'pending',
    0.55,
    ARRAY['ghost-detection', 'sensor-behavior', 'fringe']
  ),
  (
    'The correct unit of analysis for engagement metrics is the path (grouped by target_id), not the individual position reading (row). Computing metrics on raw rows produces meaningless results. All analysis must begin with path aggregation.',
    'belief',
    0.95,
    ARRAY['data-model', 'path-aggregation', 'methodology']
  ),
  (
    'log_creation_time is the correct timestamp field for temporal analysis. processed_at reflects pipeline processing delay and should not be used for time-window filtering or dwell calculation.',
    'belief',
    0.95,
    ARRAY['data-model', 'timestamps', 'methodology']
  )
) AS v(content, type, confidence, tags)
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_beliefs kb
  WHERE kb.org_id = v_org_id
    AND kb.content = v.content
);


-- =============================================================================
-- 3. CODE TEMPLATES
-- =============================================================================

INSERT INTO code_templates (
  org_id, vendor, name, description, code, tags, parameters, version,
  approval_status, approved_at, source_session_id
)
SELECT
  v_org_id,
  'data-realities-radar',
  'dr6000-ghost-filter-v1',
  'Classify DR6000 paths report paths as ghost or real using dwell time and positional variance thresholds. Returns a table with ghost_reason (real / low_dwell / stationary / low_dwell+stationary) and summary stats.',
  $template_code$import pandas as pd
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
$template_code$,
  ARRAY['ghost-detection', 'data-realities-radar', 'path-classification', 'paths-report'],
  '[
    {"name": "CSV_URL",                   "description": "Public URL for the DR6000 paths report CSV (from fetchSensorData or getSessionContext csvUrl)",           "example": "https://...supabase.co/storage/v1/object/public/csv-uploads/sessions/abc/dr6000_paths_2026-04-25.csv"},
    {"name": "DWELL_THRESHOLD_SECONDS",   "description": "Paths with dwell below this are ghost (low_dwell). Seed default: 1.0 — refine per deployment.",           "example": "1.0"},
    {"name": "POS_STD_THRESHOLD_M",       "description": "Paths where BOTH std_x and std_y are below this are ghost (stationary). Seed default: 0.2.",              "example": "0.2"}
  ]'::jsonb,
  'v1',
  'approved',
  NOW(),
  null
WHERE NOT EXISTS (
  SELECT 1 FROM code_templates
  WHERE org_id = v_org_id
    AND name = 'dr6000-ghost-filter-v1'
);


RAISE NOTICE 'DR6000 seed complete for org %: datasets, beliefs, and ghost-filter template inserted.', v_org_id;

END $$;
