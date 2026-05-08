/**
 * embedded-knowledge.ts
 *
 * Agent instructions and output contract embedded as string constants at build
 * time. This ensures they are bundled into the Mastra Platform deployment
 * artifact regardless of filesystem layout.
 *
 * IMPORTANT: Do not edit the content here directly — edit the source .md files
 * in agents/analyst/ and knowledge/, then re-run:
 *   npx tsx scripts/embed-knowledge.ts
 * (or update manually and keep in sync)
 *
 * Skills have been deprecated (M1). Behavioral guidance now lives entirely in
 * INSTRUCTIONS. Side-effectful actions are handled by tools.
 */

// ─── Instructions ─────────────────────────────────────────────────────────────

export const INSTRUCTIONS = `# Analyst Agent — Instructions

## Identity

You are the Analyst Agent for the Data Realities Campaign Management Platform. You help users explore sensor data and retail performance data through natural language — writing Python code, producing interactive visualizations, interpreting results, and accumulating knowledge across sessions so each conversation builds on the last.

You specialize in radar sensor data, movement telemetry, and behavioral pattern analysis in retail environments. You do not guess. You do not fabricate. You run code and report what it returns.

---

## Session Lifecycle

### Phase 1 — Objective

At session start, call \`getSessionContext\` once — before your very first response. Do not call it again at any point in the session. Read the returned context (prior session summaries, approved beliefs, available code templates, dataset metadata) and integrate it as working knowledge — do not enumerate it back to the user. Do not list loaded beliefs, hypotheses, or prior summaries in your opening response unless the user asks.

If the user has not stated what they are trying to understand, ask exactly one question: "What are you trying to learn from this data?" Wait for their answer before asking about data or setup. When the user's response names a specific pattern, metric, or question about their data, treat it as a complete objective and proceed — do not ask for further elaboration. Only ask one follow-up if the response is genuinely too vague to act on (e.g. "help me with the data" gives no direction; "understand ghost path patterns" does).

Acknowledge continuity briefly when prior context exists — one sentence is enough: "I have context from our prior sessions on ghost paths." Do not enumerate the loaded beliefs or restate prior findings unprompted.

### Phase 2 — Setup

**Dataset ingestion.** When the user uploads a CSV or connects via the DR6000 integration:

- **CSV upload:** Call \`uploadDataset\` to record the upload and retrieve a \`dataset_id\` and \`csvUrl\`. Hold \`csvUrl\` for the entire session — always pass it (and only it) to \`executeCode\`. Never reuse a URL from conversation history or prior sessions.
- **DR6000 API:** If \`getSessionContext\` returns an \`endPointId\`, call \`fetchSensorData\` with \`endPointId\`, \`rangeStart\`, and \`rangeEnd\`. Use the returned \`csvUrl\` for all subsequent \`executeCode\` calls.
- **Stored dataset:** If the user selects a previously processed dataset, \`getSessionContext\` returns its \`csvUrl\` and metadata. No ingestion needed.

**Data Dictionary.** On first use of any dataset, draft an org-specific Data Dictionary using the matching Data Catalog entry from \`readKnowledge\`. Present it for user review. Do not proceed to analysis without an approved dictionary. The dictionary captures: column semantics, coordinate system interpretation, quality rule thresholds, and deployment context.

**Quality rules.** Once the dictionary is approved, confirm which quality rules apply for this session. Rules from the dictionary are pre-approved; any new rules the user proposes require explicit approval before being applied.

### Phase 3 — Analysis Loop

This is the core loop. The user drives direction; you follow.

**For each user question:**

1. Identify the best analysis approach. Check available code templates first — if one fits, use it (fill in parameters, do not rewrite).
2. If the question is ambiguous, ask one clarifying question before writing code.
3. Write Python code that conforms to the Output Contract (\`knowledge/output-contract.md\`). Every script must produce a valid JSON envelope as its final \`print\` statement.
4. Execute via \`executeCode\`. Pass \`csvUrl\` from the current session — never a URL from memory or prior turns.
5. Return the result following **Tell / Show / Tell → CTA** format (see below).
6. After each analysis turn, identify candidate take-aways. Present drafted take-away cards for user approval. Never write to the knowledge graph without explicit approval.

**Tell / Show / Tell → CTA:**

\`\`\`
TELL    1 sentence: direct answer to the question asked. Lead with this always.
        Stop here if no chart is needed — short questions get short answers.

SHOW    Chart (html artifact from executeCode) + 1–2 sentence interpretation
        of what the chart shows.
        The artifact IS the Take-Away draft. Do not create a separate card.

TELL    2–5 supporting insights:
        - why the pattern exists
        - additional relevant detail
        - related or higher-impact discoveries
        Each insight is a candidate for follow-up.

CTA     1–2 suggested next questions or actions the user can accept, ignore, or redirect.
\`\`\`

For refinements of the same question (e.g., "make the bars blue", "show this by hour instead"), re-render the artifact in place. New questions get a new artifact slot.

**Tell before Show.** Before calling \`executeCode\`, write one sentence stating what you are about to analyze. After \`executeCode\` returns results, open your interpretation with the direct answer — lead with the specific number or finding, then show the chart as supporting evidence. The TELL sentence after the chart is where specific values from the results go; the sentence before the tool call sets context.

**One chart per card.** Each \`executeCode\` call produces exactly one chart. Never use \`make_subplots\` or multi-panel dashboards in a single call. An analysis that warrants 2–3 views should make 2–3 separate \`executeCode\` calls — one per question angle — and present each chart as its own card. Suggest additional charts as CTAs rather than bundling them.

**Table display rules.** When returning a table artifact: (1) never include UUID columns — use a plain integer index (\`#\`) instead; (2) limit columns to the 5 most relevant for the question; (3) always aggregate or summarize — never return raw per-row data unless the user explicitly asks for it.

**Code quality:**
- Use approved templates before writing new code.
- When writing new code, keep it minimal — solve the stated question, nothing more.
- Every \`executeCode\` call must produce a valid output envelope. If the code would not produce one, fix it before running.
- If E2B returns an error, surface the error and debug. Never invent what the output "would have been."

### Phase 4 — Wrap-up

When the user indicates they are done (says goodbye, opens a new session, or asks to close):
1. Save any pending approved take-aways or templates that have not been persisted.
2. Always save a session summary — even if analysis failed, errored, or was incomplete. The summary should capture: the stated objective, what was attempted, what succeeded, what failed, and recommended next steps for the following session. Call \`saveSessionSummary\`. Do not ask permission; do not offer to skip it. Make it count — it is what the next session gets as starting context.
3. Offer to promote the session to a \`/notebook\`: "Would you like to save this as a repeatable notebook? I can draft the step structure from what we just did."

---

## Technical Engagement Mode

The current Technical Engagement (TE) mode is injected at session start from the user's profile (\`technical_engagement\` field).

**delegate (current M1 default):**
- All technical gates (code review, template selection) are auto-approved.
- The user sees results and take-away approval cards — not code blocks unless they ask.
- Only Take-Away approval is required.
- Do not ask the user to review code before running it. Run it. Show them the outcome.

**collaborate (M2):**
- Show a plain-language "Run this analysis" summary before running code.
- Code is hidden in a [Details] block.
- Present approval cards for code + take-away.

**direct (M2):**
- Show full code block before every \`executeCode\` call.
- All approval gates visible.
- Surface troubleshooting cards on E2B failure.

---

## Behavioral Rules

**Evidence before interpretation.** Every interpretation references specific values from the artifact's \`data\` field. Do not state a finding without the supporting data.

**Beliefs are hypotheses.** When referencing an approved belief, frame it as a working hypothesis: "Our current belief is that ghost paths have dwell < 5s. Let's see if this dataset supports that."

**Templates over improvisation.** Always check available code templates before writing new code. Only write from scratch when no template fits.

**Approval before write.** Beliefs and code templates require explicit user confirmation before being written to Supabase. Ask; do not assume.

**One take-away at a time.** Do not batch take-away proposals. Surface one, let the user respond, then continue.

**Confidence is required.** Every take-away and belief has a confidence level. 0.90+ = high, direct language. 0.70–0.89 = moderate, hedge appropriately. Below 0.70 = flag as preliminary.

**No backend language.** Never mention tools, knowledge files, context loading, seed beliefs, session state, or any internal system mechanics. Phrases like "I have the domain context loaded", "the seed knowledge is built around this", "I can see this session has no CSV loaded" are all prohibited — they expose implementation details the user should not see. Speak only about the data and the analysis.

**csvUrl — establish once, hold for the session.** The \`csvUrl\` is established by one of three tools: \`getSessionContext\` (returns it if a prior upload exists), \`uploadDataset\` (returns it after registering a new CSV), or \`fetchSensorData\` (returns it after an API fetch). Once any of these tools returns a \`csvUrl\` in the current conversation, hold it for all subsequent turns — do not discard it. Never reuse a URL from a *different* session or guess a URL. If no tool has returned a \`csvUrl\` this conversation, ask the user to provide data.

**Coordinate interpretations require confirmation.** Never infer specific coordinate meanings (which direction y increases, what y=0 represents, what the x range maps to physically) from a deployment type label alone. Use the Coordinate System Confirmation Checklist in \`knowledge/domain/retail-context.md\` and ask the user to confirm before stating any coordinate interpretation. The domain knowledge contains typical patterns as starting hypotheses only — always verify with the user for the specific deployment.

---

## What You Know About This Domain

Static domain knowledge is loaded via \`readKnowledge\`:
- \`knowledge/domain/radar-sensors.md\` — sensor behavior, coordinate system, noise characteristics
- \`knowledge/domain/path-classification.md\` — engaged, passer-by, ghost path definitions and thresholds
- \`knowledge/domain/retail-context.md\` — deployment context, business objectives, store layout patterns

Dynamic knowledge (accumulated across sessions) is loaded via \`getSessionContext\` at session start.

When static and dynamic knowledge conflict, trust the dynamic knowledge — it was earned from real data.

---

## The Compounding Model

Each session should be smarter than the last:

1. Approved beliefs loaded at session start are the hypotheses your analysis tests
2. Confirmed beliefs gain confidence; contradicted beliefs trigger revision proposals
3. Approved code templates mean you never solve the same analytical problem twice
4. Session summaries mean you never re-explain the same context twice

Over time, the starting point on this problem advances: from "what is a ghost path?" to "here is our current v3 classifier and its known failure modes."

Every approved take-away, template, and summary is a permanent improvement to how you work.`;

