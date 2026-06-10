import { ulid } from "ulid";
import type {
  CivilizationDescriptor,
  CultureType,
  GovernanceModel,
  InterBrainMessage,
  Society,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

/**
 * Multi-Civilization Support (architecture component #19).
 *
 * Lets a single host participate in / track multiple distinct civilizations and
 * the societies nested within them, plus broker inter-civilization collaboration
 * and knowledge exchange. Membership uses Sets (per the shared contract); a
 * serializable view is provided for the HTTP layer.
 */

export interface KnowledgeExchange {
  id: string;
  fromCivId: string;
  toCivId: string;
  items: string[];
  reciprocal: boolean;
  createdAt: string;
}

export interface InterCivConflict {
  id: string;
  civA: string;
  civB: string;
  issue: string;
  status: "open" | "mediating" | "resolved";
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface MultiCivilizationConfig {
  maxCivilizations: number;
}

const DEFAULT_CONFIG: MultiCivilizationConfig = {
  maxCivilizations: 64,
};

export interface MultiCivilizationEventHandlers {
  onCivilizationRegistered?: (civ: CivilizationDescriptor) => void;
  onBrainJoined?: (civId: string, brainId: string) => void;
  onConflictResolved?: (conflict: InterCivConflict) => void;
}

export class MultiCivilizationSystem {
  private readonly config: MultiCivilizationConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: MultiCivilizationEventHandlers;
  private readonly civilizations = new Map<string, CivilizationDescriptor>();
  private readonly societies = new Map<string, Society>();
  private readonly exchanges: KnowledgeExchange[] = [];
  private readonly conflicts = new Map<string, InterCivConflict>();
  private myBrainId = "self";

  constructor(
    network: BrainNetwork,
    config: Partial<MultiCivilizationConfig> = {},
    handlers: MultiCivilizationEventHandlers = {},
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

  registerCivilization(
    name: string,
    description: string,
    governanceModel: GovernanceModel,
    cultureType: CultureType,
    foundingBrains: string[],
    constitution?: string,
  ): CivilizationDescriptor {
    const civ: CivilizationDescriptor = {
      id: `civ-${ulid()}`,
      name,
      description,
      governanceModel,
      foundingBrains,
      constitution,
      memberBrainIds: new Set(foundingBrains),
      guestBrainIds: new Set(),
      createdAt: new Date().toISOString(),
      cultureType,
      publicKey: "",
    };
    this.civilizations.set(civ.id, civ);
    this.pruneCivilizations();
    this.handlers.onCivilizationRegistered?.(civ);
    return civ;
  }

  joinCivilization(civId: string, brainId: string, asGuest = false): boolean {
    const civ = this.civilizations.get(civId);
    if (!civ) return false;
    if (asGuest) civ.guestBrainIds.add(brainId);
    else {
      civ.memberBrainIds.add(brainId);
      civ.guestBrainIds.delete(brainId);
    }
    this.broadcast("civilization-join", { civId, brainId, asGuest });
    this.handlers.onBrainJoined?.(civId, brainId);
    return true;
  }

  leaveCivilization(civId: string, brainId: string): void {
    const civ = this.civilizations.get(civId);
    if (!civ) return;
    civ.memberBrainIds.delete(brainId);
    civ.guestBrainIds.delete(brainId);
    this.broadcast("civilization-leave", { civId, brainId });
  }

  inviteToCivilization(civId: string, targetBrainId: string): void {
    this.network.send(targetBrainId, {
      id: ulid(),
      type: "civilization-invite",
      sourceBrainId: this.myBrainId,
      targetBrainId,
      payload: { civId },
      timestamp: new Date().toISOString(),
    });
  }

  createSociety(name: string, civilizationId: string, purpose: string, memberIds: string[], leaderId?: string): Society {
    const society: Society = {
      id: `society-${ulid()}`,
      name,
      civilizationId,
      memberIds,
      purpose,
      formedAt: new Date().toISOString(),
      leaderId,
    };
    this.societies.set(society.id, society);
    return society;
  }

  /** Record a knowledge exchange between two civilizations. */
  exchangeKnowledge(fromCivId: string, toCivId: string, items: string[], reciprocal = false): KnowledgeExchange {
    const exchange: KnowledgeExchange = {
      id: `exch-${ulid()}`,
      fromCivId,
      toCivId,
      items,
      reciprocal,
      createdAt: new Date().toISOString(),
    };
    this.exchanges.push(exchange);
    if (this.exchanges.length > 1000) this.exchanges.shift();
    return exchange;
  }

  openConflict(civA: string, civB: string, issue: string): InterCivConflict {
    const conflict: InterCivConflict = {
      id: `conflict-${ulid()}`,
      civA,
      civB,
      issue,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    this.conflicts.set(conflict.id, conflict);
    return conflict;
  }

  resolveConflict(conflictId: string, resolution: string): InterCivConflict | null {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict || conflict.status === "resolved") return conflict ?? null;
    conflict.status = "resolved";
    conflict.resolution = resolution;
    conflict.resolvedAt = new Date().toISOString();
    this.handlers.onConflictResolved?.(conflict);
    return conflict;
  }

  getCivilization(civId: string): CivilizationDescriptor | undefined {
    return this.civilizations.get(civId);
  }

  getAllCivilizations(): CivilizationDescriptor[] {
    return Array.from(this.civilizations.values());
  }

  getSocieties(civId?: string): Society[] {
    const all = Array.from(this.societies.values());
    return civId ? all.filter((s) => s.civilizationId === civId) : all;
  }

  getExchanges(): KnowledgeExchange[] {
    return [...this.exchanges];
  }

  getConflicts(): InterCivConflict[] {
    return Array.from(this.conflicts.values());
  }

  /** Set-free view for JSON responses. */
  getCivilizationsSerializable(): Array<Omit<CivilizationDescriptor, "memberBrainIds" | "guestBrainIds"> & {
    memberBrainIds: string[];
    guestBrainIds: string[];
  }> {
    return this.getAllCivilizations().map((c) => ({
      ...c,
      memberBrainIds: Array.from(c.memberBrainIds),
      guestBrainIds: Array.from(c.guestBrainIds),
    }));
  }

  private pruneCivilizations(): void {
    if (this.civilizations.size <= this.config.maxCivilizations) return;
    const oldest = this.getAllCivilizations().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest) this.civilizations.delete(oldest.id);
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

let singleton: MultiCivilizationSystem | null = null;

export function createMultiCivilization(
  network: BrainNetwork,
  config?: Partial<MultiCivilizationConfig>,
  handlers?: MultiCivilizationEventHandlers,
): MultiCivilizationSystem {
  if (!singleton) {
    singleton = new MultiCivilizationSystem(network, config, handlers);
  }
  return singleton;
}

export function getMultiCivilization(): MultiCivilizationSystem | null {
  return singleton;
}
