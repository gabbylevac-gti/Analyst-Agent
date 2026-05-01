# Domain Knowledge: Path Classification

## Overview

A "path" is one continuous detection sequence for a single `target_id` — from when the radar first detects the entity to when it exits the detection zone. The goal of path classification is to label each path as one of three categories:

| Category | Definition |
|----------|-----------|
| **Engaged** | A person who stopped, lingered, and likely interacted with the product or display |
| **Passer-by** | A person who walked through the detection zone without stopping |
| **Ghost** | A sensor artifact — not a real person |

---

## Working Definitions

### Engaged

A path is likely **engaged** when:
- `dwell_seconds` is long relative to the detection zone size (the threshold is deployment-specific — typically > 15–30 seconds for a 3m deep zone)
- Positional variance is moderate: the person moved around within a bounded area (they were browsing, not just standing still or walking through)
- The position cluster is spatially consistent with where the product or interaction point is located
- The path has many data points (dense sampling throughout, no long gaps)

Engaged paths are the primary signal of commercial interest. They are what the client wants to maximize.

### Passer-by

A path is likely a **passer-by** when:
- `dwell_seconds` is short-to-moderate (3–15 seconds for a typical zone)
- The path shows directional movement: x or y changes consistently in one direction (they walked through)
- Position starts at one edge of the detection zone and ends at the other
- The path has moderate data point density

Passer-bys are people who were present but not engaged. They represent potential audience who did not stop.

### Ghost

A path is likely a **ghost** when:
- `dwell_seconds` is very short (< 3–5 seconds — threshold under development)
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
| `dwell_seconds` | `max(log_creation_time) - min(log_creation_time)` | Primary ghost filter; primary engagement signal |
| `point_count` | Row count per `target_id` | Proxy for data quality; low count = unreliable path |
| `pos_std_x` | `std(x_m)` per target | Low = stationary (ghost or standing still) |
| `pos_std_y` | `std(y_m)` per target | Low = stationary |
| `pos_range_x` | `max(x_m) - min(x_m)` | High = lateral movement (browsing vs pass-through) |
| `pos_range_y` | `max(y_m) - min(y_m)` | High = walked through zone (passer-by signature) |
| `centroid_x` | `mean(x_m)` | Spatial location of activity |
| `centroid_y` | `mean(y_m)` | Spatial location of activity |
| `start_hour` | Hour of `min(log_creation_time)` | Time-of-day signal for ghost likelihood |
| `is_fringe` | Whether centroid is near detection zone edge | Ghost indicator |

---

## Algorithm Development Status

The classification algorithm is a work in progress. See `knowledge/beliefs/approved-takeaways.md` for the current approved thresholds and the session history that produced them.

The goal is a Python function with the following signature:

```python
def classify_path(path_row: dict) -> str:
    """
    Returns 'ghost', 'passer-by', or 'engaged' for a single path-level row.
    Input is a dict with path-level features (dwell_seconds, pos_std_x, pos_std_y, etc.)
    """
    ...
```

This function, once approved, should be saved as a code template and referenced by name in all future sessions.

---

## Evaluation Framework

When testing a classifier version, report:
- **Precision**: Of paths labeled Ghost, what % are actually ghosts? (False positives = real paths mislabeled as ghosts)
- **Recall**: Of actual ghosts, what % did the classifier catch? (False negatives = ghosts mislabeled as real)
- **Ground truth method**: Since we have no labeled data, ground truth is currently established by visual inspection of path trajectories — the user manually reviews borderline cases and labels them

As labeled examples accumulate across sessions, a more rigorous evaluation becomes possible.