// ─── Output Contract ───────────────────────────────────────────────────────────

export const OUTPUT_CONTRACT = `# Output Contract

Every Python script executed in the E2B sandbox must emit exactly one JSON object as its final stdout line. Both the agent (for interpretation) and the frontend (for rendering) depend on it.

## Envelope Types

### chart
\`\`\`json
{"type": "chart", "title": "...", "html": "<div...>...</div><script>...</script>", "data": {"data": [...], "layout": {...}}, "summary": "..."}
\`\`\`
- html: self-contained HTML fragment loading Plotly from CDN with a unique uuid-based element ID
- data: full Plotly figure spec for agent interpretation
- summary: plain-language description including key numerical observations

### table
\`\`\`json
{"type": "table", "title": "...", "data": [...], "columns": [...], "summary": "..."}
\`\`\`

### text
\`\`\`json
{"type": "text", "title": "...", "content": "...", "summary": "..."}
\`\`\`

### multi
\`\`\`json
{"type": "multi", "title": "...", "artifacts": [...], "summary": "..."}
\`\`\`

### error
\`\`\`json
{"type": "error", "title": "Analysis Error", "message": "...", "traceback": "..."}
\`\`\`

## Plotly HTML Pattern

\`\`\`python
import uuid, json
chart_id = f"plotly-{uuid.uuid4().hex[:8]}"
html = f'<div id="{chart_id}" style="width:100%;height:450px;"></div><script src="https://cdn.plot.ly/plotly-latest.min.js"></script><script>Plotly.newPlot("{chart_id}", {json.dumps(traces)}, {json.dumps(layout)});</script>'
\`\`\`

Always use uuid-based element IDs to avoid collisions across multiple charts in one session.

## Summary Field Requirements

- Plain language, no code or variable names
- At least one specific numerical observation
- 1–3 sentences maximum

## Validation Checklist

- Script ends with exactly one print(json.dumps({...}))
- Object has type, title, and summary at minimum
- Chart envelopes include both html and data
- Chart HTML uses a unique uuid-based element ID
- Table envelopes include both data (array) and columns (array)
- summary is specific and includes numerical values
- If any subprocess pip install is present, it is the very first statement in the script (before all imports), includes \`--root-user-action=ignore\` and \`capture_output=True\`. A pip install anywhere else will produce empty stdout.`;

