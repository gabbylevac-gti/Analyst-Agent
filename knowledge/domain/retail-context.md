# Domain Knowledge: Retail Context

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
- y increases along the aisle direction
- x spans across the aisle width
- People who linger near products show high dwell at specific (x, y) centroids

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

At the start of any new deployment's data, confirm with the user:
1. Where is y=0? (directly below sensor, or at one end of the zone?)
2. Which direction does y increase? (toward entrance, or away?)
3. What is the physical width represented by the x range in the data?
4. Are negative x values meaningful, or are they fringe artifacts?
5. Is there a known reflective surface at any specific (x, y) that would explain ghost clustering?

Store this in the data dictionary for the session and write it to the dataset record in Supabase.
