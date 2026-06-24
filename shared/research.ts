// Shared contract for the Deep Research mode ("Fable-style /deep-research"). ZERO
// runtime deps — pure types — so both the Vite client and the Node server import
// it without a build step.
//
// Deep research is an iterative, multi-source, CITED investigation that runs
// ALONGSIDE the 7-step pipeline and the agent loop (never inside /api/ask). It
// plans sub-questions, gathers from local memory AND the egress-gated live web
// across several rounds, synthesizes grounded findings (each citing memories as
// [m:<id>]), reflects for gaps, and emits a final cited report — which is itself
// persisted as a memory so the brain learns from its own research. Egress stays
// LOCAL_ONLY-gated, so on a local box it degrades to a local-memory-only report.

export interface DeepResearchOptions {
  // Hard ceiling on research rounds (plan→gather→synthesize→reflect). Resolved
  // against CONFIG.deepResearchMaxRounds by the caller (routes/research.ts +
  // actions/executor.ts via clampResearchOpts); the engine then re-clamps to a
  // hard [1, 5] absolute safety net.
  maxRounds?: number;
  // Sub-questions investigated per round. Resolved against CONFIG.deepResearchBreadth;
  // engine safety net [1, 8].
  breadth?: number;
  // Web pages fetched+learned per sub-question. Resolved against CONFIG.deepResearchMaxPages;
  // engine safety net [1, 10].
  maxPages?: number;
  conversationId?: string;
}

// One retrieved/learned source backing a finding. `origin` distinguishes a
// pre-existing local memory from a page freshly learned off the web this run.
export interface ResearchSource {
  memoryId: string;
  title: string | null;
  url?: string;
  score: number;
  origin: "local" | "web";
  round: number;
}

// One sub-question's grounded answer for a round. `summary` carries [m:<id>]
// markers validated against the gathered set; `sourceIds` are those memory ids.
export interface ResearchFinding {
  round: number;
  subQuestion: string;
  summary: string;
  sourceIds: string[];
}

export interface DeepResearchReport {
  question: string;
  // Full synthesized markdown report, [m:<id>] markers validated against sources.
  report: string;
  // One-paragraph TL;DR (the report's leading summary), for compact surfaces.
  summary: string;
  findings: ResearchFinding[];
  openQuestions: string[];
  sources: ResearchSource[];
  rounds: number;
  // True when reflection declared the question answered before the round budget.
  converged: boolean;
  // The id of the memory the report was persisted as (null if persistence failed
  // or was skipped). Lets the UI cite the report itself.
  reportMemoryId: string | null;
  // Snapshot of the egress posture this run ran under (false = web was reachable).
  localOnly: boolean;
}

// SSE frames streamed by POST /api/research/deep. Every member carries a `type`
// discriminator (the emitter writes `event: ${frame.type}`) and a timestamp.
export type DeepResearchEvent =
  | { type: "research-start"; question: string; maxRounds: number; localOnly: boolean; timestamp: string }
  | { type: "plan"; round: number; subQuestions: string[]; timestamp: string }
  | {
      type: "gather";
      round: number;
      subQuestion: string;
      localHits: number;
      webHits: number;
      provider: string | null;
      sources: ResearchSource[];
      timestamp: string;
    }
  | { type: "synthesize"; round: number; finding: ResearchFinding; timestamp: string }
  | { type: "reflect"; round: number; gaps: string[]; converged: boolean; timestamp: string }
  | { type: "report-delta"; tokensDelta: string; timestamp: string }
  | { type: "report"; report: DeepResearchReport; timestamp: string }
  | { type: "error"; detail: string; timestamp: string };
