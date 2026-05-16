# Data Catalog: Clean Data Layer — In Store Activity

**Domain:** In Store Activity  
**Integration:** DR6000 FMCW radar (Datalogiq)  
**Layer:** Clean — vendor-normalized records after quality rule filtering. Not raw data.  
**Source catalog for raw API fields:** `dr6000-sensor.md`  
**Naming convention:** `Obs_[IntegrationSlug]_[Descriptor]` for observations; `[Scope]_[Domain]_[Granularity]` for aggregates.

---

## Tables in This Domain

| Table | Scope | Granularity | Description |
|---|---|---|---|
| `obs_dr6000_audience_path_observation` | Venue + Endpoint | One row per path | Cleaned, classified path — one continuous presence in the detection zone |
| `obs_dr6000_endpoint_session_observation` | Endpoint | One row per session | Endpoint-level session from DR6000 endpoint mode |
| `venue_instore_activity_15min_agg` | Venue | 15-min window | Store-level shopper behavior + campaign activity |
| `venue_instore_activity_day_agg` | Venue | Daily | Store-level daily rollup |
| `endpoint_instore_activity_15min_agg` | Endpoint | 15-min window | Device/zone-level shopper behavior + campaign activity |
| `endpoint_instore_activity_day_agg` | Endpoint | Daily | Device/zone-level daily rollup |

Quality rules applied before these tables are written:
- **QR-1:** Off-hours paths excluded (configurable store hours in `org_time_config`)
- **QR-2:** Paths with fewer than `MIN_POINTS` readings excluded (default: 2)
- **QR-3:** Three-tier engagement classification applied (passer_by / engaged / considering)

---

## obs_dr6000_audience_path_observation

One row per classified path — one continuous presence of a target in the detection zone.

### Identity

| Column | Type | Definition | Null |
|---|---|---|---|
| `id` | uuid | Primary key | Never null |
| `org_id` | uuid | Organization FK | Never null |
| `venue_id` | uuid → store_locations | Store where this path was observed | Null for legacy CSV uploads pre-M4-2 |
| `endpoint_id` | uuid → endpoints | Specific device/zone that captured this path | Null for historical CSV uploads where endpoint wasn't set |

### Provenance

| Column | Type | Definition | Null |
|---|---|---|---|
| `raw_upload_id` | uuid → raw_data_uploads | Upload batch this path came from — audit trail to raw file | Never null |
| `template_id` | uuid → code_templates | Transform template version that produced this row | Null for pre-M4-1 rows |
| `vendor_source` | text | Vendor that supplied the raw data (e.g. `'datalogiq'`) | Nullable |
| `hardware_model` | text | Sensor hardware model (e.g. `'DR6000'`) | Nullable |

### Path Identity

| Column | Type | Definition | Null |
|---|---|---|---|
| `target_id` | text | Unique ID for a tracked entity during one continuous presence. **Not persistent across visits** — a person who leaves and re-enters gets a new `target_id`. This is the unit of analysis. | Never null |
| `sensor_name` | text | Human-readable sensor name (e.g. `'radar-001'`). Preferred over sensor_id for filtering — more stable. | Flag if null |
| `session_date` | date | Calendar date of path start. Derived from `start_time`. | Never null |

### Timing

| Column | Type | Unit | Definition | Null |
|---|---|---|---|---|
| `start_time` | timestamptz | UTC | Timestamp of first position reading for this path | Never null |
| `end_time` | timestamptz | UTC | Timestamp of last position reading for this path | Never null |
| `dwell_seconds` | float | seconds | Total time in zone: `(end_time − start_time).total_seconds()`. Primary classification input. | Never null |
| `start_hour` | integer | 0–23 | Hour of `start_time`. Used for time-of-day filters and day_part computation. | Never null |
| `point_count` | integer | count | Number of raw position readings in this path. Paths below `MIN_POINTS` (QR-2) are excluded before this table. | Never null |

### Position (Sensor-Local Coordinates)

Axes are local to each sensor — `x=1.5m` on sensor A is not the same physical location as `x=1.5m` on sensor B. See `dr6000-sensor.md` for coordinate system notes.

