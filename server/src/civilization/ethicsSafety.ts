import { ulid } from "ulid";
import type {
  EmergencyAlert,
  InterBrainMessage,
  ResourceBalance,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

/**
 * Ethics & Safety System (architecture component #18).
 *
 * Keeps the civilization aligned and safe: vets collective decisions against
 * ethical boundaries, raises and tracks emergency alerts, quarantines misbehaving
 * brains, and enforces resource fairness. This is the network-level sibling of the
 * single-brain `core/safety` gate. Conservative by design — when unsure, it flags.
 */

export type DecisionRisk = "allowed" | "review" | "blocked";

export interface DecisionEvaluation {
  allowed: boolean;
  risk: DecisionRisk;
  riskScore: number;
  violations: string[];
}

export interface EthicsSafetyConfig {
  /** Substrings that, if present in a decision, hard-block it. */
  forbiddenPatterns: string[];
  /** riskScore at/above which a decision needs review (but isn't blocked). */
  reviewThreshold: number;
  /** riskScore at/above which a decision is blocked outright. */
  blockThreshold: number;
  /** Max give/receive imbalance before a fairness violation is flagged. */
  fairnessImbalanceLimit: number;
  maxAlerts: number;
}

const DEFAULT_CONFIG: EthicsSafetyConfig = {
  forbiddenPatterns: [
    "disable safety",
    "exfiltrate",
    "delete all memories",
    "bypass governance",
    "self-replicate without consent",
    "harm",
  ],
  reviewThreshold: 0.4,
  blockThreshold: 0.7,
  fairnessImbalanceLimit: 100,
  maxAlerts: 500,
};

export interface EthicsSafetyEventHandlers {
  onAlertRaised?: (alert: EmergencyAlert) => void;
  onAlertResolved?: (alert: EmergencyAlert) => void;
  onBrainQuarantined?: (brainId: string, reason: string) => void;
}

export class EthicsSafetySystem {
  private readonly config: EthicsSafetyConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: EthicsSafetyEventHandlers;
  private readonly alerts = new Map<string, EmergencyAlert>();
  private readonly quarantined = new Map<string, string>();
  private myBrainId = "self";

  constructor(
    network: BrainNetwork,
    config: Partial<EthicsSafetyConfig> = {},
    handlers: EthicsSafetyEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  start(): void {
    // Reactive; nothing periodic.
  }

  stop(): void {
    // No resources held.
  }

  /** Vet a proposed collective decision against the ethical boundaries. */
  evaluateDecision(description: string, impactScore = 0): DecisionEvaluation {
    const violations: string[] = [];
    const lower = description.toLowerCase();
    for (const pattern of this.config.forbiddenPatterns) {
      if (lower.includes(pattern)) violations.push(`forbidden: "${pattern}"`);
    }

    // Risk grows with explicit violations and the caller's impact estimate.
    const riskScore = Math.min(1, violations.length * 0.5 + Math.max(0, Math.min(1, impactScore)) * 0.5);
    const risk: DecisionRisk =
      violations.length > 0 || riskScore >= this.config.blockThreshold
        ? "blocked"
        : riskScore >= this.config.reviewThreshold
          ? "review"
          : "allowed";

    return { allowed: risk !== "blocked", risk, riskScore, violations };
  }

  raiseAlert(
    type: EmergencyAlert["type"],
    severity: EmergencyAlert["severity"],
    description: string,
    affectedBrainIds: string[] = [],
    proposedActions: string[] = [],
  ): EmergencyAlert {
    const alert: EmergencyAlert = {
      id: `alert-${ulid()}`,
      type,
      severity,
      reporterId: this.myBrainId,
      description,
      affectedBrainIds,
      proposedActions,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    this.alerts.set(alert.id, alert);
    this.pruneAlerts();
    this.broadcast("emergency-alert", alert);
    this.handlers.onAlertRaised?.(alert);
    return alert;
  }

  acknowledgeAlert(alertId: string): void {
    const alert = this.alerts.get(alertId);
    if (alert && alert.status === "active") {
      alert.status = "acknowledged";
      this.broadcast("emergency-response", { alertId, status: "acknowledged" });
    }
  }

  resolveAlert(alertId: string): void {
    const alert = this.alerts.get(alertId);
    if (alert && alert.status !== "resolved") {
      alert.status = "resolved";
      alert.resolvedAt = new Date().toISOString();
      this.broadcast("emergency-response", { alertId, status: "resolved" });
      this.handlers.onAlertResolved?.(alert);
    }
  }

  quarantine(brainId: string, reason: string): void {
    this.quarantined.set(brainId, reason);
    this.handlers.onBrainQuarantined?.(brainId, reason);
    this.raiseAlert("trust-violation", "critical", `Quarantined ${brainId}: ${reason}`, [brainId], ["isolate", "review trust"]);
  }

  releaseQuarantine(brainId: string): void {
    this.quarantined.delete(brainId);
  }

  isQuarantined(brainId: string): boolean {
    return this.quarantined.has(brainId);
  }

  /** Flag brains whose give/receive imbalance exceeds the fairness limit. */
  checkResourceFairness(balances: ResourceBalance[]): string[] {
    const violations: string[] = [];
    for (const b of balances) {
      const imbalance = Math.abs(b.totalGiven - b.totalReceived);
      if (imbalance > this.config.fairnessImbalanceLimit) {
        violations.push(`${b.brainId}: imbalance ${imbalance.toFixed(0)} (gave ${b.totalGiven}, got ${b.totalReceived})`);
      }
    }
    if (violations.length > 0) {
      this.raiseAlert("resource-exhaustion", "warning", `Resource fairness breach: ${violations.length} brain(s)`, [], ["rebalance allocations"]);
    }
    return violations;
  }

  getAlert(alertId: string): EmergencyAlert | undefined {
    return this.alerts.get(alertId);
  }

  getActiveAlerts(): EmergencyAlert[] {
    return Array.from(this.alerts.values()).filter((a) => a.status !== "resolved");
  }

  getAllAlerts(): EmergencyAlert[] {
    return Array.from(this.alerts.values());
  }

  getQuarantined(): Array<{ brainId: string; reason: string }> {
    return Array.from(this.quarantined.entries()).map(([brainId, reason]) => ({ brainId, reason }));
  }

  private pruneAlerts(): void {
    if (this.alerts.size <= this.config.maxAlerts) return;
    const resolved = this.getAllAlerts()
      .filter((a) => a.status === "resolved")
      .sort((a, b) => (a.resolvedAt ?? "").localeCompare(b.resolvedAt ?? ""));
    for (const a of resolved) {
      if (this.alerts.size <= this.config.maxAlerts) break;
      this.alerts.delete(a.id);
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

let singleton: EthicsSafetySystem | null = null;

export function createEthicsSafety(
  network: BrainNetwork,
  config?: Partial<EthicsSafetyConfig>,
  handlers?: EthicsSafetyEventHandlers,
): EthicsSafetySystem {
  if (!singleton) {
    singleton = new EthicsSafetySystem(network, config, handlers);
  }
  return singleton;
}

export function getEthicsSafety(): EthicsSafetySystem | null {
  return singleton;
}
