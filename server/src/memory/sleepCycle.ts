// Sleep cycle — replay-based consolidation that produces SEMANTIC memory.
//
// Everything the pipeline learns is episodic: flat Q+A chunks, time-indexed,
// never abstracted. Real brains replay the day's episodes during sleep and
// distill them into semantic knowledge (gist) — you remember THAT Paris is in
// France, not when you learned it. This module is that pass:
//
//   1. decay Hebbian associations (use it or lose it — memory/hebbian.ts);
//   2. gather recent un-distilled conversation episodes;
//   3. group related episodes (pure greedy token-overlap clustering);
//   4. LLM-distill each group into a few durable FACT memories;
//   5. persist the facts (sourceType "manual" + metadata.kind "semantic" —
//      the perceptionMemory pattern, since source_type carries a CHECK),
//      embedded best-effort so they join the vector index;
//   6. link provenance (fact —distilled-from→ each source episode) and
//      DEMOTE (never delete) the episodes — retrieval now prefers the cheap
//      semantic layer, episodes survive for when detail is needed.
//
// The existing consolidationEngine handles importance decay + low-importance
// gist compression; this is the complementary path for memories worth KEEPING.
//
// Hermetic by construction: the connector + embedder are injectable, grouping
// is pure, and a missing connector degrades to "skipped" with a reason. The
// nightly schedule lives in index.ts behind CONFIG.sleepCycle; POST
// /api/brain/sleep triggers one cycle manually (the runtime check).

import { createHash } from "node:crypto";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { getDefaultConnectorInstance, listConnectorInstances } from "../connectors/registry.js";
import type { Connector } from "../connectors/Connector.js";
import { insertRelation, upsertMemoryPoint } from "../db/repositories/memory.js";
import { updateMemoryImportance } from "./memoryLifecycle.js";
import { decayAssociations } from "./hebbian.js";
import { tokens } from "../attention/saliency.js";
import { CONFIG } from "../config.js";

export interface EpisodeForSleep {
  id: string;
  content: string;
  projectName: string | null;
  importance: number;
}

export interface SleepReport {
  scanned: number;
  groups: number;
  distilled: number;
  demoted: number;
  hebbian: { decayed: number; pruned: number };
  reason?: string;
}

// Episodes considered per cycle (newest first) and grouping bounds.
export const SLEEP_SCAN_LIMIT = 40;
export const RECENT_DAYS = 14;
export const MIN_GROUP = 3;
export const MAX_GROUP = 8;
export const MAX_GROUPS_PER_CYCLE = 3;
export const GROUP_SIM_FLOOR = 0.18;
// Demotion: episodes lose this fraction of importance once distilled.
export const DEMOTE_FACTOR = 0.85;
// A distilled fact starts above the episodes it summarises.
export const FACT_IMPORTANCE = 0.75;

const DISTILL_SYSTEM = `You are a memory consolidator. You receive several related conversation episodes from a personal knowledge brain. Distill them into 1-3 durable FACTS the brain should remember long-term.
Rules: output ONLY a JSON object {"facts": ["...", "..."]}. Each fact is one self-contained sentence (max 40 words) stating something true and reusable. No meta-commentary, no dates unless essential, no first person.`;

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// -----------------------------------------------------------------------------
// PURE grouping — greedy single-pass clustering by token overlap.
// -----------------------------------------------------------------------------

export function groupEpisodes(
  episodes: ReadonlyArray<EpisodeForSleep>,
  opts: { minGroup?: number; maxGroup?: number; maxGroups?: number; simFloor?: number } = {},
): EpisodeForSleep[][] {
  const minGroup = opts.minGroup ?? MIN_GROUP;
  const maxGroup = opts.maxGroup ?? MAX_GROUP;
  const maxGroups = opts.maxGroups ?? MAX_GROUPS_PER_CYCLE;
  const simFloor = opts.simFloor ?? GROUP_SIM_FLOOR;

  const tokenSets = episodes.map((e) => new Set(tokens(e.content)));
  const assigned = new Set<number>();
  const groups: EpisodeForSleep[][] = [];

  for (let i = 0; i < episodes.length; i += 1) {
    if (assigned.has(i)) continue;
    const members = [i];
    for (let j = i + 1; j < episodes.length && members.length < maxGroup; j += 1) {
      if (assigned.has(j)) continue;
      if (jaccard(tokenSets[i], tokenSets[j]) >= simFloor) {
        members.push(j);
      }
    }
    if (members.length >= minGroup) {
      for (const m of members) assigned.add(m);
      groups.push(members.map((m) => episodes[m]));
      if (groups.length >= maxGroups) break;
    }
  }
  return groups;
}