| Column | Type | Unit | Definition | Null |
|---|---|---|---|---|
| `centroid_x` | float | meters | Mean `x_m` across all readings. Horizontal center of path. x=0 is directly in front of sensor; negative = left; positive = right. | Null if point_count = 1 |
| `centroid_y` | float | meters | Mean `y_m` across all readings. Average depth from sensor. y=0 = directly below sensor; increases away from sensor. | Null if point_count = 1 |
| `std_x` | float | meters | Standard deviation of `x_m`. Low std_x = narrow horizontal movement or stationary. | Null if point_count = 1 |
| `std_y` | float | meters | Standard deviation of `y_m`. Low std_y = stationary or shallow depth movement. | Null if point_count = 1 |
| `range_x` | float | meters | `max(x_m) − min(x_m)`. Total horizontal span of path. | Null if point_count = 1 |
| `range_y` | float | meters | `max(y_m) − min(y_m)`. Total depth span of path. | Null if point_count = 1 |
| `path_positions` | jsonb | — | Array of `{x_m, y_m}` objects representing the path trace. Format: `[{"x_m": 0.3, "y_m": 1.2}, ...]`. Used for heatmap and trajectory visualization. May be sampled. | Null for pre-migration rows |
| `closest_approach_distance` | float | meters | `MIN(SQRT(x_m² + y_m²))` across all raw position readings. Minimum Euclidean distance from the sensor origin `(0,0)`. Origin maps to the product shelf or display face. Low value = target came close to the focal point. | Null for pre-migration rows |

### Classification

| Column | Type | Definition | Values | Null |
|---|---|---|---|---|
| `engagement_tier` | text | Three-tier classification based on `dwell_seconds`. Replaces legacy `path_classification` (2-tier). | `passer_by` — dwell < ENGAGED_THRESHOLD (default 15s) · `engaged` — ENGAGED_THRESHOLD ≤ dwell < CONSIDERING_THRESHOLD (default 45s) · `considering` — dwell ≥ CONSIDERING_THRESHOLD | Never null (post-QR-3) |

Thresholds are configurable per org in `org_time_config` (stored in `data_dictionaries.field_definitions`). Never use catalog defaults as final values without validating against deployment trajectory plots. See `dr6000-sensor.md` QR-3 for validation methodology.

### Time Dimensions

Computed at write time from `org_time_config`. Source of truth: `data_dictionaries.field_definitions` for the org's integration.

| Column | Type | Definition | Values | Null |
|---|---|---|---|---|
| `day_part` | text | Time-of-day segment derived from `start_time` and configured store hours | `'morning'` · `'midday'` · `'afternoon'` · `'evening'` — boundaries configurable per org | Null if org_time_config not set |
| `week_part` | text | Week segment based on `session_date` | `'weekday'` · `'weekend'` — configurable for regional holidays | Null if org_time_config not set |
| `is_store_hours` | boolean | True if `start_time` falls within configured store hours. After QR-1, most rows are `true`. Rows outside store hours that survive QR-1 (edge-of-window paths) may be `false`. | `true` · `false` | Null if org_time_config not set |
| `season` | text | Meteorological season based on `session_date` | `'spring'` · `'summer'` · `'fall'` · `'winter'` — hemisphere configurable per org | Null if org_time_config not set |

---

## endpoint_visit_sessions

Cross-source session join key table. One row per detected endpoint visit, generated by the session authority transform (typically DR6000 radar). All other data sources (CMS proof-of-play, etc.) reference these sessions via `endpoint_session_id` in their own observation tables.

| Column | Type | Definition | Null |
|---|---|---|---|
| `id` | uuid | Primary key — used as `endpoint_session_id` in all linked obs tables | Never null |
| `org_id` | uuid | Organization FK | Never null |
| `endpoint_id` | uuid → endpoints | Device/screen this session occurred at | Never null |
| `authority_source` | text | Integration that identified this session (e.g. `'dr6000-radar'`) | Never null |
| `start_time` | timestamptz | Session start — used for timestamp-range joins by other transforms | Never null |
| `end_time` | timestamptz | Session end | Never null |
| `created_at` | timestamptz | | |

**Session authority config:** which data source is the authority for each endpoint is configured in Pipeline Settings (`interpretation_configs` keys `session_authority_source` + `session_authority_template_id`).

**Future join pattern (Enriched Layer):**
```sql
FROM endpoint_visit_sessions s
JOIN obs_dr6000_endpoint_session_observation obs ON obs.endpoint_session_id = s.id
LEFT JOIN obs_cms_proofofplay pop ON pop.endpoint_session_id = s.id
WHERE s.endpoint_id = $1 AND s.start_time >= $2
```

---

## obs_dr6000_endpoint_session_observation

One row per endpoint-level session — a continuous visit to a device or display zone captured in DR6000 endpoint mode. Content data is **not** stored here — it belongs in `Obs_[CMS]_ProofOfPlay` (future), joined at Enriched Layer via `endpoint_session_id`.

