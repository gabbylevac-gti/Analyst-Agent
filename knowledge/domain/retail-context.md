# Domain Knowledge: Retail Context

## Knowledge Status

| | |
|---|---|
| **Overall Confidence** | 0.70 |
| **Last Reviewed** | 2026-05-08 |
| **Pending Validation** | Dwell expectations by shopper category, weekly traffic lift % — general retail benchmarks not yet validated against actual DR6000 deployment data |

See the Evidence Log at the end of this file for per-claim detail.

---

## Deployment Context

The radar sensors in this system are deployed in retail environments — primarily grocery or specialty retail stores. Sensors are mounted in the ceiling above specific zones (product displays, endcaps, promotional areas) to measure foot traffic and engagement with those zones.

---

## Business Objectives

The primary business questions this system is designed to answer:

1. **Engagement rate**: What percentage of people who enter the detection zone stop and engage vs. pass through?
2. **Dwell time distribution**: How long do engaged visitors spend in the zone?
3. **Traffic volume**: How many unique paths (people) enter the zone per hour / day / week?
4. **Ghost rate**: What percentage of detected paths are sensor artifacts, and can we reliably filter them?
5. **Algorithm development**: Can we build a reliable classifier that auto-labels paths as engaged, passer-by, or ghost?

Commercial impact: engagement metrics from these sensors inform decisions about product placement, promotional display design, staffing, and campaign effectiveness.

---

## Typical Store Layout Context

Without a floor plan, the coordinate system must be inferred from data patterns. Common configurations:

**Endcap deployment** (sensor above end of aisle):
- y increases toward the main aisle (high-traffic corridor)
- y ≈ 0 is directly below the sensor (near the back of the endcap)
- x spans the width of the endcap (typically 1.2–2.4m)
- Passer-bys appear as paths moving through at high y values; engaged paths cluster at lower y values near the product

**In-aisle deployment** (sensor above a product section):
- y increases toward the opposite shelving; tracking area typically bounded to stop before reaching the far side
- y ≈ 0 is directly in front of the sensor (near the product shelf)
- x spans up and down the aisle direction
- People who linger near products show high dwell at low y values, clustered near the sensor-facing shelf

When the deployment type is not known, inspect the path trajectory plot for structural patterns before proceeding with classification.

---

## Traffic Patterns to Expect

**High-ghost periods**: Early morning before store opening, late night. Low human traffic means any detections are more likely artifacts.

**Peak traffic**: Mid-morning (10–12), early afternoon (1–3pm), post-work (5–7pm). Expect high path density, possible sensor crowding.

**Weekly patterns**: Weekends typically 20–40% higher traffic than weekdays in grocery. Promotions spike traffic on launch day.

**Dwell expectations by category**:
- Typical grocery shopper at an endcap: 3–20 seconds
- Engaged shopper who picks up product: 15–45 seconds
- Browser reading label: 30–90 seconds
- Staff restocking: 60–300+ seconds (these should be filtered or flagged separately)

---

## Known Analysis Patterns

**Session startup pattern**: First analysis in a session is almost always path aggregation (raw rows → path-level summary). This is always the right starting point.

**Ghost filter before metrics**: Never compute engagement rates on raw path data. Always apply ghost filter first. Inflated path counts due to ghosts make engagement rate look artificially low.

**Staff paths**: Long-dwell, high-movement paths during store opening/closing or known restocking windows are likely staff. Consider filtering by time window (store hours only) or flagging separately.

**Sensor comparison**: When multiple sensors are present, compare ghost rates across sensors as a sensor health check — a sensor with a significantly higher ghost rate than others may have a calibration or placement issue.

---

## Coordinate System Confirmation Checklist

When drafting a new data dictionary for a dataset with position columns, ask the user these two questions in plain language. Do not use x, y, coordinate, or axis terminology with the user.

1. "Where is this sensor installed? For example: 'above the Dyson display at the end of aisle 5' or 'ceiling above the entrance'"
2. "Is there anything large and metal or very reflective nearby — like metal shelving, a freezer door, or a mirror?"

Ask these once, as a short numbered list. Do not repeat them in a later turn. Do not re-ask if the dictionary already has deployment context.

**Internal mapping notes (not shown to user):**
- x=0 is always the sensor centerline; negative x = left of sensor, positive x = right — both are valid, expected values
- y=0 is directly below the sensor; positive y = away from sensor (deeper into zone)
- User's answer to question 1 establishes the physical anchor for coordinate interpretation

Store confirmed answers in the org's Data Dictionary under `coordinate_system_notes`.

---

## Evidence Log

| Claim | Confidence | Source | Date Added | Status |
|-------|-----------|--------|------------|--------|
| Ghost filter before metrics is required (never compute engagement on raw paths) | 0.95 | Logical requirement — ghost paths inflate counts and suppress engagement rate | 2026-05-08 | Confirmed |
| x=0 is directly in front of sensor; negative x is left (valid, expected) | 0.95 | SME confirmation 2026-05-08 | 2026-05-08 | Confirmed |
| Peak traffic: mid-morning 10–12, early afternoon 1–3pm, post-work 5–7pm | 0.75 | General retail industry knowledge | 2026-05-08 | Hypothesis — validate against actual hourly data per deployment |
| Weekends 20–40% higher traffic than weekdays | 0.60 | General grocery retail benchmark | 2026-05-08 | Pending: validate against actual deployment data |
| Dwell: typical grocery endcap shopper 3–20s; engaged 15–45s; browser 30–90s | 0.65 | Retail sensor literature; not validated on DR6000 data | 2026-05-08 | Pending: validate against dwell distribution from actual deployment |
| Staff paths: dwell > 300s during open/close hours likely staff | 0.80 | Operational knowledge — restocking behavior | 2026-05-08 | Rule of thumb; verify timing per deployment |
| Sensor ghost rate comparison across sensors flags calibration issues | 0.80 | Sensor health diagnostic logic | 2026-05-08 | Confirmed as diagnostic heuristic |
