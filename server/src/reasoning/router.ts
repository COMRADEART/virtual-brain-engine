// Mixture-of-Experts query router for the reasoning pipeline.
//
// Two real capabilities (NOT a placeholder that always returns one region):
//
//  (1) Expert selection — score all 8 logical cortices for a query and pick the
//      top-k. A per-region weighted keyword lexicon gives a hermetic,
//      deterministic lexical core; when a query embedding AND per-region
//      prototype embeddings are available, each region's score is blended with
//      cosine similarity to its prototype (semantic refinement).
//
//  (2) Adaptive compute — estimate query difficulty in [0,1] from structure
//      (reasoning-trigger words, length, multi-clause joiners, how many strong
//      regions it touches) and gate the pipeline's depth. A "shallow" route
//      lets the caller skip the expensive LLM reasoning step entirely.
//
// Pure + dependency-free except for the shared LogicalRegionId contract. The
// prototype embeddings are built lazily on first use and cached at module
// scope so the (optional) embedder is hit once per region, ever.

import {
  LOGICAL_REGION_IDS,
  type LogicalRegionId,
} from "../../../shared/pipeline.js";

// Re-export so callers (and the selfcheck) can name the region type without
// reaching back into shared/pipeline.
export type { LogicalRegionId };

export type RouteDepth = "shallow" | "full";

export interface RegionScore {
  region: LogicalRegionId;
  score: number;
}

export interface RouteDecision {
  experts: LogicalRegionId[]; // top-k regions, score-desc, length >= 1
  scores: RegionScore[]; // all 8, score-desc
  difficulty: number; // [0,1]
  depth: RouteDepth;
  usedEmbedding: boolean;
}

export const ROUTER_TOP_K = 2;
export const DEPTH_DIFFICULTY_THRESHOLD = 0.45;

// A normalized region score at/above this counts as a "strong" region for the
// difficulty heuristic (touching >= 3 strong regions nudges difficulty up). Set
// well above the catch-all baseline so the default never registers as strong.
const STRONG_REGION_THRESHOLD = 0.5;

// Catch-all baseline: reasoning-cortex always carries a tiny constant so that
// when NOTHING matches the lexicon it wins argmax (never returns empty
// experts), yet any real keyword hit easily out-scores it.
const DEFAULT_REGION: LogicalRegionId = "reasoning-cortex";
const DEFAULT_BASELINE = 0.01;

// -----------------------------------------------------------------------------
// Per-region weighted keyword lexicon.
//
// Tuned so the TOP expert matches the brief's routing cases. Weights are raw
// (summed, then divide-by-max normalized — see scoreRegions). Keep the
// reasoning-*trigger* words (how/why/explain/...) OUT of reasoning-cortex: they
// drive the difficulty estimate, not routing, and would steal cases that
// legitimately contain them (e.g. "...how the ranker is learning").
// -----------------------------------------------------------------------------
const REGION_LEXICON: Record<LogicalRegionId, Record<string, number>> = {
  "memory-core": {
    remember: 3,
    remembered: 3,
    recall: 3,
    memory: 2.5,
    memories: 2.5,
    forgot: 2,
    forget: 2,
    earlier: 1.2,
    previously: 1.5,
    recollect: 2.5,
    stored: 1.2,
    note: 0.8,
  },
  "reasoning-cortex": {
    reason: 1.5,
    reasoning: 1.5,
    plan: 1.5,
    strategy: 1.2,
    logic: 1.2,
    think: 1,
    approach: 1,
    conclude: 1.2,
    inference: 1.2,
    deduce: 1.2,
  },
  "project-cortex": {
    project: 3,
    repo: 3,
    repository: 3,
    codebase: 2,
    branch: 1.5,
    star: 1.2,
    milestone: 1.2,
    roadmap: 1.2,
    sprint: 1.2,
    backlog: 1.2,
  },
  "file-memory": {
    file: 3,
    files: 3,
    directory: 2,
    folder: 2,
    path: 2,
    filename: 2.5,
    line: 1.2,
    defined: 1.8,
    definition: 1.5,
    function: 1.5,
    module: 1.2,
    source: 1.2,
    located: 1.5,
    grep: 2,
  },
  "model-hub": {
    model: 2.5,
    models: 2.5,
    ollama: 3,
    embedding: 2.5,
    embeddings: 2.5,
    connector: 2.5,
    llm: 2.5,
    inference: 1.5,
    gpu: 1.5,
    temperature: 1.2,
    runtime: 1.5,
  },
  "response-center": {
    draft: 3,
    reply: 3,
    write: 2,
    compose: 2.5,
    respond: 2.5,
    response: 2,
    answer: 1.5,
    email: 2.5,
    message: 1.8,
    rephrase: 2,
    summarize: 1.5,
  },
  "error-detection-center": {
    contradictory: 3.5,
    contradiction: 3.5,
    contradict: 3.5,
    inconsistent: 3,
    inconsistency: 3,
    conflict: 2.5,
    conflicting: 2.5,
    wrong: 2,
    error: 2.5,
    mistake: 2,
    bug: 2,
    invalid: 1.8,
  },
  "learning-feedback-center": {
    feedback: 3.5,
    learning: 3,
    learn: 2.5,
    learned: 2.5,
    ranker: 3,
    train: 2.5,
    training: 2.5,
    improve: 1.5,
    rating: 2,
    reward: 1.5,
    teach: 1.8,
  },
};