| Column | Type | Definition | Null |
|---|---|---|---|
| `id` | uuid | Primary key | Never null |
| `org_id` | uuid | Organization FK | Never null |
| `endpoint_id` | uuid → endpoints | Device/screen that captured this session | Never null |
| `endpoint_session_id` | uuid → endpoint_visit_sessions | Cross-source join key. Set when DR6000 is the session authority. | Nullable for pre-architecture rows |
| `raw_upload_id` | uuid → raw_data_uploads | Source upload batch | Never null |
| `template_id` | uuid → code_templates | Transform version | Nullable |
| `session_date` | date | Calendar date of session | Never null |
| `start_time` | timestamptz | Session start | Never null |
| `end_time` | timestamptz | Session end | Never null |
| `dwell_seconds` | float | Session duration: `(end_time − start_time).total_seconds()` | Never null |
| `closest_approach_distance` | float | `MIN(SQRT(x_m² + y_m²))` during session — minimum distance from sensor origin in meters | Null for pre-migration rows |
| `engagement_tier` | text | `passer_by` / `engaged` / `considering` — same thresholds as path observation | Never null |
| `interaction_count` | integer | Registered device interactions (button presses, touch events) in this session. 0 = passive presence. | Default 0 |
| `day_part` | text | `'morning'` / `'midday'` / `'afternoon'` / `'evening'` | Null if org_time_config not set |
| `week_part` | text | `'weekday'` / `'weekend'` | Null if org_time_config not set |
| `is_store_hours` | boolean | True if within configured store hours | Null if org_time_config not set |

---

## venue_instore_activity_15min_agg

One row per store per 15-minute window. Contains both shopper behavior metrics and campaign activity for the window. Covers all engagement tiers — passer_by + engaged + considering.

### Identity + Window

| Column | Type | Definition | Null |
|---|---|---|---|
| `id` | uuid | Primary key | Never null |
| `org_id` | uuid | Organization FK | Never null |
| `venue_id` | uuid → store_locations | Store this aggregate covers | Never null |
| `raw_upload_id` | uuid | Source upload batch | Never null |
| `period_start` | timestamptz | Window open (inclusive) | Never null |
| `period_end` | timestamptz | Window close (exclusive). `period_end = period_start + 15 minutes` | Never null |

### Shopper Behavior — Counts

| Column | Type | Definition |
|---|---|---|
| `passer_by_count` | integer | Paths classified as `passer_by` in this window |
| `engaged_count` | integer | Paths classified as `engaged` in this window |
| `considering_count` | integer | Paths classified as `considering` in this window |
| `total_paths` | integer | `passer_by_count + engaged_count + considering_count` |

### Shopper Behavior — Dwell

| Column | Type | Definition |
|---|---|---|
| `avg_dwell_engaged_seconds` | float | Mean `dwell_seconds` for `engaged` + `considering` paths only |
| `median_dwell_engaged_seconds` | float | Median `dwell_seconds` for `engaged` + `considering` paths only |
| `engaged_dwell_seconds_array` | float[] | All dwell values for `engaged` + `considering` paths in this window. Used for server-side percentile queries (`percentile_cont`) without scanning observation rows. |
| `dwell_seconds_array` | float[] | All dwell values for **all** paths (passer_by + engaged + considering). Used for distribution analysis across the full traffic volume. |

### Shopper Behavior — Occupancy Duration

These measure how long each tier occupied the detection zone — distinct from count (how many people) and average dwell (per-person time).

| Column | Type | Unit | Definition |
|---|---|---|---|
| `passer_by_total_dwell_seconds` | float | seconds | Sum of `dwell_seconds` for all `passer_by` paths in this window |
| `engaged_total_dwell_seconds` | float | seconds | Sum of `dwell_seconds` for all `engaged` paths in this window |
| `considering_total_dwell_seconds` | float | seconds | Sum of `dwell_seconds` for all `considering` paths in this window |

### Campaign Activity

| Column | Type | Definition | Null |
|---|---|---|---|
| `active_campaign_ids` | uuid[] | IDs of campaigns active during this window (from campaign schedule) | Null if no campaign tracking |
| `impression_count` | integer | Content impressions delivered to the zone in this window | Null if no CMS integration |
| `engagement_rate` | float | `(engaged_count + considering_count) / total_paths`. Range 0–1. Null if total_paths = 0. | Null if no traffic |

### Time Dimensions

