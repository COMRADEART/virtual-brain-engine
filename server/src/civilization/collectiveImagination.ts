import { ulid } from "ulid";
import type {
  ImaginationSession,
  ImaginationBranch,
  InterBrainMessage,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

/**
 * Collective Imagination (architecture component #13).
 *
 * Joint simulation of possible futures across brains. One brain opens a session
 * on a topic; peers contribute branches (candidate futures with a probability and
 * risk factors) and vote adopt/reject/defer. Fusion picks the branch with the best
 * probability-weighted support and records it as the session result. Mirrors the
 * single-brain `core/imagination` engine but spread across the network.
 */

export type ImaginationMode = ImaginationSession["mode"];
export type BranchVote = "adopt" | "reject" | "defer";

export interface CollectiveImaginationConfig {
  /** Risk-aversion: branches above this risk are penalised in fusion. */
  riskPenaltyThreshold: number;
  maxBranchesPerSession: number;
  maxSessions: number;
}

const DEFAULT_CONFIG: CollectiveImaginationConfig = {
  riskPenaltyThreshold: 0.6,
  maxBranchesPerSession: 32,
  maxSessions: 200,
};

export interface CollectiveImaginationEventHandlers {
  onSessionStarted?: (session: ImaginationSession) => void;
  onBranchAdded?: (sessionId: string, branch: ImaginationBranch) => void;
  onSessionCompleted?: (session: ImaginationSession) => void;
}

export interface FusionResult {
  sessionId: string;
  winningBranchId: string | null;
  score: number;
  rationale: string;
}

export class CollectiveImagination {
  private readonly config: CollectiveImaginationConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: CollectiveImaginationEventHandlers;
  private readonly sessions = new Map<string, ImaginationSession>();
  private myBrainId = "self";

  constructor(
    network: BrainNetwork,
    config: Partial<CollectiveImaginationConfig> = {},
    handlers: CollectiveImaginationEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  start(): void {
    // Event-driven; nothing periodic to schedule.
  }

  stop(): void {
    // No timers held.
  }

  startSession(topic: string, participants: string[], mode: ImaginationMode = "safe"): ImaginationSession {
    const session: ImaginationSession = {
      id: `imag-${ulid()}`,
      participants: participants.includes(this.myBrainId) ? participants : [this.myBrainId, ...participants],
      topic,
      mode,
      branches: [],
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    this.pruneSessions();
    this.broadcast("consensus-request", { sessionId: session.id, topic, mode, participants: session.participants });
    this.handlers.onSessionStarted?.(session);
    return session;
  }

  addBranch(
    sessionId: string,
    description: string,
    predictedOutcome: string,
    probability: number,
    riskFactors: string[] = [],
    parentId?: string,
  ): ImaginationBranch | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.completedAt) return null;
    if (session.branches.length >= this.config.maxBranchesPerSession) return null;

    const branch: ImaginationBranch = {
      id: `branch-${ulid()}`,
      parentId,
      description,
      probability: Math.max(0, Math.min(1, probability)),
      predictedOutcome,
      riskFactors,
      votes: new Map(),
    };
    session.branches.push(branch);
    this.broadcast("consensus-response", {
      sessionId,
      branchId: branch.id,
      description,
      probability: branch.probability,
    });
    this.handlers.onBranchAdded?.(sessionId, branch);
    return branch;
  }

  voteBranch(sessionId: string, branchId: string, brainId: string, vote: BranchVote): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.completedAt) return false;
    const branch = session.branches.find((b) => b.id === branchId);
    if (!branch) return false;
    branch.votes.set(brainId, vote);
    return true;
  }

  /** Score every branch by probability × net support, penalising high risk. */
  fuse(sessionId: string): FusionResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, winningBranchId: null, score: 0, rationale: "no such session" };

    let best: ImaginationBranch | null = null;
    let bestScore = -Infinity;
    for (const branch of session.branches) {
      let adopt = 0, reject = 0;
      for (const v of branch.votes.values()) {
        if (v === "adopt") adopt++;
        else if (v === "reject") reject++;
      }
      const support = adopt - reject;
      const riskPenalty = this.avgRisk(branch) > this.config.riskPenaltyThreshold ? 0.5 : 1;
      const score = branch.probability * (1 + support) * riskPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = branch;
      }
    }

    return {
      sessionId,
      winningBranchId: best?.id ?? null,
      score: best ? bestScore : 0,
      rationale: best
        ? `Selected "${best.description}" (p=${best.probability.toFixed(2)}, score=${bestScore.toFixed(2)})`
        : "no branches to fuse",
    };
  }

  completeSession(sessionId: string): ImaginationSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.completedAt) return session ?? null;
    const fusion = this.fuse(sessionId);
    session.result = fusion.rationale;
    session.completedAt = new Date().toISOString();
    this.handlers.onSessionCompleted?.(session);
    return session;
  }

  getSession(sessionId: string): ImaginationSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): ImaginationSession[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): ImaginationSession[] {
    return this.getAllSessions().filter((s) => !s.completedAt);
  }

  private avgRisk(branch: ImaginationBranch): number {
    // More listed risk factors ⇒ higher perceived risk, saturating toward 1.
    return Math.min(1, branch.riskFactors.length / 4);
  }

  private pruneSessions(): void {
    if (this.sessions.size <= this.config.maxSessions) return;
    const completed = this.getAllSessions()
      .filter((s) => s.completedAt)
      .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
    for (const s of completed) {
      if (this.sessions.size <= this.config.maxSessions) break;
      this.sessions.delete(s.id);
    }
  }

  private broadcast(type: InterBrainMessage["type"], payload: unknown): void {
    this.network.broadcast({
      id: ulid(),
      type,
      sourceBrainId: this.myBrainId,
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}

let singleton: CollectiveImagination | null = null;

export function createCollectiveImagination(
  network: BrainNetwork,
  config?: Partial<CollectiveImaginationConfig>,
  handlers?: CollectiveImaginationEventHandlers,
): CollectiveImagination {
  if (!singleton) {
    singleton = new CollectiveImagination(network, config, handlers);
  }
  return singleton;
}

export function getCollectiveImagination(): CollectiveImagination | null {
  return singleton;
}
