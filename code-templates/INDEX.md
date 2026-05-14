# Code Templates — Index

## Purpose

This directory contains approved Python analysis templates. Every template follows the Output Contract (`knowledge/output-contract.md`) and has been tested against real sensor data.

The agent uses these templates instead of writing code from scratch. When a user's question matches a template's purpose, load the template, fill in the parameters, and execute. Only write new code when no template fits.

---

## How to Use a Template

1. Read the template file
2. Replace all `{{PLACEHOLDER}}` tokens with session-specific values
3. Verify the parameterized script passes the Output Contract pre-flight checklist
4. Execute via `executeCode` tool
5. Parse the returned envelope; invoke `interpret-artifact`

---

## Template Registry

Templates follow a two-stage pipeline: `transformation` templates process Raw → Clean (write to audience_* tables); `analysis` templates read clean data and produce output envelopes. See `knowledge/data-catalog/dr6000-sensor.md` for the full pipeline architecture.

The `template_type` column in `code_templates` is the canonical source of truth for routing. Pipeline Configuration shows transformations; Templates page shows analysis scripts.

### Transform Scripts (`transforms/`) — write to database

| Template | File | Purpose | Output Type | Status |
|----------|------|---------|-------------|--------|
| DR6000 Transform | `transforms/dr6000-transform-v1.py` | Applies QR-1 (off-hours) and QR-2 (min point count), aggregates to path level. Writes clean paths to `audience_observations`, `audience_15min_agg`, `audience_day_agg`. | `multi` (table + text) | Seed |

### Analysis Scripts (`analyses/`) — read only, produce output envelopes

No active analysis scripts yet. Scripts are promoted here when they have an approved DB entry in `code_templates`.

#### Archived (`analyses/archive/`) — unvalidated, not in DB

These scripts have no `code_templates` DB rows and are not available to the agent at runtime. Kept for reference only. To activate one: test it in a session, then have the agent save it via `saveCodeTemplate` (which writes it to the DB and makes it available in future sessions).

| Template | File | Purpose |
|----------|------|---------|
| DR6000 Ghost Filter | `analyses/archive/dr6000-ghost-filter-v1.py` | Post-transform ghost path filtering |
| Quality Check — Sensor | `analyses/archive/quality-check-sensor-v1.py` | Pre-transform diagnostic (ghost rate, QR thresholds) |
| Path Aggregation | `analyses/archive/path-aggregation.py` | Raw sensor rows → one row per target_id |
| Path Trajectory Plot | `analyses/archive/path-trajectory-plot.py` | X/Y scatter with connected lines per target_id |
| Position Over Time | `analyses/archive/position-over-time.py` | Coordinate vs. time, colored by target_id |
| Summary Statistics | `analyses/archive/summary-statistics.py` | Sensor-level and path-level descriptive stats |
| Path Classification | `analyses/archive/path-classification-v1.py` | 3-way classification: ghost / passer-by / engaged |
| Engagement Metrics | `analyses/archive/engagement-metrics-v1.py` | Daily traffic, engagement rate, dwell distribution |

**Status definitions**:
- **Seed**: Included in the repository at deployment time. Not yet confirmed on live data.
- **Approved**: Confirmed working on at least one real session dataset. Stored in Supabase `code_templates` table.
- **Versioned**: Multiple versions exist (e.g., `ghost-classifier-v1`, `ghost-classifier-v2`). Use the highest approved version.

---

## Adding New Templates

When a new template is approved during a session (via `save-approved-template` skill):
1. The template is written to Supabase `code_templates` table immediately (runtime)
2. Always pass `template_type: 'analysis'` for analysis scripts; `template_type: 'transformation'` for pipeline scripts
3. The agent can use it in all future sessions via `getSessionContext`
4. To include it in the seed (available without a DB query), add the `.py` file to the appropriate subdirectory (`transforms/` or `analyses/`) and update this registry, then redeploy

---

## Template Rules

Every template in this directory must:
- Accept inputs via `{{PLACEHOLDER}}` tokens only — no hardcoded values specific to one session
- End with exactly one `print(json.dumps({...}))` producing a valid output envelope
- Load data from `/sandbox/upload.csv` (the E2B sandbox file path)
- Use `log_creation_time` for temporal operations
- Use `plotly` for all charts (not matplotlib)
- Include a docstring at the top explaining purpose, inputs, and outputs
