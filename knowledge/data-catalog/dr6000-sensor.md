# Data Catalog: DR6000 Radar Sensor — Paths Report

**Integration:** Data Realities DR6000 FMCW radar sensor  
**Report covered:** `paths` — one row per position reading per target, ~1 Hz  
**Report deferred:** `sessions` — aggregated visit-level data (separate Catalog entry to be added)  
**Tool:** `fetchSensorData` with `reportType: "paths"`  
**API base:** `https://app.datarealities.com/api/sensor-logs/paths`

---

## When to Use Paths Data

Use the `paths` report when the question involves:
- Spatial analysis — where in the zone are people stopping?
- Trajectory visualization — how do people move through the zone?
- Path classification — ghost / passer-by / engaged labeling
- Custom dwell calculation with per-deployment filtering logic
- Ghost detection and sensor health diagnostics

The paths report is the default for all analysis sessions. It contains the raw signal; every engagement metric is derived from it.

---

## Schema — Paths Report

### Primary Fields

| Field | Type | Unit | Business Definition | Valid Range | Null Behavior |
|-------|------|------|---------------------|-------------|---------------|
| `log_creation_time` | datetime | UTC | **Primary timestamp.** When this position reading was recorded by the sensor. Use this for all temporal operations (dwell, time-of-day filters, hourly aggregation). | Store hours typically 06:00–22:00 local time | Never null — exclude row if null |
| `processed_at` | datetime | UTC | When the reading was processed by the data pipeline. Systematically later than `log_creation_time` by pipeline lag. **Never use for temporal analysis.** | `log_creation_time` + 0–30s | Never null |
| `target_id` | string (UUID) | — | Unique ID for a tracked entity during one continuous presence in the detection zone. **Not persistent across visits** — a person who leaves and re-enters gets a new `target_id`. This is the unit of analysis for all engagement metrics. | Any UUID | Never null |
| `x_m` | float | meters | Horizontal position relative to sensor origin. **x=0 is directly in front of the sensor (center). Negative = left of sensor; positive = right.** Both are normal and expected values. Physical meaning is deployment-specific — confirm in Data Dictionary. | Deployment-specific; negative x is always valid | Sensor guarantees a coordinate; null is unexpected. If null occurs, exclude row. |
| `y_m` | float | meters | Depth from sensor origin. 0 = directly below sensor; increases away from sensor. Physical meaning is deployment-specific — confirm in Data Dictionary. | Typically 0.0 to 6.0 m | Sensor guarantees a coordinate; null is unexpected. If null occurs, exclude row. |
| `sensor_id` | string | — | Organizational sensor identifier. Use for filtering in multi-sensor files. | Any string | Flag if null |
| `sensor_name` | string | — | Human-readable sensor name (e.g., `radar-001`). Preferred over `sensor_id` for filtering — more stable. | Any string | Flag if null |
| `mac_address` | string | — | Hardware MAC address. Present for audit only — not needed for analysis. | 12-char hex | OK if null |
| `account_id` | string | — | Client/org identifier. Should be consistent within a single org's dataset. | Any string | Flag if null |
| `device_id` | string | — | Device record ID in the DR6000 system. Audit use only. | Any string | OK if null |

### Coordinate System (Deployment-Specific)

The x/y axes are local to each sensor — `x=1.5m` on sensor A is not the same physical location as `x=1.5m` on sensor B. At the start of every new deployment, confirm with the user:

1. Where is the sensor positioned relative to the targeted products and digital signage?
2. Describe the likely shopper paths and how the sensor is positioned (e.g., in an aisle, on an endcap, on a major traffic thru-way).
3. Is there a known reflective surface at any (x, y) that would explain ghost clustering?

Store answers in the org's Data Dictionary under `coordinate_system_notes`.

---

## Data Pipeline — Two-Stage Architecture

All DR6000 analysis follows a two-stage medallion pipeline, consistent with the platform data architecture:

```
RAW LAYER
  CSV upload → Supabase Storage (raw_data_uploads)
  API pull   → raw_events (JSONB, append-only)
      │
      │  transformation template  (dr6000-transform-v1.py)
      │  • applies QR-1 (off-hours) and QR-2 (min point count)
      │  • aggregates raw rows → one path record per target_id
      │  • writes to dataset_records (the "Agent Ready" clean layer)
      ▼
CLEAN LAYER  →  dataset_records
      │
      │  analysis templates  (path-classification-v1.py, engagement-metrics-v1.py, etc.)
      │  • read from dataset_records (never from raw CSV directly)
      │  • apply QR-5 ghost filter using deployment-specific thresholds from data dictionary
      │  • produce typed output envelopes → analysis_artifacts
      ▼
ENRICHED LAYER  →  analysis_artifacts
```

