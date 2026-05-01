# Domain Knowledge: Radar Sensors

## What Radar Sensors Are

The radar sensors in this system are short-range FMCW (Frequency-Modulated Continuous Wave) radar devices mounted overhead in retail environments. They detect and track moving objects within their field of view, reporting each tracked entity as a `target_id` with position readings (x, y in meters) at approximately 1-second intervals.

Unlike cameras, radar sensors:
- Do not capture images — no privacy concerns
- Work in darkness and are not affected by lighting conditions
- Track reflective surfaces — bodies, clothing, carts, and sometimes shelving or metal fixtures
- Have a detection range of approximately 3–8 meters depending on mounting height and model
- Produce position readings relative to the sensor's own coordinate origin (not a global coordinate system)

---

## Coordinate System

Each sensor defines its own local coordinate system with the sensor as the origin (0, 0):
- **x-axis**: horizontal position in meters (negative = left of sensor, positive = right)
- **y-axis**: depth from sensor in meters (0 = directly below; positive = away from sensor)
- **z-axis**: not reported in the CSV; implicitly the mounting height above floor

The physical meaning of the axes (which direction is "toward the entrance," which is "toward the product display") is deployment-specific and must be confirmed in the data dictionary for each session.

**Common pattern**: In a retail aisle deployment, y=0 is near the sensor mounting point (ceiling), y increases toward the far end of the aisle. x=0 is the centerline; negative x and positive x are the two sides of the aisle.

---

## Data Format

| Field | Description |
|-------|-------------|
| `log_creation_time` | Timestamp of the position reading. Use this for temporal analysis. |
| `processed_at` | When the reading was processed by the data pipeline — slightly later than `log_creation_time`. Do not use for temporal analysis. |
| `target_id` | UUID assigned to a tracked entity for the duration of its presence in the detection zone. Not persistent across separate appearances. |
| `sensor_id` | Organizational identifier for the sensor (e.g., `org_abc123`) |
| `sensor_name` | Human-readable sensor name (e.g., `radar-001`) |
| `mac_address` | Hardware MAC address of the device |
| `x_m` | X-position in meters |
| `y_m` | Y-position in meters |
| `account_id` | Client/organization identifier |
| `device_id` | Device record ID |

---

## Detection Physics and Noise Characteristics

**Ghost paths** arise from radar physics, not human behavior:
- **Multipath reflections**: The radar signal bounces off a nearby shelf or wall and creates a phantom detection near the real target
- **Static clutter**: Stationary objects (shelving, signage) can generate spurious detections if they have reflective surfaces — typically appear as very short paths with near-zero movement
- **Entry/exit artifacts**: As a person enters or leaves the detection zone, partial readings at the fringe can create very short paths with few data points
- **Sensor startup noise**: The first 30–60 seconds after sensor power-on may produce spurious detections as the radar calibrates

**Known ghost signatures** (working hypotheses — see `beliefs/approved-takeaways.md` for confirmed thresholds):
- Very short dwell time (< 3–5 seconds)
- Very small positional variance (target never actually moves; std of x and y positions near zero)
- Position coordinates near the edge of the detection zone (fringe detections)
- Path appears isolated in time (no nearby paths at the same moment — may indicate reflection rather than person)
- Unusually regular sampling intervals (genuine human movement has irregular step patterns; reflections may be perfectly periodic)

---

## Multi-Sensor Deployments

Multiple sensors may appear in a single CSV file (different `sensor_name` / `sensor_id` values). Important:
- Each sensor has its own coordinate system — x=1.5m on sensor A is not the same physical location as x=1.5m on sensor B
- Sensor fields overlap in retail deployments; the same person may appear in both sensors simultaneously with different coordinates
- Cross-sensor path matching (linking the same physical person across sensors) requires spatial and temporal alignment — it is a hard problem not addressed in the base templates

When multiple sensors are present, analyze each separately unless the session objective specifically requires cross-sensor alignment.

---

## Sampling Rate and Gaps

The sensor reports approximately 1 reading per second per target. However:
- Readings are not guaranteed to be exactly 1 second apart
- Gaps can occur if the target briefly exits the detection zone and re-enters (creates a new `target_id`)
- High-density periods (many simultaneous targets) may see reduced sampling rate per target
- The `difftime` between consecutive readings for a target should be checked; gaps > 5 seconds within a path suggest possible detection interruptions

---

## What the Sensor Does NOT Measure

- Identity (who the person is)
- Intent (what they're doing)
- Direction of gaze
- Whether a hand reached toward a product
- Cart vs. person (both are tracked as targets; cannot distinguish without additional context)