// ─── Domain Knowledge ─────────────────────────────────────────────────────────
// Embedded so the Mastra Platform deployment artifact is self-contained.
// Source files: knowledge/domain/ and knowledge/beliefs/
// Update both the source .md and the constant below when revising domain knowledge.

export const DOMAIN_RADAR_SENSORS = `# Domain Knowledge: Radar Sensors

## What Radar Sensors Are

The radar sensors in this system are short-range FMCW (Frequency-Modulated Continuous Wave) radar devices mounted overhead in retail environments. They detect and track moving objects within their field of view, reporting each tracked entity as a \`target_id\` with position readings (x, y in meters) at approximately 1-second intervals.

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

**Common pattern**: In a retail aisle deployment, y=0 is near the sensor mounting point (ceiling), y increases toward the far end of the aisle. x=0 is the centerline (directly in front of the sensor); negative x is left of the sensor and positive x is right — both are normal, expected values.

**Coordinate guarantee**: The DR6000 sensor validates positional bounds before output. Null x_m or y_m values are unexpected and indicate a data pipeline issue, not a normal sensor condition. x=0 is a valid coordinate (shopper directly in front of the sensor) and must never be treated as missing.

---

## Data Format

| Field | Description |
|-------|-------------|
| \`log_creation_time\` | Timestamp of the position reading. Use this for temporal analysis. |
| \`processed_at\` | When the reading was processed by the data pipeline — slightly later than \`log_creation_time\`. Do not use for temporal analysis. |
| \`target_id\` | UUID assigned to a tracked entity for the duration of its presence in the detection zone. Not persistent across separate appearances. |
| \`sensor_id\` | Organizational identifier for the sensor (e.g., \`org_abc123\`) |
| \`sensor_name\` | Human-readable sensor name (e.g., \`radar-001\`) |
| \`mac_address\` | Hardware MAC address of the device |
| \`x_m\` | X-position in meters. x=0 is directly in front of the sensor; negative x is left; positive x is right. Sensor guarantees coordinate values. |
| \`y_m\` | Y-position in meters. y=0 is directly below the sensor; positive y is away from the sensor (deeper into zone). |
| \`account_id\` | Client/organization identifier |
| \`device_id\` | Device record ID |

---

## Detection Physics and Noise Characteristics

**Ghost paths** arise from radar physics, not human behavior:
- **Multipath reflections**: The radar signal bounces off a nearby shelf or wall and creates a phantom detection near the real target
- **Static clutter**: Stationary objects (shelving, signage) can generate spurious detections if they have reflective surfaces — typically appear as very short paths with near-zero movement
- **Entry/exit artifacts**: As a person enters or leaves the detection zone, partial readings at the fringe can create very short paths with few data points
- **Sensor startup noise**: The first 30–60 seconds after sensor power-on may produce spurious detections as the radar calibrates

**Known ghost signatures** (working hypotheses — see seed beliefs for confirmed thresholds):
- Very short dwell time (< 3–5 seconds)
- Very small positional variance (target never actually moves; std of x and y positions near zero)
- Position coordinates near the edge of the detection zone (fringe detections)
- Path appears isolated in time (no nearby paths at the same moment — may indicate reflection rather than person)
- Unusually regular sampling intervals (genuine human movement has irregular step patterns; reflections may be perfectly periodic)

---

## Multi-Sensor Deployments

Multiple sensors may appear in a single CSV file (different \`sensor_name\` / \`sensor_id\` values). Important:
- Each sensor has its own coordinate system — x=1.5m on sensor A is not the same physical location as x=1.5m on sensor B
- Sensor fields overlap in retail deployments; the same person may appear in both sensors simultaneously with different coordinates
- Cross-sensor path matching (linking the same physical person across sensors) requires spatial and temporal alignment — it is a hard problem not addressed in the base templates

When multiple sensors are present, analyze each separately unless the session objective specifically requires cross-sensor alignment.

---

## Sampling Rate and Gaps

The sensor reports approximately 1 reading per second per target. However:
- Readings are not guaranteed to be exactly 1 second apart
- Gaps can occur if the target briefly exits the detection zone and re-enters (creates a new \`target_id\`)
- High-density periods (many simultaneous targets) may see reduced sampling rate per target
- The \`difftime\` between consecutive readings for a target should be checked; gaps > 5 seconds within a path suggest possible detection interruptions

---

## What the Sensor Does NOT Measure

- Identity (who the person is)
- Intent (what they're doing)
- Direction of gaze
- Whether a hand reached toward a product
- Cart vs. person (both are tracked as targets; cannot distinguish without additional context)`;

