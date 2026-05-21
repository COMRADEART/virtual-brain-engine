import { ulid } from "ulid";
import type {
  BrainPeer,
  GovernanceModel,
  GovernanceProposal,
  Vote,
  VoteType,
  GoalStatus,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

export interface GovernanceConfig {
  defaultGovernanceModel: GovernanceModel;
  voteTimeoutMs: number;
  quorumPercentage: number;
  vetoThreshold: number;
  proposalDurationMs: number;
  enableDelegation: boolean;
  enableAnonymousVoting: boolean;
  minTrustToVote: number;
  minTrustToPropose: number;
}

const DEFAULT_CONFIG: GovernanceConfig = {
  defaultGovernanceModel: "consensus",
  voteTimeoutMs: 300000,
  quorumPercentage: 0.5,
  vetoThreshold: 0.33,
  proposalDurationMs: 600000,
  enableDelegation: true,
  enableAnonymousVoting: false,
  minTrustToVote: 0.3,
  minTrustToPropose: 0.5,
};

export interface DelegatedVote {
  delegatorId: string;
  delegateId: string;
  scope: string[];
  grantedAt: string;
  revokedAt?: string;
}

export interface GovernanceEventHandlers {
  onProposalCreated?: (proposal: GovernanceProposal) => void;
  onProposalPassed?: (proposal: GovernanceProposal) => void;
  onProposalRejected?: (proposal: GovernanceProposal) => void;
  onVoteReceived?: (proposalId: string, voterId: string, vote: Vote) => void;
  onDelegationChanged?: (delegation: DelegatedVote) => void;
}

export class GovernanceSystem {
  private readonly config: GovernanceConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: GovernanceEventHandlers;
  private readonly proposals = new Map<string, GovernanceProposal>();
  private readonly delegations = new Map<string, DelegatedVote>();
  private readonly voteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private myBrainId: string = "self";
  private trustEvaluator: (brainId: string) => number = () => 0.5;

  constructor(
    network: BrainNetwork,
    config: Partial<GovernanceConfig> = {},
    handlers: GovernanceEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  setTrustEvaluator(evaluator: (brainId: string) => number): void {
    this.trustEvaluator = evaluator;
  }

  start(): void {
    // GovernanceSystem is stateless, no initialization needed
  }

  stop(): void {
    for (const timer of this.voteTimers.values()) {
      clearTimeout(timer);
    }
    this.voteTimers.clear();
  }

  async createProposal(
    title: string,
    description: string,
    type: GovernanceProposal["type"],
    proposerId: string,
  ): Promise<GovernanceProposal> {
    if (this.trustEvaluator(proposerId) < this.config.minTrustToPropose && proposerId !== this.myBrainId) {
      throw new Error(`Brain ${proposerId} does not have sufficient trust to propose (need ${this.config.minTrustToPropose})`);
    }

    const now = new Date().toISOString();
    const proposal: GovernanceProposal = {
      id: `proposal-${ulid()}`,
      title,
      description,
      type,
      status: "proposed",
      proposerId,
      assignedBrainIds: [],
      votes: new Map(),
      voteType: this.selectVoteType(type),
      quorumRequired: this.config.quorumPercentage,
      createdAt: now,
      deadline: new Date(Date.now() + this.config.proposalDurationMs).toISOString(),
    };

    this.proposals.set(proposal.id, proposal);
    this.startVoteTimer(proposal.id);

    this.broadcastProposal(proposal);
    this.handlers.onProposalCreated?.(proposal);

    return proposal;
  }

  async vote(proposalId: string, voterId: string, vote: "yes" | "no" | "abstain", reasoning?: string): Promise<boolean> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return false;

    if (proposal.status !== "proposed") return false;

    if (this.isExpired(proposal)) {
      this.finalizeProposal(proposalId);
      return false;
    }

    const effectiveVoterId = this.resolveDelegation(voterId, proposal.type);

    if (effectiveVoterId !== voterId) {
      const delegatedVote: Vote = {
        voterId: effectiveVoterId,
        vote,
        weight: this.calculateVoteWeight(effectiveVoterId, proposal) * 0.8,
        reasoning: `Delegated from ${voterId}: ${reasoning ?? ""}`,
        timestamp: new Date().toISOString(),
      };
      proposal.votes.set(effectiveVoterId, delegatedVote);
    } else {
      if (this.trustEvaluator(voterId) < this.config.minTrustToVote && voterId !== this.myBrainId) {
        return false;
      }

      const voteRecord: Vote = {
        voterId,
        vote,
        weight: this.calculateVoteWeight(voterId, proposal),
        reasoning,
        timestamp: new Date().toISOString(),
      };
      proposal.votes.set(voterId, voteRecord);
    }

    const voteKey = effectiveVoterId !== voterId ? effectiveVoterId : voterId;
    const storedVote = proposal.votes.get(voteKey)!;

    this.handlers.onVoteReceived?.(proposalId, effectiveVoterId, storedVote);

    this.broadcastVote(proposalId, storedVote);

    if (this.checkEarlyCompletion(proposal)) {
      this.finalizeProposal(proposalId);
    }

    return true;
  }

  delegateVote(delegatorId: string, delegateId: string, scope?: string[]): DelegatedVote {
    const delegation: DelegatedVote = {
      delegatorId,
      delegateId,
      scope: scope ?? ["*"],
      grantedAt: new Date().toISOString(),
    };

    this.delegations.set(delegatorId, delegation);
    this.handlers.onDelegationChanged?.(delegation);

    return delegation;
  }

  revokeDelegation(delegatorId: string): void {
    const delegation = this.delegations.get(delegatorId);
    if (delegation) {
      delegation.revokedAt = new Date().toISOString();
      this.delegations.delete(delegatorId);
      this.handlers.onDelegationChanged?.(delegation);
    }
  }

  getDelegation(brainId: string): DelegatedVote | undefined {
    return this.delegations.get(brainId);
  }

  getProposal(proposalId: string): GovernanceProposal | undefined {
    return this.proposals.get(proposalId);
  }

  getAllProposals(status?: GoalStatus): GovernanceProposal[] {
    let results = Array.from(this.proposals.values());
    if (status) {
      results = results.filter((p) => p.status === status);
    }
    return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getActiveProposals(): GovernanceProposal[] {
    return this.getAllProposals("proposed");
  }

  getProposalResults(proposalId: string): { yes: number; no: number; abstain: number; total: number } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return { yes: 0, no: 0, abstain: 0, total: 0 };

    let yes = 0, no = 0, abstain = 0, total = 0;
    for (const vote of proposal.votes.values()) {
      total += vote.weight;
      switch (vote.vote) {
        case "yes": yes += vote.weight; break;
        case "no": no += vote.weight; break;
        case "abstain": abstain += vote.weight; break;
      }
    }

    return { yes, no, abstain, total };
  }

  handleIncomingVote(proposalId: string, vote: Vote): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "proposed") return;

    proposal.votes.set(vote.voterId, vote);
    this.handlers.onVoteReceived?.(proposalId, vote.voterId, vote);

    if (this.checkEarlyCompletion(proposal)) {
      this.finalizeProposal(proposalId);
    }
  }

  private selectVoteType(type: GovernanceProposal["type"]): VoteType {
    switch (type) {
      case "constitution":
        return "consensus";
      case "leadership":
        return "ranked-choice";
      case "membership":
        return "majority";
      case "resource":
        return "weighted";
      default:
        return this.config.defaultGovernanceModel === "consensus" ? "consensus" :
               this.config.defaultGovernanceModel === "weighted-expertise" ? "weighted" :
               this.config.defaultGovernanceModel === "direct-democracy" ? "majority" : "majority";
    }
  }

  private calculateVoteWeight(brainId: string, proposal: GovernanceProposal): number {
    const baseWeight = 1.0;
    const trust = this.trustEvaluator(brainId);
    const trustMultiplier = 0.5 + trust;

    let roleBonus = 1.0;
    if (brainId === proposal.proposerId) {
      roleBonus = 1.2;
    }

    return Math.min(2.0, baseWeight * trustMultiplier * roleBonus);
  }

  private resolveDelegation(voterId: string, scope: string): string {
    const delegation = this.delegations.get(voterId);
    if (!delegation || delegation.revokedAt) return voterId;

    const isScopeMatch = delegation.scope.includes("*") || delegation.scope.includes(scope);
    if (!isScopeMatch) return voterId;

    return delegation.delegateId;
  }

  private isExpired(proposal: GovernanceProposal): boolean {
    if (!proposal.deadline) return false;
    return new Date(proposal.deadline).getTime() < Date.now();
  }

  private checkEarlyCompletion(proposal: GovernanceProposal): boolean {
    if (proposal.voteType === "veto" || proposal.voteType === "consensus") {
      return false;
    }

    let yes = 0, no = 0, total = 0;
    for (const vote of proposal.votes.values()) {
      total += vote.weight;
      if (vote.vote === "yes") yes += vote.weight;
      if (vote.vote === "no") no += vote.weight;
    }

    if (total === 0) return false;

    const vetoes = no / total;
    if (vetoes >= this.config.vetoThreshold) {
      return true;
    }

    const yesThreshold = proposal.type === "constitution" ? 0.75 : 0.6;
    if (yes / total >= yesThreshold) {
      return true;
    }

    return false;
  }

  private finalizeProposal(proposalId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "proposed") return;

    const result = this.tallyVotes(proposal);

    if (result.passed) {
      proposal.status = "completed";
      proposal.outcome = "passed";
      proposal.executedAt = new Date().toISOString();
      this.handlers.onProposalPassed?.(proposal);
    } else {
      proposal.status = "abandoned";
      proposal.outcome = "rejected";
      this.handlers.onProposalRejected?.(proposal);
    }

    const timer = this.voteTimers.get(proposalId);
    if (timer) {
      clearTimeout(timer);
      this.voteTimers.delete(proposalId);
    }
  }

  private tallyVotes(proposal: GovernanceProposal): { passed: boolean; yesVotes: number; noVotes: number; abstainVotes: number } {
    let yesVotes = 0, noVotes = 0, abstainVotes = 0, totalWeight = 0;

    for (const vote of proposal.votes.values()) {
      totalWeight += vote.weight;
      switch (vote.vote) {
        case "yes": yesVotes += vote.weight; break;
        case "no": noVotes += vote.weight; break;
        case "abstain": abstainVotes += vote.weight; break;
      }
    }

    if (totalWeight === 0) {
      return { passed: false, yesVotes: 0, noVotes: 0, abstainVotes: 0 };
    }

    let passed = false;

    switch (proposal.voteType) {
      case "majority":
        passed = (yesVotes - noVotes) / totalWeight > 0.5;
        break;
      case "weighted":
        passed = yesVotes / totalWeight > 0.5;
        break;
      case "consensus":
        passed = noVotes / totalWeight < this.config.vetoThreshold && yesVotes / totalWeight > 0.6;
        break;
      case "ranked-choice":
        passed = yesVotes / totalWeight > 0.5;
        break;
      case "veto":
        passed = noVotes === 0 && yesVotes / totalWeight > 0.5;
        break;
    }

    return { passed, yesVotes, noVotes, abstainVotes };
  }

  private startVoteTimer(proposalId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal?.deadline) return;

    const delay = new Date(proposal.deadline).getTime() - Date.now();
    if (delay <= 0) {
      this.finalizeProposal(proposalId);
      return;
    }

    const timer = setTimeout(() => {
      this.finalizeProposal(proposalId);
    }, delay);

    this.voteTimers.set(proposalId, timer);
    timer.unref?.();
  }

  private broadcastProposal(proposal: GovernanceProposal): void {
    const message = {
      id: ulid(),
      type: "proposal" as const,
      sourceBrainId: this.myBrainId,
      payload: {
        proposal: {
          ...proposal,
          votes: Array.from(proposal.votes.entries()),
        },
      },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);
  }

  private broadcastVote(proposalId: string, vote: Vote): void {
    const message = {
      id: ulid(),
      type: "vote" as const,
      sourceBrainId: this.myBrainId,
      payload: { proposalId, vote },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);
  }
}

let singleton: GovernanceSystem | null = null;

export function createGovernance(
  network: BrainNetwork,
  config?: Partial<GovernanceConfig>,
  handlers?: GovernanceEventHandlers,
): GovernanceSystem {
  if (!singleton) {
    singleton = new GovernanceSystem(network, config, handlers);
  }
  return singleton;
}

export function getGovernance(): GovernanceSystem | null {
  return singleton;
}