| Column | Type | Definition |
|---|---|---|
| `day_part` | text | `'morning'` / `'midday'` / `'afternoon'` / `'evening'` — from `period_start` |
| `hour_of_day` | integer | 0–23, from `period_start` |
| `week_part` | text | `'weekday'` / `'weekend'` |
| `is_store_hours` | boolean | True if window falls within configured store hours |

---

## venue_instore_activity_day_agg

One row per store per calendar day. Same column groups as the 15-min table; day-level adds peak hour fields.

### Identity + Day

| Column | Type | Definition |
|---|---|---|
| `id` | uuid | Primary key |
| `org_id` | uuid | Organization FK |
| `venue_id` | uuid → store_locations | Store |
| `raw_upload_id` | uuid | Source upload batch |
| `date` | date | Calendar date |

### Shopper Behavior — Counts and Dwell

Same columns as 15-min table (`passer_by_count`, `engaged_count`, `considering_count`, `total_paths`, `avg_dwell_engaged_seconds`, `engaged_dwell_seconds_array`, `dwell_seconds_array`, occupancy duration columns).

Additional day-level columns:

| Column | Type | Definition |
|---|---|---|
| `peak_hour` | integer | Hour (0–23) with the highest `total_paths` count for the day |
| `peak_hour_count` | integer | `total_paths` in the `peak_hour` |

### Campaign Activity

Same as 15-min table: `active_campaign_ids`, `impression_count`, `engagement_rate`.

### Time Dimensions

| Column | Type | Definition |
|---|---|---|
| `week_part` | text | `'weekday'` / `'weekend'` |
| `season` | text | `'spring'` / `'summer'` / `'fall'` / `'winter'` |
| `is_store_hours` | boolean | True if the day had any store-hours data |

---

## endpoint_instore_activity_15min_agg

One row per endpoint (device/screen) per 15-minute window. Same structure as `venue_instore_activity_15min_agg` but scoped to a single device/zone rather than the whole store. Adds `content_ids` — the content displayed on this endpoint during the window.

| Additional Column | Type | Definition |
|---|---|---|
| `endpoint_id` | uuid → endpoints | Device/screen this aggregate covers (replaces `venue_id`) |
| `content_ids` | uuid[] | `content_library.id` values of content displayed on this endpoint in this window |

All other column groups (behavior counts, dwell arrays, occupancy, campaign activity, time dimensions) mirror the venue 15-min table.

---

## endpoint_instore_activity_day_agg

One row per endpoint per calendar day. Mirrors `venue_instore_activity_day_agg` with `endpoint_id` (not `venue_id`) and the addition of `content_ids`.

---

## Key Metrics Defined Across All Aggregate Tables

| Metric | Column | Formula | Notes |
|---|---|---|---|
| **Traffic volume** | `total_paths` | `passer_by + engaged + considering` | All real paths in window |
| **Engagement rate** | `engagement_rate` | `(engaged + considering) / total_paths` | % who stopped; 0 if no traffic |
| **Considering rate** | derived | `considering_count / total_paths` | % with high-intent dwell |
| **Zone occupancy** | `*_total_dwell_seconds` | Sum of dwell per tier | Total seconds the zone was occupied per engagement tier |
| **Peak hour** | `peak_hour` | Hour with max `total_paths` | Day-level tables only |

---

## org_time_config Reference

Time dimension columns (`day_part`, `week_part`, `season`, `is_store_hours`) are all computed at transform-write time using configuration stored in `data_dictionaries.field_definitions` under the key `org_time_config`. Required keys:

| Key | Type | Example |
|---|---|---|
| `store_open_hour` | integer (0–23) | `7` |
| `store_close_hour` | integer (0–23) | `21` |
| `day_part_boundaries` | object | `{ morning: [7,11], midday: [11,14], afternoon: [14,18], evening: [18,21] }` |
| `weekend_days` | integer[] | `[5, 6]` (Saturday=5, Sunday=6) |
| `hemisphere` | string | `'northern'` |
| `engaged_threshold_seconds` | integer | `15` |
| `considering_threshold_seconds` | integer | `45` |

If `org_time_config` is not present in the data dictionary at transform time, time dimension columns are written as NULL. Analysis templates that use these columns should check for NULL and surface a warning if config is missing.

---

## Related Files

| File | Content |
|---|---|
| `dr6000-sensor.md` | Raw API field definitions, quality rule specs, code templates |
| `domain/radar-sensors.md` | Sensor physics, coordinate system, noise patterns |
| `domain/path-classification.md` | Ghost / passer-by / engaged classification algorithm |
| `../app-v2/docs/architecture/Data-Architecture.md` | Full platform data architecture and schema block |
