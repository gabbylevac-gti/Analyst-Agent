# Approved Beliefs — Seed File

This file contains beliefs that are pre-loaded into every deployment. They represent starting hypotheses based on domain knowledge, not yet confirmed by session analysis.

As sessions run and evidence accumulates, beliefs are updated in Supabase. This file is the **seed state** — deployed with the code, not modified at runtime. Supabase is the live append target.

To update this seed file, edit it here and redeploy the Mastra agent.

---

## How to Read This File

Each belief has:
- **ID**: Unique reference used in session summaries and evidence chains
- **Type**: Take-Away | Belief | False-Belief | Algorithm Version | Pending
- **Confidence**: 0.0–1.0 (see instructions.md for scale)
- **Content**: The claim
- **Evidence**: What supports it (session IDs added at runtime; seed beliefs cite source literature or first principles)
- **Tags**: For retrieval by `readKnowledge`

---

## Seed Beliefs

---

**ID**: `belief_ghost_dwell_threshold_seed`
**Type**: Pending
**Confidence**: 0.60
**Content**: Ghost paths in retail radar deployments have dwell times shorter than genuine human paths. A dwell threshold of 3–5 seconds is a reasonable starting point for the ghost filter. The exact threshold is deployment-specific and should be refined with session data.
**Evidence**: First principles (sensor physics) + domain literature on retail FMCW radar deployments.
**Tags**: ghost-detection, path-classification, dwell-time

---

**ID**: `belief_ghost_positional_variance_seed`
**Type**: Pending
**Confidence**: 0.65
**Content**: Ghost paths caused by multipath reflection or static clutter have near-zero positional variance — the "target" does not move. Genuine human paths show non-trivial movement even when stationary (micro-movements, weight shifts). A positional standard deviation threshold of 0.10–0.20m in both x and y is a reasonable ghost indicator.
**Evidence**: Radar physics (reflection artifacts are stationary by definition). Confidence is moderate because sensor noise can simulate small movement.
**Tags**: ghost-detection, path-classification, positional-variance

---

**ID**: `belief_fringe_detection_seed`
**Type**: Pending
**Confidence**: 0.55
**Content**: Short paths that appear at the edge of the detection zone (high y values, near maximum range) are disproportionately likely to be fringe artifacts rather than genuine paths. The sensor's detection reliability decreases at range extremes.
**Evidence**: First principles (radar SNR decreases with distance). Low confidence — needs empirical confirmation from session data.
**Tags**: ghost-detection, sensor-behavior, fringe

---

**ID**: `belief_path_aggregation_unit_seed`
**Type**: Belief
**Confidence**: 0.95
**Content**: The correct unit of analysis for engagement metrics is the path (grouped by target_id), not the individual position reading (row). Computing metrics on raw rows produces meaningless results. All analysis must begin with path aggregation.
**Evidence**: Definitional — a "path" is a single entity's presence event. Row-level analysis conflates path length with engagement signal.
**Tags**: data-model, path-aggregation, methodology

---

**ID**: `belief_log_creation_time_seed`
**Type**: Belief
**Confidence**: 0.95
**Content**: `log_creation_time` is the correct timestamp field for temporal analysis. `processed_at` reflects pipeline processing delay and should not be used for time-window filtering or dwell calculation.
**Evidence**: Data schema definition. `processed_at` is systematically later than `log_creation_time` by the pipeline processing latency.
**Tags**: data-model, timestamps, methodology

---

*Runtime-approved beliefs are stored in Supabase `knowledge_beliefs` table and loaded via `getSessionContext`. They do not appear in this file.*