**POC note:** The transformation trigger (onboarding historical load + nightly campaign sync) is not yet implemented. In the current POC, data flows through the same logical pipeline — raw ingestion, transformation, analysis — run manually per session. When the trigger infrastructure ships, these templates run automatically in the same sequence.

**Analysis templates always read from `dataset_records`.** Never run an analysis template directly against a raw CSV — the clean layer is the contract.

---

## Quality Rules

QR-1 and QR-2 are applied by the transformation template (Raw → Clean). QR-3 (ghost filter) is applied by analysis templates (Clean → Enriched) using deployment-specific thresholds confirmed in the org's Data Dictionary.

Each rule is linked to a code template — changing a rule requires reviewing its linked template. The org's Data Dictionary overrides catalog defaults.

### QR-1: Off-Hours Exclusion

| | |
|---|---|
| **Rule** | Exclude rows where `hour_of_day < STORE_OPEN_HOUR` or `hour_of_day >= STORE_CLOSE_HOUR` |
| **Default** | Open = 7, Close = 21 (7:00 AM – 9:00 PM) |
| **Adjust** | Per deployment — use actual posted store hours |
| **Why** | Pre-open and post-close detections are overwhelmingly sensor artifacts or staff restocking. They inflate ghost counts and suppress engagement rates. |
| **Linked template** | `quality-check-sensor-v1.py` → params `STORE_OPEN_HOUR` / `STORE_CLOSE_HOUR` |

### QR-2: Minimum Point Count

| | |
|---|---|
| **Rule** | Exclude paths where `point_count < MIN_POINTS` |
| **Default** | MIN_POINTS = 2 |
| **Adjust** | Rarely — increase to 3 if single-point ghost noise is high |
| **Why** | A single-reading path has no dwell information and cannot be classified reliably. |
| **Linked template** | `dr6000-transform-v1.py` → param `MIN_POINTS` |

### QR-3: Ghost Path Exclusion

| | |
|---|---|
| **Rule** | Exclude paths where `dwell_seconds < GHOST_DWELL_S` AND `std_x < GHOST_STD_M` AND `std_y < GHOST_STD_M` |
| **Thresholds** | **Deployment-specific — must be confirmed per org in the Data Dictionary.** Catalog starting points: GHOST_DWELL_S ≈ 3–5 s, GHOST_STD_M ≈ 0.10–0.20 m. Do not use catalog starting points as final values without validation. |
| **How to confirm** | Run `quality-check-sensor-v1.py` to observe the ghost rate at candidate thresholds. Then run `path-trajectory-plot.py` on 10–20 borderline paths (dwell 2–5 s) to visually confirm they are artifacts, not genuine short engagements. Record confirmed values in the Data Dictionary before running any classification template. |
| **Confidence** | Pending empirical validation — 0.60 / 0.65 (see `beliefs/approved-takeaways.md`). Confidence increases to ≥0.80 once trajectory inspection is completed for a deployment. |
| **Why** | Multipath reflections and static clutter generate paths with near-zero dwell and near-zero movement. The correct threshold varies by physical environment — reflective surfaces, sensor height, installation angle all affect the ghost signature. |
| **Applied by** | Analysis templates (`path-classification-v1.py`, `engagement-metrics-v1.py`, `dr6000-ghost-filter-v1.py`) — not the transformation template. Applied at analysis time using org's confirmed thresholds from Data Dictionary. |

---

## Derived Columns (Added by Templates)

These columns do not exist in the raw API response. `path-aggregation.py` must run first before any classification or engagement analysis.

| Column | Source Template | How Computed |
|--------|----------------|-------------|
| `dwell_seconds` | `path-aggregation.py` | `(max − min of log_creation_time).total_seconds()` per `target_id` |
| `point_count` | `path-aggregation.py` | Row count per `target_id` |
| `mean_x`, `std_x`, `range_x` | `path-aggregation.py` | Positional statistics on `x_m` per path |
| `mean_y`, `std_y`, `range_y` | `path-aggregation.py` | Positional statistics on `y_m` per path |
| `start_hour` | `path-aggregation.py` | Hour of `min(log_creation_time)` |
| `session_date` | `path-aggregation.py` | Date of path start |
| `classification` | `path-classification-v1.py` | `ghost` / `passer-by` / `engaged` |
| `is_fringe` | `path-classification-v1.py` | Centroid near zone edge (y > 80% of Y_MAX) |
| `hour_of_day` | `quality-check-sensor-v1.py` | `log_creation_time.dt.hour` |

---

## Standard Metrics Definitions

These definitions are authoritative across all DR6000 analysis sessions. Override in the org's Data Dictionary only if the client uses different terminology.

