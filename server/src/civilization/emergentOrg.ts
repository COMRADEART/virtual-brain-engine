import { ulid } from "ulid";
import type {
  EmergentGroup,
  GroupMember,
  InterBrainMessage,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

/**
 * Emergent Organization (architecture component #12).
 *
 * Tracks groups that form DYNAMICALLY around goals and dissolve when done —
 * research teams, crisis-response squads, simulation collectives. Where
 * roleSpecialization owns durable role *guilds*, this owns the transient
 * Tuckman lifecycle (forming → norming → performing → dissolving) and
 * auto-assembles teams from candidate brains for a given objective.
 */

export type GroupType = EmergentGroup["type"];
export type GroupPhase = "forming" | "norming" | "performing" | "dissolving" | "dissolved";

export interface EmergentOrgConfig {
  /** Idle ms with no contributions after which a performing group winds down. */
  inactivityDissolveMs: number;
  /** Contributions needed to advance forming → norming → performing. */
  phaseAdvanceContributions: number;
  maxGroups: number;
}

const DEFAULT_CONFIG: EmergentOrgConfig = {
  inactivityDissolveMs: 30 * 60 * 1000,
  phaseAdvanceContributions: 3,
  maxGroups: 200,
};

export interface EmergentOrgEventHandlers {
  onGroupFormed?: (group: EmergentGroup) => void;
  onPhaseChanged?: (groupId: string, phase: GroupPhase) => void;
  onGroupDissolved?: (group: EmergentGroup) => void;
}

export class EmergentOrganization {
  private readonly config: EmergentOrgConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: EmergentOrgEventHandlers;
  private readonly groups = new Map<string, EmergentGroup>();
  private readonly phases = new Map<string, GroupPhase>();
  private readonly lastActivity = new Map<string, number>();
  private myBrainId = "self";
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    network: BrainNetwork,
    config: Partial<EmergentOrgConfig> = {},
    handlers: EmergentOrgEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  start(): void {
    this.sweepTimer = setInterval(() => this.sweepInactive(), 60000);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  formGroup(
    name: string,
    type: GroupType,
    purpose: string,
    founderIds: string[],
    goals: string[] = [],
  ): EmergentGroup {
    const now = new Date().toISOString();
    const members: GroupMember[] = founderIds.map((brainId) => ({
      brainId,
      role: "founder",
      joinedAt: now,
      contributions: 0,
      isActive: true,
    }));
    const group: EmergentGroup = {
      id: `group-${ulid()}`,
      name,
      type,
      purpose,
      members,
      formedAt: now,
      isActive: true,
      goals,
      achievements: [],
    };
    this.groups.set(group.id, group);
    this.phases.set(group.id, "forming");
    this.lastActivity.set(group.id, Date.now());

    this.broadcast("group-form", { groupId: group.id, name, type, purpose, founderIds });
    this.handlers.onGroupFormed?.(group);
    return group;
  }

  /**
   * Auto-assemble a team for a goal from candidates, scored by a caller-supplied
   * fitness function (typically trust × role-fit). Picks the top `size`.
   */
  assembleForGoal(
    goalTitle: string,
    type: GroupType,
    candidates: string[],
    fitness: (brainId: string) => number,
    size = 3,
  ): EmergentGroup {
    const chosen = [...candidates]
      .sort((a, b) => fitness(b) - fitness(a))
      .slice(0, Math.max(1, size));
    return this.formGroup(`team:${goalTitle}`, type, `Pursue goal: ${goalTitle}`, chosen, [goalTitle]);
  }

  joinGroup(groupId: string, brainId: string, role = "member"): boolean {
    const group = this.groups.get(groupId);
    if (!group || !group.isActive) return false;
    if (group.members.some((m) => m.brainId === brainId)) return true;
    group.members.push({
      brainId,
      role,
      joinedAt: new Date().toISOString(),
      contributions: 0,
      isActive: true,
    });
    this.touch(groupId);
    this.broadcast("group-join", { groupId, brainId, role });
    return true;
  }

  leaveGroup(groupId: string, brainId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const member = group.members.find((m) => m.brainId === brainId);
    if (member) member.isActive = false;
    this.broadcast("group-leave", { groupId, brainId });
    if (group.members.every((m) => !m.isActive)) this.dissolveGroup(groupId, "all members left");
  }

  recordContribution(groupId: string, brainId: string, achievement?: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const member = group.members.find((m) => m.brainId === brainId);
    if (member) member.contributions++;
    if (achievement) group.achievements.push(achievement);
    this.touch(groupId);
    this.maybeAdvancePhase(groupId);
  }

  private maybeAdvancePhase(groupId: string): void {
    const group = this.groups.get(groupId);
    const phase = this.phases.get(groupId);
    if (!group || !phase) return;
    const totalContributions = group.members.reduce((s, m) => s + m.contributions, 0);

    let next: GroupPhase | null = null;
    if (phase === "forming" && totalContributions >= this.config.phaseAdvanceContributions) {
      next = "norming";
    } else if (phase === "norming" && totalContributions >= this.config.phaseAdvanceContributions * 2) {
      next = "performing";
    }
    if (next) {
      this.phases.set(groupId, next);
      this.handlers.onPhaseChanged?.(groupId, next);
      this.broadcast("group-update", { groupId, phase: next });
    }
  }

  dissolveGroup(groupId: string, reason = "purpose fulfilled"): void {
    const group = this.groups.get(groupId);
    if (!group || !group.isActive) return;
    group.isActive = false;
    group.dissolvedAt = new Date().toISOString();
    group.achievements.push(`dissolved: ${reason}`);
    this.phases.set(groupId, "dissolved");
    this.handlers.onPhaseChanged?.(groupId, "dissolved");
    this.handlers.onGroupDissolved?.(group);
    this.broadcast("group-update", { groupId, dissolved: true, reason });
  }

  getPhase(groupId: string): GroupPhase | undefined {
    return this.phases.get(groupId);
  }

  getGroup(groupId: string): EmergentGroup | undefined {
    return this.groups.get(groupId);
  }

  getAllGroups(): EmergentGroup[] {
    return Array.from(this.groups.values());
  }

  getActiveGroups(): EmergentGroup[] {
    return this.getAllGroups().filter((g) => g.isActive);
  }

  getGroupsForBrain(brainId: string): EmergentGroup[] {
    return this.getAllGroups().filter((g) => g.members.some((m) => m.brainId === brainId && m.isActive));
  }

  private touch(groupId: string): void {
    this.lastActivity.set(groupId, Date.now());
  }

  private sweepInactive(): void {
    const now = Date.now();
    for (const group of this.groups.values()) {
      if (!group.isActive) continue;
      const last = this.lastActivity.get(group.id) ?? now;
      if (now - last > this.config.inactivityDissolveMs && this.phases.get(group.id) === "performing") {
        this.dissolveGroup(group.id, "inactivity");
      }
    }
    if (this.groups.size > this.config.maxGroups) {
      const dissolved = this.getAllGroups()
        .filter((g) => !g.isActive)
        .sort((a, b) => (a.dissolvedAt ?? "").localeCompare(b.dissolvedAt ?? ""));
      for (const g of dissolved) {
        if (this.groups.size <= this.config.maxGroups) break;
        this.groups.delete(g.id);
        this.phases.delete(g.id);
        this.lastActivity.delete(g.id);
      }
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

let singleton: EmergentOrganization | null = null;

export function createEmergentOrg(
  network: BrainNetwork,
  config?: Partial<EmergentOrgConfig>,
  handlers?: EmergentOrgEventHandlers,
): EmergentOrganization {
  if (!singleton) {
    singleton = new EmergentOrganization(network, config, handlers);
  }
  return singleton;
}

export function getEmergentOrg(): EmergentOrganization | null {
  return singleton;
}
