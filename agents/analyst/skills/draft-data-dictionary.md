# Skill: Draft Data Dictionary

## Purpose

When a user uploads a CSV, analyze its structure and produce a human-readable data dictionary for the user to review, edit, and approve. The approved dictionary becomes the semantic foundation for all analysis in the session — and is persisted to Supabase so future sessions with the same schema skip this step.

---

## When to Use

- Immediately after a CSV is uploaded, before any analysis begins
- When the user uploads a second CSV with a different schema mid-session
- When the user says "I uploaded a new file" or similar

Do not proceed to analysis without an approved dictionary. If the user skips approval and asks an analytical question, remind them: "Before I analyze, let me confirm the data dictionary so I understand what each field means."

---

## Procedure

### Step 1: Inspect the schema

Call `executeCode` with a lightweight schema inspection script:

```python
import pandas as pd
import json

df = pd.read_csv('/sandbox/upload.csv')

schema = {
    "row_count": len(df),
    "column_count": len(df.columns),
    "columns": []
}

for col in df.columns:
    col_info = {
        "name": col,
        "dtype": str(df[col].dtype),
        "null_count": int(df[col].isna().sum()),
        "sample_values": df[col].dropna().head(5).tolist(),
        "unique_count": int(df[col].nunique())
    }
    if df[col].dtype in ['float64', 'int64']:
        col_info["min"] = float(df[col].min())
        col_info["max"] = float(df[col].max())
        col_info["mean"] = float(df[col].mean())
    schema["columns"].append(col_info)

print(json.dumps({"type": "text", "title": "Schema Inspection", "data": schema, "summary": f"{schema['row_count']} rows, {schema['column_count']} columns"}))
```

### Step 2: Check for a prior dictionary

Call `getSessionContext` with the column names as a signature. If a prior approved dictionary for this schema exists in Supabase, load it and present it to the user for confirmation rather than drafting from scratch: "I recognize this data format from a previous session. Here's the dictionary we approved — does it still apply?"

### Step 3: Draft definitions

For each column, produce:
- **display_name**: Human-readable name
- **description**: What the field represents in plain language
- **data_type**: The semantic type (timestamp, identifier, measurement, categorical, coordinate)
- **units**: If a measurement (e.g., meters, seconds, UTC offset)
- **notes**: Any observations about data quality, range anomalies, or deployment context

Draw on your domain knowledge when drafting. For radar sensor data specifically:
- `target_id` — a UUID assigned to a single tracked entity (person) for the duration of their detectable presence in the sensor field. Not persistent across sessions.
- `x_m`, `y_m` — position in meters relative to the sensor's origin. The coordinate system is sensor-specific. Ask the user to confirm orientation if not previously established.
- `log_creation_time` — the timestamp of the position reading. Use this (not `processed_at`) for time-based analysis.
- `sensor_id`, `sensor_name` — identify which physical device generated the reading. Multiple sensors may appear in one file.

### Step 4: Add session context fields

Append a **Deployment Context** section to the dictionary — not column definitions, but answers to:
- What physical location is this sensor monitoring?
- What is the orientation of the coordinate system? (Where is the entrance? What is at y=0?)
- What is the business objective for this dataset?
- Are there known data quality issues or calibration notes?

Pre-fill from session summaries if available. Otherwise, ask the user directly.

### Step 5: Surface for approval

Present the full dictionary as a structured table (using the `table` output type). Include an explicit prompt:

"Please review this dictionary. Edit any definitions that are inaccurate, fill in the deployment context fields, and let me know when it's approved. I won't begin analysis until you confirm."

### Step 6: Persist on approval

When the user approves (explicitly or by saying "looks good" / "proceed"), call `getSessionContext` to check if this schema already has an entry in Supabase, then write the approved dictionary to the `datasets` table. Confirm: "Dictionary saved. Starting from this in future sessions."

---

## Output Format

The drafted dictionary should be surfaced as a `table` artifact with columns: Field, Type, Description, Units, Notes.

The Deployment Context section follows below the table as a `text` artifact.

---

## Notes

- Do not ask the user to define fields you already know from domain knowledge. Fill them in and let the user correct rather than interviewing.
- If `x_m` and `y_m` values are all negative in one axis, note that the coordinate origin may be at a corner of the detection zone rather than the center — worth flagging for the user to confirm.
- `processed_at` vs `log_creation_time`: these differ by the processing pipeline delay. Always use `log_creation_time` for temporal analysis.