/** Extract the facts array from the distiller's (possibly messy) JSON. Pure. */
export function parseFacts(text: string): string[] {
  try {
    const direct = JSON.parse(text) as { facts?: unknown };
    if (Array.isArray(direct.facts)) {
      return direct.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 3);
    }
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { facts?: unknown };
        if (Array.isArray(parsed.facts)) {
          return parsed.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 3);
        }
      } catch {
        return [];
      }
    }
  }
  return [];
}

// -----------------------------------------------------------------------------
// DB + orchestration.
// -----------------------------------------------------------------------------

/** Recent conversation episodes that no semantic fact has been distilled from yet. */
export function gatherEpisodes(limit = SLEEP_SCAN_LIMIT): EpisodeForSleep[] {
  try {
    const rows = openDb()
      .prepare<[string, number], { id: string; content: string; project_name: string | null; importance: number }>(
        `SELECT mp.id, mp.content, mp.project_name, mp.importance
         FROM memory_points mp
         WHERE mp.source_type = 'conversation'
           AND mp.importance >= 0.25
           AND datetime(mp.created_at) >= datetime('now', ?)
           AND NOT EXISTS (
             SELECT 1 FROM memory_relations r
             WHERE r.kind = 'distilled-from' AND r.to_id = mp.id
           )
         ORDER BY mp.created_at DESC LIMIT ?`,
      )
      .all(`-${RECENT_DAYS} days`, limit);
    return rows.map((r) => ({ id: r.id, content: r.content, projectName: r.project_name, importance: r.importance }));
  } catch (err) {
    surfaceError("sleepCycle.gatherEpisodes", err);
    return [];
  }
}

function defaultEmbedder(): ((text: string) => Promise<number[]>) | undefined {
  const active = getDefaultConnectorInstance();
  if (active?.embed) return active.embed.bind(active);
  const ollama = listConnectorInstances().find(
    (c) => c.descriptor.kind === "ollama" && c.descriptor.enabled && c.descriptor.state === "ok" && Boolean(c.embed),
  );
  return ollama?.embed ? ollama.embed.bind(ollama) : undefined;
}

export interface SleepOptions {
  /** Injectable for the hermetic selfcheck. Defaults to the registry default. */
  connector?: Connector | null;
  embed?: (text: string) => Promise<number[]>;
}

/**
 * One full sleep cycle. Never throws — every failure surfaces in the report.
 */
export async function runSleepCycle(opts: SleepOptions = {}): Promise<SleepReport> {
  const hebbian = decayAssociations();
  const episodes = gatherEpisodes();
  const report: SleepReport = { scanned: episodes.length, groups: 0, distilled: 0, demoted: 0, hebbian };

  const groups = groupEpisodes(episodes);
  report.groups = groups.length;
  if (groups.length === 0) {
    report.reason = episodes.length === 0 ? "no un-distilled recent episodes" : "no related-episode groups found";
    return report;
  }

  const connector = opts.connector !== undefined ? opts.connector : getDefaultConnectorInstance();
  if (!connector) {
    report.reason = "no connector — distillation skipped (episodes remain for the next cycle)";
    return report;
  }
  const embed = opts.embed ?? defaultEmbedder();

  for (const group of groups) {
    try {
      const body = group
        .map((e, i) => `Episode ${i + 1}:\n${e.content.slice(0, 800)}`)
        .join("\n\n");
      const raw = await connector.send(body, { system: DISTILL_SYSTEM, format: "json", temperature: 0.2 });
      const facts = parseFacts(raw);
      if (facts.length === 0) continue;

      for (const fact of facts) {
        let embedding: number[] | undefined;
        if (embed) {
          try {
            const v = await embed(fact);
            if (v.length === CONFIG.embeddingDim) embedding = v;
          } catch {
            // best-effort — a fact without a vector still keyword-matches
          }
        }
        const factMemory = upsertMemoryPoint({
          sourceType: "manual",
          projectName: group[0].projectName,
          title: fact.slice(0, 80),
          content: fact,
          contentHash: createHash("sha1").update(fact).digest("hex"),
          importance: FACT_IMPORTANCE,
          embedding,
          metadata: { kind: "semantic", source: "sleep-cycle", distilledFrom: group.map((e) => e.id) },
        });
        for (const episode of group) {
          try {
            insertRelation(factMemory.id, episode.id, "distilled-from", 1);
          } catch {
            // relation failures never block the cycle
          }
        }
        report.distilled += 1;
      }
      // Demote (never delete): the semantic layer now answers first; the
      // episodes keep their detail at reduced retrieval priority.
      for (const episode of group) {
        try {
          updateMemoryImportance(episode.id, Math.max(0.05, episode.importance * DEMOTE_FACTOR));
          report.demoted += 1;
        } catch (err) {
          surfaceError("sleepCycle.demote", err);
        }
      }
    } catch (err) {
      surfaceError("sleepCycle.distillGroup", err);
    }
  }
  return report;
}