| Metric | Definition | Template |
|--------|-----------|---------|
| **Traffic volume** | Count of real (non-ghost) unique paths in a time window | `engagement-metrics-v1.py` |
| **Engagement rate** | `engaged_paths / (engaged_paths + passer_by_paths) × 100` — of those who entered, what % stopped | `engagement-metrics-v1.py` |
| **Ghost rate** | `ghost_paths / total_paths × 100` — sensor health indicator | `path-classification-v1.py` |
| **Median dwell** | Median `dwell_seconds` across engaged paths only | `engagement-metrics-v1.py` |
| **Stopping power** | Engagement rate by content or time window — what drove people to stop | Derived from `engagement-metrics-v1.py` |

---

## Join Keys (Multi-Source Analysis)

| Key | Type | Notes |
|-----|------|-------|
| `sensor_name` or `sensor_id` | string | Links to sensor metadata, store location, zone dimensions |
| `log_creation_time` bucketed | datetime | Time-based join with POS, CMS, weather. **Always aggregate to a coarser window** (15-min minimum) before joining — raw second-level sensor data does not align with transaction or impression timestamps |
| `account_id` | string | Links to org-level metadata |

**Temporal join note:** Define the aggregation window explicitly and document it in the Data Dictionary. The mismatch in granularity (sensor ~1 Hz vs. POS at transaction, weather at 1 hour) is the primary source of join errors. When in doubt, aggregate both sources to 15-minute windows before joining.

---

## Code Templates (Paths Report)

### Stage 1 — Transformation (Raw → Clean)

These templates read raw sensor data and produce the `dataset_records` clean layer. They apply QR-1 through QR-4.

| Template | File | Purpose | Run When |
|----------|------|---------|---------|
| Quality Check | `quality-check-sensor-v1.py` | Diagnostic: what each QR rule would filter, ghost rate at candidate thresholds, recommendations. Does not write to Postgres. | Before the first transformation run for any new deployment or after Data Dictionary changes. |
| DR6000 Transform | `dr6000-transform-v1.py` | Applies QR-1–QR-4, aggregates to path level, writes clean records to `dataset_records`. | On data ingestion (CSV upload or API fetch). Automated when pipeline triggers ship. |

### Stage 2 — Analysis (Clean → Enriched)

These templates read from `dataset_records`. They apply QR-5 (ghost filter) using deployment-specific thresholds from the org's Data Dictionary.

| Template | File | Purpose | Run When |
|----------|------|---------|---------|
| Ghost Filter | `dr6000-ghost-filter-v1.py` | Label paths as ghost / real with reason | When ghost labeling is needed without full classification |
| Path Classification | `path-classification-v1.py` | Full 3-way label: ghost / passer-by / engaged | When full classification is needed |
| Engagement Metrics | `engagement-metrics-v1.py` | Traffic volume, engagement rate, dwell distribution by day | Core business metrics; every analysis session |
| Trajectory Plot | `path-trajectory-plot.py` | X/Y spatial trajectories, one line per path | Diagnosing ghost patterns; understanding zone geometry |
| Summary Statistics | `summary-statistics.py` | Sensor and path-level descriptive stats | Session startup overview |

---

## Domain Knowledge Files

| File | Content |
|------|---------|
| `knowledge/domain/radar-sensors.md` | Sensor physics, coordinate system, data format, noise patterns |
| `knowledge/domain/path-classification.md` | Ghost / passer-by / engaged definitions, classification algorithm status |
| `knowledge/domain/retail-context.md` | Deployment context, business objectives, traffic patterns by time |

---

## Known Issues and Edge Cases

**Cart tracking** — The sensor tracks all reflective moving objects. Shopping carts may generate separate paths from the shopper pushing them, or merge with the shopper's path. No reliable way to distinguish without additional context.

**Multi-sensor overlap** — When multiple sensors cover overlapping zones, the same person appears as separate `target_id`s in each sensor. Cross-sensor deduplication is not addressed in current templates — analyze sensors separately by default.

**Staff paths** — Paths with `dwell_seconds > 300` (5 minutes) are almost certainly staff, not customers. Consider filtering by time window or flagging separately, especially during opening/closing hours when restocking occurs.

**Dense crowd degradation** — At peak traffic the sensor may lose individual tracks, creating many short paths where one long path would be expected. High ghost rate at peak hours may indicate crowding rather than sensor noise.

**Sensor startup noise** — First 30–60 seconds after power-on may produce spurious detections. If `range_start` is immediately after sensor boot, filter the first 60 seconds.

**Coordinate system flip** — If the data shows unexpectedly high activity at y=0 (directly below sensor), the y-axis may be inverted relative to expectation. Always inspect the trajectory plot before interpreting centroid positions.