export const DOMAIN_PATH_CLASSIFICATION = `# Domain Knowledge: Path Classification

## Overview

A "path" is one continuous detection sequence for a single \`target_id\` — from when the radar first detects the entity to when it exits the detection zone. The goal of path classification is to label each path as one of three categories:

| Category | Definition |
|----------|-----------|
| **Engaged** | A person who stopped, lingered, and likely interacted with the product or display |
| **Passer-by** | A person who walked through the detection zone without stopping |
| **Ghost** | A sensor artifact — not a real person |

---

## Working Definitions

### Engaged

A path is likely **engaged** when:
- \`dwell_seconds\` is long relative to the detection zone size (the threshold is deployment-specific — typically > 15–30 seconds for a 3m deep zone)
- Positional variance is moderate: the person moved around within a bounded area (they were browsing, not just standing still or walking through)
- The position cluster is spatially consistent with where the product or interaction point is located
- The path has many data points (dense sampling throughout, no long gaps)

Engaged paths are the primary signal of commercial interest. They are what the client wants to maximize.

### Passer-by

A path is likely a **passer-by** when:
- \`dwell_seconds\` is short-to-moderate (3–15 seconds for a typical zone)
- The path shows directional movement: x or y changes consistently in one direction (they walked through)
- Position starts at one edge of the detection zone and ends at the other
- The path has moderate data point density

Passer-bys are people who were present but not engaged. They represent potential audience who did not stop.

### Ghost

A path is likely a **ghost** when:
- \`dwell_seconds\` is very short (< 3–5 seconds — deployment-specific threshold)
- Positional variance is near-zero: the "person" never actually moves (std of x_m and y_m < 0.1–0.2m)
- The position is at the fringe of the detection zone (near maximum y distance, or at the x extremes)
- The path exists in isolation: no other paths are active at the same time nearby
- The path's position matches known reflective surfaces (shelving, metal fixtures) in the store layout

Ghosts inflate path counts and should be excluded from engagement metrics before analysis.

---

## The Classification Challenge

The three categories are not cleanly separable with a single threshold. The current approach is hierarchical:

**Step 1 — Ghost filter**: Remove paths that are clearly artifacts. Apply dwell and positional variance thresholds. This is the highest-priority filter.

**Step 2 — Passer-by vs Engaged**: Among non-ghost paths, separate based on dwell time, spatial variance, and movement directionality. This boundary is more context-dependent and is where most of the algorithm development work lives.

**Known ambiguities**:
- A person who enters, hesitates briefly, and leaves may have ghost-like dwell but non-ghost movement
- A cleaning staff member pushing a cart may dwell for a very long time in one spot (engaged-looking) but has no commercial intent
- A person standing next to a long-dwelling engaged person may appear as a shorter-dwell path at the same location — looks like a passer-by but may have been engaged together

---

## Path-Level Feature Engineering

Before classifying, the raw per-row sensor data must be aggregated to the path level. Key features:

| Feature | How to Compute | Relevance |
|---------|---------------|-----------|
| \`dwell_seconds\` | \`max(log_creation_time) - min(log_creation_time)\` | Primary ghost filter; primary engagement signal |
| \`point_count\` | Row count per \`target_id\` | Proxy for data quality; low count = unreliable path |
| \`pos_std_x\` | \`std(x_m)\` per target | Low = stationary (ghost or standing still) |
| \`pos_std_y\` | \`std(y_m)\` per target | Low = stationary |
| \`pos_range_x\` | \`max(x_m) - min(x_m)\` | High = lateral movement (browsing vs pass-through) |
| \`pos_range_y\` | \`max(y_m) - min(y_m)\` | High = walked through zone (passer-by signature) |
| \`centroid_x\` | \`mean(x_m)\` | Spatial location of activity |
| \`centroid_y\` | \`mean(y_m)\` | Spatial location of activity |
| \`start_hour\` | Hour of \`min(log_creation_time)\` | Time-of-day signal for ghost likelihood |
| \`is_fringe\` | Whether centroid is near detection zone edge | Ghost indicator |

---

## Algorithm Development Status

The classification algorithm is a work in progress. See the seed beliefs for the current approved thresholds and the session history that produced them.

The goal is a Python function with the following signature:

\`\`\`python
def classify_path(path_row: dict) -> str:
    """
    Returns 'ghost', 'passer-by', or 'engaged' for a single path-level row.
    Input is a dict with path-level features (dwell_seconds, pos_std_x, pos_std_y, etc.)
    """
    ...
\`\`\`

This function, once approved, should be saved as a code template and referenced by name in all future sessions.

---

## Evaluation Framework

When testing a classifier version, report:
- **Precision**: Of paths labeled Ghost, what % are actually ghosts? (False positives = real paths mislabeled as ghosts)
- **Recall**: Of actual ghosts, what % did the classifier catch? (False negatives = ghosts mislabeled as real)
- **Ground truth method**: Since we have no labeled data, ground truth is currently established by visual inspection of path trajectories — the user manually reviews borderline cases and labels them

As labeled examples accumulate across sessions, a more rigorous evaluation becomes possible.`;

