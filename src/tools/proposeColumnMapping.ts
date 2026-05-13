/**
 * Tool: proposeColumnMapping
 *
 * Compares CSV column headers against approved data dictionaries for this org.
 * Uses fuzzy matching (exact > substring > Levenshtein) to propose the best
 * dictionary column for each CSV header, with confidence and alternatives.
 *
 * Called by the agent immediately after a CSV upload is detected, before
 * executeTransform. The agent emits the result as a csv_mapping artifact and
 * waits for [Mapping confirmed] before proceeding.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );
}

// ─── Levenshtein distance (edit distance) ────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type Confidence = "high" | "medium" | "low" | "none";

function scoreMatch(csvCol: string, dictCol: string, displayName: string): number {
  const csv = normalize(csvCol);
  const col = normalize(dictCol);
  const disp = normalize(displayName ?? "");

  // Exact match
  if (csv === col || csv === disp) return 100;

  // Substring containment
  if (col.includes(csv) || csv.includes(col)) return 75;
  if (disp.includes(csv) || csv.includes(disp)) return 65;

  // Levenshtein similarity (normalised 0–50)
  const maxLen = Math.max(csv.length, col.length, 1);
  const editSim = Math.max(0, 1 - levenshtein(csv, col) / maxLen);
  const dispSim = Math.max(0, 1 - levenshtein(csv, disp) / Math.max(csv.length, disp.length, 1));

  return Math.round(Math.max(editSim, dispSim) * 50);
}

function toConfidence(score: number): Confidence {
  if (score >= 90) return "high";
  if (score >= 60) return "medium";
  if (score >= 30) return "low";
  return "none";
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const proposeColumnMappingTool = createTool({
  id: "propose-column-mapping",
  description:
    "Compare CSV column headers against approved data dictionaries for this org. " +
    "Returns a mapping proposal per column (best match + confidence + alternatives). " +
    "Call this immediately after a CSV upload is detected. " +
    "Emit the result as a csv_mapping artifact. " +
    "CRITICAL: After emitting the artifact, send ZERO text. The mapping card UI handles all user interaction. " +
    "NEVER narrate the mappings, generate a markdown table, describe what was found, summarize the dictionary match, " +
    "or produce a pre-written [Mapping confirmed: ...] message for the user to copy-paste. " +
    "The card is self-explanatory. Wait silently for [Mapping confirmed: <json>] or [Mapping rejected].",
  inputSchema: z.object({
    orgId: z.string().describe("Organization ID"),
    csvColumns: z
      .array(z.string())
      .describe("Column headers from the uploaded CSV file"),
  }),
  outputSchema: z.object({
    dictionaryId: z.string().nullable(),
    dictionaryName: z.string().nullable(),
    integrationHint: z.string().nullable().describe("Best-guess integration type based on column overlap"),
    mappings: z.array(
      z.object({
        csvColumn: z.string(),
        proposedMatch: z.string().nullable(),
        confidence: z.enum(["high", "medium", "low", "none"]),
        alternatives: z.array(z.string()),
      })
    ),
  }),
  execute: async (context) => {
    const { orgId, csvColumns } = context;
    const supabase = getSupabase();

    // Load approved datasets (data dictionaries) for this org
    const { data: datasets } = await supabase
      .from("datasets")
      .select("id, filename, data_dictionary_json, integration_type")
      .eq("org_id", orgId)
      .eq("approval_status", "approved")
      .not("data_dictionary_json", "is", null)
      .order("created_at", { ascending: false })
      .limit(10);

    if (!datasets || datasets.length === 0) {
      // No approved dictionaries — return none-confidence mappings
      return {
        dictionaryId: null,
        dictionaryName: null,
        integrationHint: null,
        mappings: csvColumns.map((col) => ({
          csvColumn: col,
          proposedMatch: null,
          confidence: "none" as Confidence,
          alternatives: [],
        })),
      };
    }

    // Score each dataset against the full set of CSV columns to find best overall match
    type DictEntry = { column: string; display_name?: string };

    const datasetScores = datasets.map((ds) => {
      const dict = (ds.data_dictionary_json as DictEntry[] | null) ?? [];
      const totalScore = csvColumns.reduce((sum, col) => {
        const best = dict.reduce(
          (max, entry) => Math.max(max, scoreMatch(col, entry.column, entry.display_name ?? "")),
          0
        );
        return sum + best;
      }, 0);
      return { ds, dict, totalScore };
    });

    // Pick the best-matching dictionary
    datasetScores.sort((a, b) => b.totalScore - a.totalScore);
    const { ds: bestDs, dict: bestDict } = datasetScores[0];

    // Build per-column mapping proposals
    const dictColumns = bestDict.map((e) => e.column);

    const mappings = csvColumns.map((csvCol) => {
      const scored = bestDict
        .map((entry) => ({
          column: entry.column,
          score: scoreMatch(csvCol, entry.column, entry.display_name ?? ""),
        }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      const confidence = best ? toConfidence(best.score) : "none";
      const proposedMatch = confidence !== "none" ? best.column : null;
      const alternatives = scored
        .slice(1, 4)
        .filter((s) => s.score >= 30)
        .map((s) => s.column);

      return { csvColumn: csvCol, proposedMatch, confidence, alternatives };
    });

    // Derive integration hint from best dataset's integration_type or filename
    const integrationHint =
      (bestDs.integration_type as string | null) ??
      (bestDs.filename?.split(".")[0] ?? null);

    return {
      dictionaryId: bestDs.id as string,
      dictionaryName: bestDs.filename as string,
      integrationHint,
      mappings,
    };
  },
});
