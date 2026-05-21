import { Router } from "express";
import { createCivilization, type CivilizationConfig } from "../civilization/index.js";
import { ulid } from "ulid";
import type { BrainDescriptor } from "../../../shared/civilization.js";

export const civilizationRouter = Router();

const civilization = createCivilization();

export { civilization };

export function createLocalDescriptor(): BrainDescriptor {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    name: "local-brain",
    version: "1.0.0",
    capabilities: ["memory", "reasoning", "simulation"],
    resources: {
      computeUnits: 4,
      memoryMB: 8192,
      gpuUnits: 0,
      simulationBudget: 100,
      networkBandwidthMbps: 100,
    },
    resourceUsage: {
      cpu: 0.1,
      ram: 0.2,
      gpu: 0,
      batteryImpact: 0,
      thermalLoad: 0.1,
      latencyMs: 1,
      activeTasks: 1,
    },
    publicKey: "",
    health: "healthy",
    announcedAt: now,
    lastSeenAt: now,
  };
}

civilizationRouter.get("/civilization/status", (_req, res) => {
  const running = civilization.isRunning() ?? false;
  const snapshot = civilization.getSnapshot();

  res.json({
    running,
    generatedAt: new Date().toISOString(),
    snapshot: running ? snapshot : null,
  });
});

civilizationRouter.get("/civilization/peers", (_req, res) => {
  const sys = civilization.getSystem();
  const peers = sys?.network.getAllPeers() ?? [];
  res.json({
    count: peers.length,
    peers: peers.map((p) => ({
      id: p.id,
      name: p.descriptor.name,
      health: p.descriptor.health,
      isConnected: p.isConnected,
      latencyMs: p.latencyMs,
      lastHeartbeat: p.lastHeartbeat,
    })),
  });
});

civilizationRouter.get("/civilization/graph", (_req, res) => {
  const graph = civilization.getSocialGraph();
  res.json(graph ?? { nodes: [], edges: [] });
});

civilizationRouter.get("/civilization/trust", (_req, res) => {
  const network = civilization.getTrustNetwork();
  res.json(network ?? { nodes: [], edges: [] });
});

civilizationRouter.get("/civilization/map", (_req, res) => {
  const map = civilization.getCivilizationMap();
  res.json(map ?? { regions: [], connections: [] });
});

civilizationRouter.get("/civilization/goals", (_req, res) => {
  const sys = civilization.getSystem();
  const goals = sys?.collectiveGoals.getAllGoals() ?? [];
  res.json({
    count: goals.length,
    goals: goals.map((g) => ({
      id: g.id,
      title: g.title,
      status: g.status,
      progress: g.progress,
      priority: g.priority,
      proposerId: g.proposerId,
      assignedBrainIds: g.assignedBrainIds,
      deadline: g.deadline,
      createdAt: g.createdAt,
      completedAt: g.completedAt,
    })),
  });
});

civilizationRouter.post("/civilization/goals", (req, res) => {
  const sys = civilization.getSystem();
  if (!sys) {
    res.status(503).json({ error: "Civilization not running" });
    return;
  }

  const { title, description, assignedBrainIds, priority, deadline } = req.body;

  if (!title || !description) {
    res.status(400).json({ error: "title and description required" });
    return;
  }

  const goal = sys.collectiveGoals.proposeGoal(
    title,
    description,
    assignedBrainIds ?? [],
    priority ?? 50,
    deadline,
  );

  res.json({ id: goal.id, status: goal.status, createdAt: goal.createdAt });
});

civilizationRouter.get("/civilization/groups", (_req, res) => {
  const sys = civilization.getSystem();
  const groups = sys?.roleSpecialization.getAllGroups() ?? [];
  res.json({
    count: groups.length,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      type: g.type,
      purpose: g.purpose,
      memberCount: g.members.length,
      isActive: g.isActive,
      formedAt: g.formedAt,
      goals: g.goals,
      achievements: g.achievements,
    })),
  });
});

civilizationRouter.post("/civilization/groups", (req, res) => {
  const sys = civilization.getSystem();
  if (!sys) {
    res.status(503).json({ error: "Civilization not running" });
    return;
  }

  const { name, type, purpose, founderIds } = req.body;

  if (!name || !type || !purpose) {
    res.status(400).json({ error: "name, type, and purpose required" });
    return;
  }

  const group = sys.roleSpecialization.formGuild(
    name,
    type,
    purpose,
    founderIds ?? [],
  );

  res.json({ id: group.id, status: group.isActive ? "active" : "inactive", formedAt: group.formedAt });
});

civilizationRouter.get("/civilization/governance/proposals", (_req, res) => {
  const sys = civilization.getSystem();
  const proposals = sys?.governance.getAllProposals() ?? [];
  res.json({
    count: proposals.length,
    proposals: proposals.map((p) => ({
      id: p.id,
      title: p.title,
      type: p.type,
      status: p.status,
      proposerId: p.proposerId,
      voteType: p.voteType,
      createdAt: p.createdAt,
      deadline: p.deadline,
      outcome: p.outcome,
    })),
  });
});