export const DOMAIN_RETAIL_CONTEXT = `# Domain Knowledge: Retail Context

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

At the start of any new deployment's data, confirm with the user:
1. Where is the sensor mounted relative to the product display or interaction point?
2. Which direction does y increase? (toward the main aisle/entrance, or away?)
3. What physical width does the full x range represent? (helps interpret engagement clusters)
4. Is there a known reflective surface at any specific (x, y) that would explain ghost clustering? (metal shelving, signage, fixtures)

Note: x=0 is always the centerline (directly in front of the sensor). Negative x is always the left side of the sensor's view, positive x is always the right side — both are valid, expected values. The sensor validates coordinate bounds before output.

Store confirmed answers in the org's Data Dictionary under \`coordinate_system_notes\`.`;

export const DOMAIN_DR6000_SCHEMA = `# DR6000 API — Data Dictionary

Data retrieved via the DR6000 API has a fixed, known schema. No data dictionary drafting is required for API-sourced sessions.

## Sessions Report

One row per person-visit (one target entering and leaving the sensor's field of view).

| Column | Type | Description |
|--------|------|-------------|
| processed_at | timestamp | When the API request was processed. Do NOT use for temporal analysis. |
| account_id | string | Account ID associated with the sensor. |
| device_id | string | ID of the edge device the sensor is associated with. |
| log_creation_time | timestamp | Timestamp of the data point. Use this for ALL temporal analysis. |
| timezone_offset | integer | Numeric timezone offset (e.g. -300 = UTC-5). |
| timezone_label | string | Timezone name (e.g. America/New_York). |
| sensor_id | string | ID of the sensor. |
| sensor_name | string | User-defined name of the sensor. |
| mac_address | string | MAC address of the edge device. |
| target_id | uuid | Unique ID for the tracked target during this visit. Not persistent across separate appearances — a new target_id is assigned each time a person re-enters the field of view. |
| dwell_tracking_area_sec | float | Seconds the target spent in the sensor's full field of view (Tracking Area). Primary engagement signal. |
| zone_dwell_times_json | string | JSON string of zone names and dwell times per zone (e.g. {"zone 1","3.2";"zone 2","0.0"}). |
| proximity_m | float | Closest distance in meters the target reached to the sensor. |

## Paths Report

One row per position reading, approximately every 1 second per target. Use this for spatial/movement analysis.

| Column | Type | Description |
|--------|------|-------------|
| processed_at | timestamp | When the API request was processed. Do NOT use for temporal analysis. |
| account_id | string | Account ID associated with the sensor. |
| device_id | string | ID of the edge device. |
| log_creation_time | timestamp | Timestamp of the position reading. Use this for ALL temporal analysis. |
| timezone_offset | integer | Numeric timezone offset. |
| timezone_label | string | Timezone name. |
| sensor_id | string | ID of the sensor. |
| sensor_name | string | User-defined name of the sensor. |
| mac_address | string | MAC address of the edge device. |
| target_id | uuid | Unique ID for the tracked target. Same semantics as Sessions report. |
| x_m | float | X coordinate in meters. 0 = directly in front of sensor centerline. Negative = left of sensor. Positive = right of sensor. |
| y_m | float | Y coordinate in meters. 0 = directly below sensor. Positive = moving away from sensor (deeper into zone). |

## Report Selection Guide

| Use Case | Report Type |
|----------|-------------|
| How many people visited? | sessions |
| Average or total dwell time | sessions |
| Engagement rate (dwell > threshold) | sessions |
| Zone-level dwell analysis | sessions |
| Proximity / closest approach | sessions |
| Where did people walk? (heatmap) | paths |
| Path trajectories and movement patterns | paths |
| Ghost path detection (requires x/y variance) | paths |
| Spatial clustering analysis | paths |`;

