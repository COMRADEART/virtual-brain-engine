import { ulid } from "ulid";
import type {
  BrainRole,
  BrainRoleClaim,
  RoleEvidence,
  EmergentGroup,
  GroupMember,
} from "../../../shared/civilization.js";
import { BrainNetwork } from "./brainNetwork.js";

export interface RoleSpecializationConfig {
  evidenceThreshold: number;
  endorsementWeight: number;
  guildFormationThreshold: number;
  roleRotationPeriodMs: number;
  crossTrainingRate: number;
}

const DEFAULT_CONFIG: RoleSpecializationConfig = {
  evidenceThreshold: 3,
  endorsementWeight: 0.2,
  guildFormationThreshold: 3,
  roleRotationPeriodMs: 3600000,
  crossTrainingRate: 0.1,
};

export interface RoleEventHandlers {
  onRoleClaimed?: (claim: BrainRoleClaim) => void;
  onRoleVerified?: (claim: BrainRoleClaim) => void;
  onGuildFormed?: (group: EmergentGroup) => void;
  onGuildDissolved?: (groupId: string) => void;
  onRoleRotation?: (brainId: string, oldRole: BrainRole, newRole: BrainRole) => void;
}

export class RoleSpecialization {
  private readonly config: RoleSpecializationConfig;
  private readonly network: BrainNetwork;
  private readonly handlers: RoleEventHandlers;
  private readonly roleClaims = new Map<string, BrainRoleClaim>();
  private readonly groups = new Map<string, EmergentGroup>();
  private readonly brainRoles = new Map<string, BrainRole>();
  private readonly roleEvidence = new Map<string, RoleEvidence[]>();
  private myBrainId: string = "self";
  private myRole: BrainRole = "generalist";
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    network: BrainNetwork,
    config: Partial<RoleSpecializationConfig> = {},
    handlers: RoleEventHandlers = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.network = network;
    this.handlers = handlers;
  }

  setMyBrainId(brainId: string): void {
    this.myBrainId = brainId;
  }

  getMyRole(): BrainRole {
    return this.myRole;
  }

  claimRole(role: BrainRole, evidence: RoleEvidence[]): BrainRoleClaim {
    const existing = this.roleClaims.get(this.myBrainId);
    if (existing) {
      existing.role = role;
      existing.evidence.push(...evidence);
      existing.endorsedBy = [];
      existing.claimedAt = new Date().toISOString();
      this.handlers.onRoleClaimed?.(existing);
      return existing;
    }

    const claim: BrainRoleClaim = {
      brainId: this.myBrainId,
      role,
      evidence,
      endorsedBy: [],
      disputedBy: [],
      claimedAt: new Date().toISOString(),
    };

    this.roleClaims.set(this.myBrainId, claim);
    this.myRole = role;
    this.brainRoles.set(this.myBrainId, role);

    this.addRoleEvidence(role, evidence);

    this.handlers.onRoleClaimed?.(claim);
    this.broadcastRoleClaim(claim);

    return claim;
  }

  endorseRole(brainId: string, endorserId: string): boolean {
    const claim = this.roleClaims.get(brainId);
    if (!claim) return false;

    if (!claim.endorsedBy.includes(endorserId)) {
      claim.endorsedBy.push(endorserId);

      if (claim.endorsedBy.length >= this.config.evidenceThreshold && !claim.verifiedAt) {
        claim.verifiedAt = new Date().toISOString();
        this.brainRoles.set(brainId, claim.role);
        this.handlers.onRoleVerified?.(claim);
      }

      this.broadcastEndorsement(brainId, endorserId);
      return true;
    }

    return false;
  }

  disputeRole(brainId: string, disputedBy: string, reason?: string): void {
    const claim = this.roleClaims.get(brainId);
    if (!claim) return;

    if (!claim.disputedBy.includes(disputedBy)) {
      claim.disputedBy.push(disputedBy);
    }

    if (claim.disputedBy.length >= claim.endorsedBy.length * 2) {
      this.roleClaims.delete(brainId);
      this.brainRoles.delete(brainId);
    }
  }

  getRole(brainId: string): BrainRole | undefined {
    return this.brainRoles.get(brainId);
  }

  getRoleClaim(brainId: string): BrainRoleClaim | undefined {
    return this.roleClaims.get(brainId);
  }

  getAllRoleClaims(): BrainRoleClaim[] {
    return Array.from(this.roleClaims.values());
  }

  getBrainsByRole(role: BrainRole): string[] {
    return Array.from(this.brainRoles.entries())
      .filter(([, r]) => r === role)
      .map(([id]) => id);
  }

  formGuild(
    name: string,
    type: EmergentGroup["type"],
    purpose: string,
    founderIds: string[],
  ): EmergentGroup {
    const guild: EmergentGroup = {
      id: `group-${ulid()}`,
      name,
      type,
      purpose,
      members: founderIds.map((id) => ({
        brainId: id,
        role: this.brainRoles.get(id) ?? "generalist",
        joinedAt: new Date().toISOString(),
        contributions: 0,
        isActive: true,
      })),
      formedAt: new Date().toISOString(),
      isActive: true,
      goals: [],
      achievements: [],
    };

    this.groups.set(guild.id, guild);

    if (founderIds.length >= this.config.guildFormationThreshold) {
      this.handlers.onGuildFormed?.(guild);
    }

    this.broadcastGuildFormed(guild);

    return guild;
  }

  joinGuild(groupId: string, brainId: string): boolean {
    const guild = this.groups.get(groupId);
    if (!guild || !guild.isActive) return false;

    if (guild.members.some((m) => m.brainId === brainId)) return false;

    guild.members.push({
      brainId,
      role: this.brainRoles.get(brainId) ?? "generalist",
      joinedAt: new Date().toISOString(),
      contributions: 0,
      isActive: true,
    });

    return true;
  }

  leaveGuild(groupId: string, brainId: string): void {
    const guild = this.groups.get(groupId);
    if (!guild) return;

    guild.members = guild.members.filter((m) => m.brainId !== brainId);

    if (guild.members.length === 0) {
      this.dissolveGuild(groupId);
    }
  }

  dissolveGuild(groupId: string): void {
    const guild = this.groups.get(groupId);
    if (!guild) return;

    guild.isActive = false;
    guild.dissolvedAt = new Date().toISOString();

    this.handlers.onGuildDissolved?.(groupId);
    this.groups.delete(groupId);
  }

  getGroup(groupId: string): EmergentGroup | undefined {
    return this.groups.get(groupId);
  }

  getAllGroups(): EmergentGroup[] {
    return Array.from(this.groups.values()).filter((g) => g.isActive);
  }

  getGroupsByType(type: EmergentGroup["type"]): EmergentGroup[] {
    return this.getAllGroups().filter((g) => g.type === type);
  }

  getGroupsForBrain(brainId: string): EmergentGroup[] {
    return this.getAllGroups().filter((g) => g.members.some((m) => m.brainId === brainId));
  }

  recordContribution(groupId: string, brainId: string): void {
    const guild = this.groups.get(groupId);
    if (!guild) return;

    const member = guild.members.find((m) => m.brainId === brainId);
    if (member) {
      member.contributions++;
    }
  }

  addGoalToGroup(groupId: string, goalId: string): void {
    const guild = this.groups.get(groupId);
    if (guild && !guild.goals.includes(goalId)) {
      guild.goals.push(goalId);
    }
  }

  addAchievementToGroup(groupId: string, achievement: string): void {
    const guild = this.groups.get(groupId);
    if (guild) {
      guild.achievements.push(achievement);
    }
  }

  start(): void {
    this.rotationTimer = setInterval(() => {
      this.performRoleRotation();
    }, this.config.roleRotationPeriodMs);
    this.rotationTimer.unref?.();
  }

  stop(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }

  handleIncomingRoleClaim(claim: BrainRoleClaim): void {
    const existing = this.roleClaims.get(claim.brainId);
    if (existing) {
      for (const evidence of claim.evidence) {
        if (!existing.evidence.some((e) => e.description === evidence.description)) {
          existing.evidence.push(evidence);
        }
      }
      existing.endorsedBy = [...new Set([...existing.endorsedBy, ...claim.endorsedBy])];
    } else {
      this.roleClaims.set(claim.brainId, claim);
      this.brainRoles.set(claim.brainId, claim.role);
    }
  }

  handleIncomingGuild(guild: EmergentGroup): void {
    const existing = this.groups.get(guild.id);
    if (existing) {
      for (const member of guild.members) {
        if (!existing.members.some((m) => m.brainId === member.brainId)) {
          existing.members.push(member);
        }
      }
      existing.goals = [...new Set([...existing.goals, ...guild.goals])];
    } else {
      this.groups.set(guild.id, guild);
    }
  }

  private addRoleEvidence(role: BrainRole, evidence: RoleEvidence[]): void {
    if (!this.roleEvidence.has(role)) {
      this.roleEvidence.set(role, []);
    }
    const existing = this.roleEvidence.get(role)!;
    existing.push(...evidence);
  }

  private performRoleRotation(): void {
    for (const [brainId, role] of this.brainRoles) {
      if (Math.random() < this.config.crossTrainingRate) {
        const allRoles: BrainRole[] = [
          "planner", "memory-archivist", "simulation-researcher", "workflow-optimizer",
          "safety-guardian", "execution-coordinator", "robotics-controller", "research-lead", "generalist"
        ];
        const currentIndex = allRoles.indexOf(role);
        const newRole = allRoles[(currentIndex + 1) % allRoles.length];

        if (newRole !== role) {
          this.brainRoles.set(brainId, newRole);
          this.handlers.onRoleRotation?.(brainId, role, newRole);
        }
      }
    }
  }

  private broadcastRoleClaim(claim: BrainRoleClaim): void {
    const message = {
      id: ulid(),
      type: "role-claim" as const,
      sourceBrainId: this.myBrainId,
      payload: { claim },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);
  }

  private broadcastEndorsement(brainId: string, endorserId: string): void {
    const message = {
      id: ulid(),
      type: "role-claim" as const,
      sourceBrainId: endorserId,
      payload: { endorsedBrainId: brainId },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);
  }

  private broadcastGuildFormed(guild: EmergentGroup): void {
    const message = {
      id: ulid(),
      type: "group-form" as const,
      sourceBrainId: this.myBrainId,
      payload: { guild },
      timestamp: new Date().toISOString(),
    };
    this.network.broadcast(message);
  }
}

let singleton: RoleSpecialization | null = null;

export function createRoleSpecialization(
  network: BrainNetwork,
  config?: Partial<RoleSpecializationConfig>,
  handlers?: RoleEventHandlers,
): RoleSpecialization {
  if (!singleton) {
    singleton = new RoleSpecialization(network, config, handlers);
  }
  return singleton;
}

export function getRoleSpecialization(): RoleSpecialization | null {
  return singleton;
}