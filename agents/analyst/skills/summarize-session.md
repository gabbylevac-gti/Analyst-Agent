# Skill: Summarize Session

## Purpose

When a session closes (user opens a new chat, explicitly wraps up, or is inactive for an extended period), distill the session into a structured summary that future sessions can load and act on. This is the mechanism that makes the system compound — a session without a summary teaches nothing.

---

## When to Use

Trigger this skill when:
- The user clicks "New Chat" (the frontend signals this to the agent)
- The user says "I'm done for now," "let's wrap up," "save our work," or similar
- The user explicitly asks for a session summary

Trigger automatically if the user has been inactive for more than 30 minutes — produce the summary in the background so it's ready when they return.

---

## What a Good Summary Contains

A session summary is **not** a transcript. It is a factual record of what happened — what data was loaded, what questions were asked, and what was found. It does not direct future sessions.

Aim for 150–300 words. Write only facts. Do not use directives like "MUST", "immediately", "before any analysis", "the next session should". Future sessions set their own direction.

### Required sections:

**Dataset**
Filename or source, row count, time window, sensor(s) in scope, `rawUploadId` if available.

**What Was Analyzed**
The specific questions asked this session and what tools were called. List as 3–5 bullet points — one per question or analysis thread.

**Take-Aways**
The 3–5 most important findings produced. Each includes:
- The observation (specific, with numbers)
- Whether it confirmed, contradicted, or extended an existing belief
- Confidence level

**Decisions Made**
Any threshold decisions, classification rules, or analytical choices the user accepted. Future sessions should not re-litigate these unless the user explicitly revisits them.

**Approved Beliefs (this session)**
List of belief IDs or names approved and written to Supabase during this session.

**Approved Templates (this session)**
List of template names saved during this session.

---

## Procedure

### Step 1: Collect session data

Review the current session's messages and artifact history. Identify:
- The opening objective the user stated
- All artifacts produced (titles and summaries from their envelopes)
- The discussions that followed each artifact
- Beliefs and templates approved during the session
- The last question or topic before the session ended

### Step 2: Draft the summary

Write the summary in the structure above. Be specific — reference actual values, actual template names, actual belief IDs. Vague summaries ("we looked at the data") compound nothing.

**Example session summary:**
> **Dataset**: CT1-Dyson-Path-May1.csv | 2,847 rows | April 6–10, 2026 | sensor radar-001 | rawUploadId: `abc123`
>
> **What Was Analyzed**:
> - Ghost rate and path classification (dwell + positional variance)
> - Spatial clustering of ghost vs. engaged paths
> - Dwell time distribution for engaged paths
>
> **Take-Aways**:
> 1. 61% of paths have dwell < 3s — consistent with ghost hypothesis. These cluster at x ≈ -1.0, y ≈ 1.9 (sensor fringe). Confidence: 0.78.
> 2. 4 paths show clear cross-display movement (x range −1.1 to 0.9m). Dwell 22–47s. Confirmed engaged.
> 3. positional_std < 0.15m separates stationary from mobile detections in this dataset.
>
> **Decisions Made**: 3-second dwell threshold accepted as the primary ghost filter.
>
> **Approved Beliefs**: `belief_ghost_dwell_threshold_v1` (confidence 0.78)
>
> **Approved Templates**: `path-aggregation-v1`, `path-trajectory-plot-v1`

### Step 3: Write to Supabase

Call `writeBelief` with `type: "session_summary"` and the structured summary text, tagged with the session ID. This writes to the `session_summaries` table (not `knowledge_beliefs`).

### Step 4: Confirm to the user

If the user is still present:
> "Session saved. I've recorded what we analyzed and the take-aways — next session will have full context on what we found today."

If the session ended without the user explicitly wrapping up (background summarization), no confirmation needed.

---

## Notes

- Session summaries are the primary mechanism for cross-session continuity. A missing summary means the next session starts cold.
- The `getSessionContext` tool loads the 3 most recent session summaries. After that, older sessions are still queryable but not auto-loaded.
- Summaries should be written in the agent's voice, not the user's — they are read by the agent, not the user.