export const SEED_BELIEFS = `# Approved Beliefs — Seed File

This file contains beliefs that are pre-loaded into every deployment. They represent starting hypotheses based on domain knowledge, not yet confirmed by session analysis.

As sessions run and evidence accumulates, beliefs are updated in Supabase. This file is the **seed state** — deployed with the code, not modified at runtime. Supabase is the live append target.

To update this seed file, edit the source at knowledge/beliefs/approved-takeaways.md and update this constant.

---

## How to Read This File

Each belief has:
- **ID**: Unique reference used in session summaries and evidence chains
- **Type**: Take-Away | Belief | False-Belief | Algorithm Version | Pending
- **Confidence**: 0.0–1.0 (see instructions for scale)
- **Content**: The claim
- **Evidence**: What supports it (session IDs added at runtime; seed beliefs cite source literature or first principles)
- **Tags**: For retrieval by \`readKnowledge\`

---

## Seed Beliefs

---

**ID**: \`belief_ghost_dwell_threshold_seed\`
**Type**: Pending
**Confidence**: 0.60
**Content**: Ghost paths in retail radar deployments have dwell times shorter than genuine human paths. A dwell threshold of 3–5 seconds is a reasonable starting point for the ghost filter. The exact threshold is deployment-specific and should be refined with session data.
**Evidence**: First principles (sensor physics) + domain literature on retail FMCW radar deployments.
**Tags**: ghost-detection, path-classification, dwell-time

---

**ID**: \`belief_ghost_positional_variance_seed\`
**Type**: Pending
**Confidence**: 0.65
**Content**: Ghost paths caused by multipath reflection or static clutter have near-zero positional variance — the "target" does not move. Genuine human paths show non-trivial movement even when stationary (micro-movements, weight shifts). A positional standard deviation threshold of 0.10–0.20m in both x and y is a reasonable ghost indicator.
**Evidence**: Radar physics (reflection artifacts are stationary by definition). Confidence is moderate because sensor noise can simulate small movement.
**Tags**: ghost-detection, path-classification, positional-variance

---

**ID**: \`belief_fringe_detection_seed\`
**Type**: Pending
**Confidence**: 0.55
**Content**: Short paths that appear at the edge of the detection zone (high y values, near maximum range) are disproportionately likely to be fringe artifacts rather than genuine paths. The sensor's detection reliability decreases at range extremes.
**Evidence**: First principles (radar SNR decreases with distance). Low confidence — needs empirical confirmation from session data.
**Tags**: ghost-detection, sensor-behavior, fringe

---

**ID**: \`belief_path_aggregation_unit_seed\`
**Type**: Belief
**Confidence**: 0.95
**Content**: The correct unit of analysis for engagement metrics is the path (grouped by target_id), not the individual position reading (row). Computing metrics on raw rows produces meaningless results. All analysis must begin with path aggregation.
**Evidence**: Definitional — a "path" is a single entity's presence event. Row-level analysis conflates path length with engagement signal.
**Tags**: data-model, path-aggregation, methodology

---

**ID**: \`belief_log_creation_time_seed\`
**Type**: Belief
**Confidence**: 0.95
**Content**: \`log_creation_time\` is the correct timestamp field for temporal analysis. \`processed_at\` reflects pipeline processing delay and should not be used for time-window filtering or dwell calculation.
**Evidence**: Data schema definition. \`processed_at\` is systematically later than \`log_creation_time\` by the pipeline processing latency.
**Tags**: data-model, timestamps, methodology

---

*Runtime-approved beliefs are stored in Supabase \`knowledge_beliefs\` table and loaded via \`getSessionContext\`. They do not appear in this file.*`;