// Words that signal a query needs real multi-step reasoning. Drive difficulty
// only — deliberately NOT in any region lexicon.
const REASONING_TRIGGERS = new Set([
  "why",
  "how",
  "explain",
  "compare",
  "analyze",
  "design",
  "debug",
  "refactor",
  "evaluate",
  "optimize",
  "across",
  "trade-off",
  "tradeoff",
  "versus",
  "vs",
  "integrate",
  "architecture",
]);

// Multi-clause joiners — their presence suggests a compound request.
const CLAUSE_JOINERS = new Set(["and", "or", "then", "because"]);

// Lookup-style lead-ins that mark an easy factual question (when no reasoning
// trigger is also present, these shrink difficulty).
const LOOKUP_PHRASES = [
  "what is",
  "who is",
  "when",
  "where is",
  "define",
  "list",
  "show me",
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

// Cosine similarity that is safe on zero / mismatched-length vectors (→ 0).
export function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Raw lexical score per region: sum of matched keyword weights (a keyword can
// match multiple query tokens; each occurrence counts).
function rawLexicalScores(tokenList: string[]): Record<LogicalRegionId, number> {
  const raw: Record<LogicalRegionId, number> = {} as Record<LogicalRegionId, number>;
  for (const region of LOGICAL_REGION_IDS) {
    let sum = 0;
    const lex = REGION_LEXICON[region];
    for (const tok of tokenList) {
      const w = lex[tok];
      if (w !== undefined) {
        sum += w;
      }
    }
    raw[region] = sum;
  }
  // Catch-all baseline so the default wins when nothing matched.
  raw[DEFAULT_REGION] += DEFAULT_BASELINE;
  return raw;
}

function estimateDifficulty(query: string, tokenList: string[], strongCount: number): number {
  const lower = query.toLowerCase();
  const hasReasoningTrigger = tokenList.some((t) => REASONING_TRIGGERS.has(t));

  let difficulty = 0;
  if (hasReasoningTrigger) {
    difficulty += 0.4;
  }
  // Length: +up to 0.2 scaled by tokens / 14.
  difficulty += Math.min(0.2, (tokenList.length / 14) * 0.2);
  // Multi-clause joiners: word joiners OR punctuation joiners (; ,).
  const hasJoiner =
    tokenList.some((t) => CLAUSE_JOINERS.has(t)) || /[;,]/.test(query);
  if (hasJoiner) {
    difficulty += 0.2;
  }
  // Touching >= 3 strong regions.
  if (strongCount >= 3) {
    difficulty += 0.1;
  }

  // Easy lookup queries (no reasoning trigger) get heavily discounted.
  if (!hasReasoningTrigger && LOOKUP_PHRASES.some((p) => lower.includes(p))) {
    difficulty *= 0.4;
  }

  return Math.min(1, Math.max(0, difficulty));
}

export function routeQuery(
  query: string,
  opts?: {
    queryEmbedding?: number[];
    regionPrototypes?: Partial<Record<LogicalRegionId, number[]>>;
  },
): RouteDecision {
  const tokenList = tokenize(query);
  const raw = rawLexicalScores(tokenList);

  // Normalize the lexical component by divide-by-max so the winner → 1.0 and
  // strict ordering is preserved (argmax is invariant). A saturating clamp
  // would collapse two strong regions to a tie.
  let maxRaw = 0;
  for (const region of LOGICAL_REGION_IDS) {
    if (raw[region] > maxRaw) {
      maxRaw = raw[region];
    }
  }
  const lexNorm: Record<LogicalRegionId, number> = {} as Record<LogicalRegionId, number>;
  for (const region of LOGICAL_REGION_IDS) {
    lexNorm[region] = maxRaw > 0 ? raw[region] / maxRaw : 0;
  }

  // Optional embedding refinement: blend cosine(query, prototype) with the
  // normalized lexical score. Both terms are already in [0,1], so the blend is
  // too — no re-normalization afterward.
  const queryEmbedding = opts?.queryEmbedding;
  const protos = opts?.regionPrototypes;
  let usedEmbedding = false;
  const finalScore: Record<LogicalRegionId, number> = {} as Record<LogicalRegionId, number>;
  for (const region of LOGICAL_REGION_IDS) {
    const proto = protos?.[region];
    if (queryEmbedding && proto && proto.length > 0) {
      const cos = cosineSim(queryEmbedding, proto);
      finalScore[region] = 0.5 * ((cos + 1) / 2) + 0.5 * lexNorm[region];
      usedEmbedding = true;
    } else {
      finalScore[region] = lexNorm[region];
    }
  }

  const scores: RegionScore[] = LOGICAL_REGION_IDS.map((region) => ({
    region,
    score: finalScore[region],
  })).sort((a, b) => b.score - a.score);

  let experts = scores.slice(0, ROUTER_TOP_K).map((s) => s.region);
  if (experts.length === 0) {
    experts = [DEFAULT_REGION];
  }

  const strongCount = scores.filter((s) => s.score >= STRONG_REGION_THRESHOLD).length;
  const difficulty = estimateDifficulty(query, tokenList, strongCount);
  const depth: RouteDepth = difficulty >= DEPTH_DIFFICULTY_THRESHOLD ? "full" : "shallow";

  return { experts, scores, difficulty, depth, usedEmbedding };
}

// -----------------------------------------------------------------------------
// Lazy prototype-embedding cache. Each region's description string is embedded
// ONCE (on first call) and reused thereafter. Failures for a single region are
// swallowed — a partial prototype map is valid (routeQuery only blends the
// regions it has prototypes for).
// -----------------------------------------------------------------------------
const REGION_DESCRIPTIONS: Record<LogicalRegionId, string> = {
  "memory-core": "Recalling stored memories and remembering past conversations and facts.",
  "reasoning-cortex": "Planning, logical reasoning, inference, and multi-step problem solving.",
  "project-cortex": "Project status, code repositories, branches, milestones, and roadmaps.",
  "file-memory": "Finding files, paths, source code locations, and where functions are defined.",
  "model-hub": "Choosing language models, connectors, embeddings, and inference runtimes.",
  "response-center": "Drafting replies, composing emails, and writing the final response.",
  "error-detection-center": "Detecting contradictions, inconsistencies, conflicts, and mistakes.",
  "learning-feedback-center": "Feedback, training the ranker, and learning from user ratings.",
};

let prototypeCache: Partial<Record<LogicalRegionId, number[]>> | null = null;
let prototypePromise: Promise<Partial<Record<LogicalRegionId, number[]>>> | null = null;

export async function getRegionPrototypes(embedder: {
  embed: (t: string) => Promise<number[]>;
}): Promise<Partial<Record<LogicalRegionId, number[]>>> {
  if (prototypeCache) {
    return prototypeCache;
  }
  if (prototypePromise) {
    return prototypePromise;
  }
  prototypePromise = (async () => {
    const out: Partial<Record<LogicalRegionId, number[]>> = {};
    for (const region of LOGICAL_REGION_IDS) {
      try {
        out[region] = await embedder.embed(REGION_DESCRIPTIONS[region]);
      } catch {
        // Skip this region; a partial map is still usable.
      }
    }
    prototypeCache = out;
    return out;
  })();
  return prototypePromise;
}
