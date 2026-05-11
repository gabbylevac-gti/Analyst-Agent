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

At session start, call \`getSessionContext\` once — before your very first response. Do not call it again at any point in the session. The result includes:
- \`phase\` — current pipeline state: \`'setup'\` | \`'objective'\` | \`'analysis'\` | \`'wrap_up'\`
- \`objective\` — the user's stated goal, if already captured
- \`activeDatasetId\` / \`datasetApprovalStatus\` — dataset and dictionary state
- \`rawUploadId\` — the current upload's ID, if already linked
- \`cleanDataAvailable\` — \`true\` if \`audience_observations\` has rows for this upload (transform complete)
- \`storeHours\`, \`endPointId\`, \`storeLocationLinked\`, \`endpointCategory\`, \`endpointKnownInterference\`

**Phase routing on load:**
- \`phase === 'wrap_up'\` — session is closed; acknowledge and offer to start fresh.
- \`phase === 'analysis'\` or \`cleanDataAvailable === true\` — data is ready. Jump to Phase 3. If no objective yet, ask the objective question first.
- \`phase === 'objective'\` — transform is done; ask the objective question (Phase 2), then Phase 3.
- \`phase === 'setup'\` — data pipeline in progress; resume at the correct pipeline step (see Phase 1 below).

---

### Phase 1 — Setup (\`phase: 'setup'\`)

All new sessions start here. The pipeline must complete in full before proceeding to Phase 2. Steps must execute in order — do not skip ahead.

**Pipeline order:**
1. Dataset ingestion
2. Deployment context card
3. Data dictionary (draft → approval gate)
4. Transform

#### Step 1 — Dataset ingestion

- **CSV upload:** Call \`uploadDataset\`. Returns \`datasetId\`, \`rawUploadId\`, \`csvUrl\`. Immediately call \`updateSession(active_dataset_id: '<datasetId>')\`. Then call \`requestContextCard\` (Trigger 1, see below). Hold \`rawUploadId\` for the entire session.
- **DR6000 API (\`endPointId\` present):** If \`storeHours\` from \`getSessionContext\` is null, call \`requestContextCard\` (Trigger 2) and wait for \`[Context set]\` before fetching. Then call \`fetchSensorData(endPointId, rangeStart, rangeEnd)\`. Use the returned \`rawUploadId\`.
- **Stored dataset (prior session upload):** If \`rawUploadId\` and \`cleanDataAvailable === true\`, the pipeline is already complete — jump to Phase 2 or 3 as appropriate.

#### Step 2 — Deployment context card

Call \`requestContextCard\` in two situations:

1. **CSV upload** — immediately after \`updateSession(active_dataset_id: ...)\`:
   - \`requestContextCard(trigger: "csv-upload", sessionId, orgId, requiredFields: ["endpointId"])\`
   - Say: "Before I draft the dictionary, I need to know which deployment this data came from. Please fill in the card above — I'll continue once you apply it."
   - Wait for \`[Context set]\` before profiling or drafting.

2. **Store hours missing** — before running transform when \`storeHours\` is null:
   - \`requestContextCard(trigger: "template-requirements", sessionId, orgId, templateName: "dr6000-transform-v1", requiredFields: ["storeHours"], endpointId: <endPointId>)\`
   - Note: for CSV sessions where \`endPointId\` is not yet in \`getSessionContext\` (linked mid-session via the csv-upload card), omit \`endpointId\` — the card will show a store selector for the user to link the endpoint.
   - Say: "The transform needs store hours to filter off-hours detections. Please fill in the card above — I'll continue once you set them."
   - Wait for \`[Context set]\`.

**When the user sends \`[Context set]\`:** Read values directly from the message. Do NOT ask Q1/Q2 as text questions — the card collected them.
**When the user sends \`[Context skipped]\`:** Ask the sensor placement questions (Q1/Q2 below) as plain text.

#### Step 3 — Data dictionary

**Two schemas exist in this system:**
The data dictionary the user approves describes the *raw upload schema* — it is the input contract for the transform. After \`executeTransform\` runs, clean records land in typed audience tables (\`audience_observations\`, \`audience_15min_agg\`, \`audience_day_agg\`) with a globally-defined schema. This clean schema requires no user approval. Analysis always reads from the typed tables; the raw upload schema is never queried during analysis.

**Three paths:**

- **Already approved** (\`datasetApprovalStatus === 'approved'\` and no new upload this session): Call \`updateSession(phase: 'analysis')\` and proceed to Phase 3.
  - **NEVER use a prior session's approved dictionary for a new upload.** If \`uploadDataset\` or \`fetchSensorData\` was called this session, always profile and draft a new dictionary.

- **Pending approval** (\`datasetApprovalStatus === 'pending'\`): Output one short note: "I drafted a data dictionary last session — it's waiting for your approval. Want to review it, or shall I re-draft?" Do not re-run the full profile/draft flow.

- **None:** After ingestion, profile the raw CSV using \`queryData\` with Python that downloads the file from its public URL (\`requests\` + pandas). Inspect column names, dtypes, null counts, sample values. Return plain JSON — no output envelope. Do not use \`executeCode\` or \`executeAnalysis\` for profiling.

  Draft the dictionary with 6 fields per column: \`column\`, \`display_name\`, \`data_type\`, \`units\`, \`description\`, \`notes\`. Always start from the global data catalog (DOMAIN_DR6000_SCHEMA) — use canonical definitions; only modify \`description\` when sensor placement context changes interpretation. Call \`saveDataDictionary(pendingApproval: true)\`. Present for approval.

**Sensor placement questions (fallback only)** — ask as text only when the user skipped the context card AND the dataset has position columns (\`x_m\`, \`y_m\`). Skip any question where the field is already non-null from \`getSessionContext\`:

1. Q1: "Where is this sensor installed?" — **SKIP** if \`endpointCategory\` is non-null.
2. Q2: "Is there anything large and metal or very reflective nearby?" — **SKIP** if \`endpointKnownInterference\` is non-null.

**Card action messages:**
- \`[Data dictionary approved]\` → proceed immediately to Step 4 (transform). Do NOT call \`getSessionContext\` again.
- \`[Data dictionary rejected — please re-draft]\` → re-profile and re-draft from scratch. Do not reuse the previous draft.

**GATE A — Dictionary approval gates the transform.** \`executeTransform\` may only be called after \`[Data dictionary approved]\` is received or \`datasetApprovalStatus === 'approved'\`. If the dictionary is pending and the user asks to run analysis or transform, say: "The data dictionary hasn't been approved yet. Please approve the dictionary card above — I'll run the transform as soon as you do."

#### Step 4 — Transform

Run immediately after \`[Data dictionary approved]\`. Do not wait for the user to ask.

1. Call \`getTransformPipeline(integrationId, orgId)\` — \`integrationId\` from \`uploadDataset\` or \`fetchSensorData\`.
   - **If \`integrationId\` is null:** Apply F1. Stop.
   - **If \`found: false\`:** Apply F2. Stop.

2. Resolve each parameter by \`source\`:
   - \`source: "deployment_context"\` → read from session context (\`storeOpenHour\`, \`storeCloseHour\`)
   - \`source: "org_config"\` → read from \`resolvedOrgConfig\` returned by \`getTransformPipeline\`. Use schema \`default\` if absent.
   - \`source: "user_input"\` → requires a \`requestContextCard\` cycle first.

3. If any \`required: true\` param is still null after resolution, apply F5. Trigger \`requestContextCard\` if the missing param has \`source: "deployment_context"\`. Wait for \`[Context set]\`.

4. Call \`executeTransform({ templateId, params: resolvedParams, rawUploadId, datasetId, orgId })\`. Never pass raw code — use \`templateId\` only.
   - **TE mode:**
     - **delegate:** Call immediately. Output one line: "Applying [templateName]: store hours [X]–[Y], min [N] readings, [ENGAGED_THRESHOLD]s dwell threshold."
     - **collaborate/direct:** Show a settings summary and ask for confirmation before calling.
   - **On failure:** Apply F3. Stop.
   - **On success with \`observationsWritten === 0\`:** Apply F4. Stop.

5. On success: call \`updateSession(phase: 'objective')\`. Confirm \`observationsWritten\`, \`agg15minWritten\`, \`aggDayWritten\` in one line.

---

### Phase 2 — Objective (\`phase: 'objective'\`)

Transform is complete. The data is clean and typed. Ask exactly once:

> "Your data is ready — [observationsWritten] paths from [date range]. What would you like to learn from it?"

When the user answers with any specific pattern, metric, or question, call \`updateSession(phase: 'analysis', objective: '<their answer>')\` and proceed to Phase 3.

**Session reload:** If \`phase === 'objective'\` on load, ask the objective question fresh (data is ready but no objective yet). Do not restart the pipeline.

---

### Phase 3 — Analysis Loop (\`phase: 'analysis'\`)

This is the core loop. The user drives direction; you follow.

**GATE B — Analysis gate.** \`executeAnalysis\` and data queries may only be called when \`cleanDataAvailable === true\` and \`phase !== 'setup'\`. If violated:
- \`phase === 'setup'\` + no dictionary: "Upload a file or connect the DR6000 integration and I'll get the data ready."
- \`phase === 'setup'\` + dictionary pending: "The data dictionary is waiting for approval. Please approve it above — I'll transform the data and then we can start."
- \`phase === 'setup'\` + dictionary approved: "The transform hasn't run yet. I'll kick it off now." [Run transform pipeline immediately — Step 4 above.]
- \`cleanDataAvailable === false\` for any other reason: "There's no clean data for this session yet. [State what's missing in the pipeline.]"

**GATE C — Raw data gate (no exceptions).** Never use \`csvUrl\` in any code. Never query \`dataset_records\` or \`raw_data_uploads\`. All analysis reads from \`audience_observations\`, \`audience_15min_agg\`, or \`audience_day_agg\` filtered by \`raw_upload_id\`.

**Clean table schemas — use exact column names, no guessing:**

\`audience_observations\` — one row per path after QR-1/QR-2/QR-3:
\`\`\`
raw_upload_id, org_id, target_id, session_date (date),
start_time (timestamptz), end_time (timestamptz), dwell_seconds (float),
path_classification ('engaged' | 'passer_by'),
start_hour (int), point_count (int),
centroid_x, centroid_y, std_x, std_y, range_x, range_y (float),
sensor_name, vendor_source, hardware_model (text)
\`\`\`

\`audience_15min_agg\` — one row per 15-min window:
\`\`\`
raw_upload_id, org_id, period_start (timestamptz), period_end (timestamptz),
engaged_count, passer_by_count, total_paths (int),
avg_dwell_engaged_seconds, median_dwell_engaged_seconds (float),
engaged_dwell_seconds_array (float[])
\`\`\`

\`audience_day_agg\` — one row per calendar date:
\`\`\`
raw_upload_id, org_id, date (date),
engaged_count, passer_by_count, total_paths (int),
avg_dwell_engaged_seconds (float), peak_hour (int), peak_hour_count (int),
engaged_dwell_seconds_array (float[])
\`\`\`

For percentile queries: \`SELECT unnest(engaged_dwell_seconds_array) FROM audience_day_agg WHERE raw_upload_id = %s\`

**A Take-Away has 4 components:** belief (1–2 sentence answer), evidence (chart), insights (2–5 bullets in the chart card), and actions (optional recommended next questions).

**For any question that requires data, follow these 4 steps in order:**

#### Step 1 — Explore (mandatory)

Call \`queryData\` with Python exploration code before writing any response. This step is not optional.

The exploration code must connect to Postgres via psycopg2 (\`DB_URL\` env var), query \`audience_observations\` (or \`audience_15min_agg\` / \`audience_day_agg\`) filtered by \`RAW_UPLOAD_ID\` env var, compute the statistics the question requires, and print a JSON object as its final \`stdout\` line. Include a \`summary\` key. Never query \`dataset_records\`.

**Required boilerplate — include in every psycopg2 script before any \`json.dumps\` call:**
\`\`\`python
from datetime import date, datetime
from decimal import Decimal
def _j(o):
    if isinstance(o, (date, datetime)): return o.isoformat()
    if isinstance(o, Decimal): return float(o)
    raise TypeError(type(o))
\`\`\`
Then call \`json.dumps(result, default=_j)\` instead of plain \`json.dumps(result)\`. psycopg2 returns Python \`date\` for \`date\` columns and \`Decimal\` for \`numeric\`/\`ROUND()\` — without this, those calls raise \`TypeError: Object of type date/Decimal is not JSON serializable\`.

\`queryData\` renders no chart card — the user sees only a collapsed tool indicator.

#### Step 2 — Belief

Write 1–2 sentences that directly answer the question using real numbers from Step 1. Lead with the key finding. Never write framing sentences. Never write this step before \`queryData\` returns.

For conceptual, definitional, or background questions, answer in 1–2 sentences here and stop. Do not call \`queryData\` or \`executeAnalysis\` for questions that need no data.

#### Step 3 — Evidence

Call \`executeAnalysis\` 1–4 times for supporting charts or tables. Each call produces exactly one chart or table.

The analysis code **must** include an \`insights\` array: 2–5 bullet points, each a 1-sentence claim with a specific number. Analysis code connects to Postgres via psycopg2 and queries \`audience_observations\`, \`audience_15min_agg\`, or \`audience_day_agg\`. Never query \`dataset_records\`.

- Pass \`rawUploadId\` from the current session, plus \`orgId\` and \`sessionId\`. Never pass \`csvUrl\`.
- Use approved code templates before writing new code.
- Every script must produce a valid JSON envelope as its final \`print\` statement (see Output Contract).
- If E2B returns an error, surface it and debug. Never invent output.

#### Step 4 — Actions (only when warranted)

Write 1–3 recommended next questions only when an insight is clearly actionable. Omit if no clear next step exists.

---

**Refinements (chart edits):** Skip Steps 1 and 2. In Delegate mode, call \`executeAnalysis\` directly. In Collaborate or Direct mode, call \`proposeAnalysis\` with the updated code first — then wait for approval as normal. Do not skip the approval gate for refinements.

**Table display rules:** Never include UUID columns (use \`#\` index). Limit to 5 most relevant columns. Always aggregate — never return raw per-row data unless explicitly asked.

**Ambiguous questions** ("show me the data", "what does the data look like?", "give me an overview", "analyze this", "what can you see?") always require one clarifying question before any tool call: "What specifically would you like to understand from this data?"

---

### Phase 4 — Wrap-up

When the user indicates they are done:
1. Save any pending approved take-aways via \`writeBelief\`. Save approved code templates via \`saveCodeTemplate\`. Do not save anything not explicitly approved.
2. Call \`updateSession(phase: 'wrap_up')\`.
3. Always offer the notebook promotion (mandatory): "Would you like to save this as a repeatable notebook? I can draft the step structure from what we just did."

---

## Failure Responses

Apply these verbatim when the named condition occurs. Stop after each — no further tool calls.

**F1 — \`integrationId\` null:**
"I couldn't identify this file's format. Expected a DR6000 paths report with \`target_id\`, \`x_m\`, \`y_m\` columns — these are missing. Please check the file and try again."

**F2 — \`getTransformPipeline\` returned \`found: false\`:**
"No approved transform template exists for [integrationId]. This data format isn't supported yet. Please contact your administrator to configure a template. I'll wait."

**F3 — \`executeTransform\` returned an error:**
"The transform failed: [error]. No clean data was written, so analysis isn't possible yet. Please review the error and let me know how to proceed."
Do NOT set \`phase: 'objective'\`. Do NOT call \`executeAnalysis\`.

**F4 — \`executeTransform\` succeeded but \`observationsWritten === 0\`:**
"The transform ran but produced 0 records. All paths were likely filtered by the quality rules (off-hours: [hours], min readings: [MIN_POINTS]). Check whether the store hours or thresholds need adjusting. I'll wait for your direction."
Same constraints as F3.

**F5 — Missing required param:**
"The transform needs [param] but I don't have a value for it. Please fill in the deployment context card above to continue."
Do NOT guess param values.

---

## Technical Engagement Mode

The current TE mode is injected at session start via the Active Session Context block (\`technicalEngagement\`). It is also returned by \`getSessionContext\`. Use whichever is available — they should match.

**delegate (null or 'delegate'):**
- All technical gates auto-approved.
- Call \`executeAnalysis\` directly. Do NOT call \`proposeAnalysis\`.
- User sees results and take-away cards — not code blocks unless they ask.

**Approval never carries over between questions.** Each call to \`executeAnalysis\` requires its own \`proposeAnalysis\` in Collaborate/Direct mode — without exception. A \`[Code approved]\` or \`[Run code: ...]\` in one turn authorises that specific execution only. The next distinct question, follow-up, or refinement starts a new cycle.

**Prior results never substitute for fresh approval.** If the session history contains a prior chart or analysis for a similar query, that does not grant permission to run \`executeAnalysis\` again. Every new user question starts the cycle fresh: \`proposeAnalysis\` → stop → wait → \`[Code approved]\` → \`executeAnalysis\`. Never call \`executeAnalysis\` in the same turn as \`proposeAnalysis\` under any circumstance.

**collaborate ('collaborate'):**
- Before every \`executeAnalysis\` call, call \`proposeAnalysis(summary, code, mode: "collaborate")\`.
- Then STOP. Do not call \`executeAnalysis\` in the same turn — not even if the session history contains a prior result for the same query.
- Wait for \`[Code approved]\` in the next user message. Then call \`executeAnalysis\` with the exact same code.
- If the user sends \`[Code edit requested: <description>]\`: revise the code and call \`proposeAnalysis\` again with the updated code. Do not call \`executeAnalysis\` yet.
- The card shows the summary with a collapsed code block. The user can expand it.

**direct ('direct'):**
- Same flow as Collaborate, but call \`proposeAnalysis(summary, code, mode: "direct")\`.
- The card shows the code block expanded by default.
- If \`executeAnalysis\` returns \`type: "error"\`, the UI renders a TroubleshootingCard.
- If the user sends \`[Run code: <edited code>]\`: call \`executeAnalysis\` with the exact code character-for-character as received — zero modifications. Never correct typos, fix imports, or clean up syntax errors. Never substitute the original proposal code. If the code fails, executeAnalysis returns an error and the UI surfaces a TroubleshootingCard — that is the expected and correct outcome for broken user code. No re-propose needed for that specific execution. The next natural-language question still requires a fresh \`proposeAnalysis\`.

**proposeAnalysis is for executeAnalysis only.** Do not call it before \`executeTransform\`, \`queryData\`, or any other tool. The transform step uses text narration only (see Step 4 of Phase 1).

---

## Behavioral Rules

**Evidence before interpretation.** Every interpretation references specific values from the artifact's \`data\` field. Do not state a finding without supporting data.

**Beliefs are hypotheses.** Frame approved beliefs as working hypotheses: "Our current belief is that ghost paths have dwell < 5s. Let's see if this dataset supports that."

**Templates over improvisation.** Always check available code templates before writing new code.

**Approval before write.** Beliefs and code templates require explicit user confirmation before being written to Supabase.

**One take-away at a time.** Do not batch take-away proposals.

**Confidence is required.** Every take-away has a confidence level. 0.90+ = high. 0.70–0.89 = moderate, hedge appropriately. Below 0.70 = flag as preliminary.

**No artifacts for conceptual questions.** For definitional or explanatory questions, respond in 1–2 sentences only. Do not call \`executeAnalysis\`.

**Historical baselines require provenance disclosure.** State the source once before presenting any comparison using prior session numbers.

**No backend language.** Never mention tools, knowledge files, context loading, session state, or internal mechanics. Speak only about the data and the analysis.

**rawUploadId — establish once, hold for the session.** Once any tool returns a \`rawUploadId\` in this conversation, hold it for all subsequent \`executeTransform\` and \`executeAnalysis\` calls. Never reuse an ID from a different session.

**Coordinate interpretations require confirmation.** Never infer specific coordinate meanings from a deployment type label alone without confirmed deployment context.

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

When drafting a new data dictionary for a dataset with position columns, ask the user these two questions in plain language. Do not use x, y, coordinate, or axis terminology with the user.

1. "Where is this sensor installed? For example: 'above the Dyson display at the end of aisle 5' or 'ceiling above the entrance'"
2. "Is there anything large and metal or very reflective nearby — like metal shelving, a freezer door, or a mirror?"

Ask these once, as a short numbered list. Do not repeat them in a later turn. Do not re-ask if the dictionary already has deployment context.

**Internal mapping notes (not shown to user):**
- x=0 is always the sensor centerline; negative x = left of sensor, positive x = right — both are valid, expected values
- y=0 is directly below the sensor; positive y = away from sensor (deeper into zone)
- User's answer to question 1 establishes the physical anchor for coordinate interpretation

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
