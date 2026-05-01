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

| Template | File | Purpose | Output Type | Status |
|----------|------|---------|-------------|--------|
| Path Aggregation | `path-aggregation.py` | Convert raw sensor rows → one row per target_id with dwell, position stats | `table` | Seed |
| Path Trajectory Plot | `path-trajectory-plot.py` | X/Y scatter with connected lines per target_id | `chart` | Seed |
| Position Over Time | `position-over-time.py` | X or Y coordinate vs. time, colored by target_id | `chart` | Seed |
| Summary Statistics | `summary-statistics.py` | Sensor-level and path-level descriptive stats | `multi` (table + text) | Seed |

**Status definitions**:
- **Seed**: Included in the repository at deployment time. Not yet confirmed on live data.
- **Approved**: Confirmed working on at least one real session dataset. Stored in Supabase `code_templates` table.
- **Versioned**: Multiple versions exist (e.g., `ghost-classifier-v1`, `ghost-classifier-v2`). Use the highest approved version.

---

## Adding New Templates

When a new template is approved during a session (via `save-approved-template` skill):
1. The template is written to Supabase `code_templates` table immediately (runtime)
2. The agent can use it in all future sessions via `getSessionContext`
3. To include it in the seed (available without a DB query), add the `.py` file to this directory and update this registry, then redeploy

---

## Template Rules

Every template in this directory must:
- Accept inputs via `{{PLACEHOLDER}}` tokens only — no hardcoded values specific to one session
- End with exactly one `print(json.dumps({...}))` producing a valid output envelope
- Load data from `/sandbox/upload.csv` (the E2B sandbox file path)
- Use `log_creation_time` for temporal operations
- Use `plotly` for all charts (not matplotlib)
- Include a docstring at the top explaining purpose, inputs, and outputs