civilizationRouter.post("/civilization/governance/proposals", (req, res) => {
  const sys = civilization.getSystem();
  if (!sys) {
    res.status(503).json({ error: "Civilization not running" });
    return;
  }

  const { title, description, type } = req.body;

  if (!title || !description || !type) {
    res.status(400).json({ error: "title, description, and type required" });
    return;
  }

  sys.governance.createProposal(title, description, type, "self")
    .then((proposal) => {
      res.json({ id: proposal.id, status: proposal.status, createdAt: proposal.createdAt });
    })
    .catch((err) => {
      res.status(500).json({ error: err.message });
    });
});

civilizationRouter.post("/civilization/governance/vote", (req, res) => {
  const sys = civilization.getSystem();
  if (!sys) {
    res.status(503).json({ error: "Civilization not running" });
    return;
  }

  const { proposalId, vote } = req.body;

  if (!proposalId || !vote || !["yes", "no", "abstain"].includes(vote)) {
    res.status(400).json({ error: "proposalId and vote (yes/no/abstain) required" });
    return;
  }

  sys.governance.vote(proposalId, "self", vote)
    .then((success) => {
      res.json({ success, proposalId });
    })
    .catch((err) => {
      res.status(500).json({ error: err.message });
    });
});

civilizationRouter.get("/civilization/culture/practices", (_req, res) => {
  const sys = civilization.getSystem();
  const practices = sys?.cultureEngine.getAllPractices() ?? [];
  res.json({
    count: practices.length,
    practices: practices.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      cultureType: p.cultureType,
      adoptedBy: p.adoptedBy,
      successRate: p.successRate,
      triedCount: p.triedCount,
    })),
  });
});

civilizationRouter.get("/civilization/culture/evolution", (_req, res) => {
  const sys = civilization.getSystem();
  const evolution = sys?.cultureEngine.getCultureEvolution();
  res.json(evolution ?? {
    civilizationId: "unknown",
    dominantCulture: "generalist",
    minorityCultures: [],
    sharedAbstractions: [],
    reasoningTraditions: [],
    communicationPatterns: [],
    divergenceMetrics: {},
    lastUpdatedAt: new Date().toISOString(),
  });
});

civilizationRouter.get("/civilization/roles", (_req, res) => {
  const sys = civilization.getSystem();
  const claims = sys?.roleSpecialization.getAllRoleClaims() ?? [];
  const roles = new Map<string, string[]>();

  for (const claim of claims) {
    if (!roles.has(claim.role)) {
      roles.set(claim.role, []);
    }
    roles.get(claim.role)!.push(claim.brainId);
  }

  res.json({
    roles: Object.fromEntries(roles),
    claims: claims.map((c) => ({
      brainId: c.brainId,
      role: c.role,
      endorsedBy: c.endorsedBy.length,
      disputedBy: c.disputedBy.length,
      verified: !!c.verifiedAt,
      claimedAt: c.claimedAt,
    })),
  });
});

civilizationRouter.get("/civilization/memory", (_req, res) => {
  const sys = civilization.getSystem();
  const memories = sys?.collectiveMemory.getAllLocalMemories() ?? [];
  res.json({
    count: memories.length,
    memories: memories.map((m) => ({
      id: m.id,
      content: m.content.slice(0, 200),
      memoryType: m.memoryType,
      importance: m.importance,
      privacy: m.privacy,
      tags: m.tags,
      createdAt: m.createdAt,
    })),
  });
});

civilizationRouter.get("/civilization/resources/prices", (_req, res) => {
  const sys = civilization.getSystem();
  const prices = sys?.resourceEconomy.getAllPrices();
  res.json(prices ?? {});
});

civilizationRouter.get("/civilization/resources/offers", (_req, res) => {
  const sys = civilization.getSystem();
  const offers = sys?.resourceEconomy.getActiveOffers() ?? [];
  res.json({
    count: offers.length,
    offers: offers.map((o) => ({
      id: o.id,
      resourceType: o.resourceType,
      amount: o.amount,
      unit: o.unit,
      availableUntil: o.availableUntil,
    })),
  });
});

civilizationRouter.post("/civilization/resources/offer", (req, res) => {
  const sys = civilization.getSystem();
  if (!sys) {
    res.status(503).json({ error: "Civilization not running" });
    return;
  }

  const { resourceType, amount, unit } = req.body;

  if (!resourceType || !amount || !unit) {
    res.status(400).json({ error: "resourceType, amount, and unit required" });
    return;
  }

  const offer = sys.resourceEconomy.createOffer(resourceType, amount, unit);
  res.json({ id: offer.id, resourceType, amount, status: "active" });
});

civilizationRouter.get("/civilization/visualization/snapshot", (_req, res) => {
  const snapshot = civilization.getSnapshot();
  res.json(snapshot ?? {
    generatedAt: new Date().toISOString(),
    totalPeers: 0,
    totalSocieties: 0,
    totalGroups: 0,
    activeGoals: 0,
    cultureType: "generalist",
    governanceModel: "consensus",
    resourceUtilization: {},
    peerHealth: {},
    trustDistribution: { low: 0, medium: 0, high: 0 },
    recentActivity: [],
    topology: { nodes: [], edges: [] },
  });
});