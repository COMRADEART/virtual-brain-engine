// Civilization layer selfcheck — hermetic behavioural tests for the Phase 3
// "distributed civilization" modules (architecture components #4, #11–#19) plus
// a wiring test of the CivilizationOrchestrator.
//
// Run: npm --prefix server run civilization:selfcheck
//
// HERMETIC: a BrainNetwork is constructed but never `start()`ed, so NO TCP/UDP
// socket is ever bound (broadcast/send become no-ops with zero peers). The
// orchestrator is exercised by construction + getSystem() membership only — its
// timers and sockets live in start(), which the live server boot covers
// separately. No DB, no torch, no network.
//
// Asserts, per module:
//   (A) trustReputation — multi-axis aggregation, self-weight, remote propagation,
//       and Sybil detection of low-standing high-volume reporters.
//   (B) interBrainMemory — collaboration stats, credit aggregation, partner rank.
//   (C) emergentOrg — Tuckman phase advance, auto-assembly, dissolve.
//   (D) collectiveImagination — branch voting + probability/support fusion.
//   (E) languageEvolution — adoption threshold, compress/expand round-trip.
//   (F) civilizationTwin — provider-fed snapshot + resource-flow ledger balances.
//   (G) civilizationSimulation — determinism + governance/resource/trust/scaling.
//   (H) collectiveDreaming — idle gating, insight gain, consolidation.
//   (I) ethicsSafety — decision vetting, alert lifecycle, quarantine, fairness.
//   (J) multiCivilization — register/join, societies, knowledge exchange, conflict.
//   (K) orchestrator — every advanced subsystem is wired into getSystem().

import { BrainNetwork } from "../src/civilization/brainNetwork.js";
import { TrustReputationSystem } from "../src/civilization/trustReputation.js";
import { InterBrainMemorySystem } from "../src/civilization/interBrainMemory.js";
import { EmergentOrganization } from "../src/civilization/emergentOrg.js";
import { CollectiveImagination } from "../src/civilization/collectiveImagination.js";
import { LanguageEvolutionSystem } from "../src/civilization/languageEvolution.js";
import { CivilizationTwinModel } from "../src/civilization/civilizationTwin.js";
import { CivilizationSimulationEngine } from "../src/civilization/civilizationSimulation.js";
import { CollectiveDreaming } from "../src/civilization/collectiveDreaming.js";
import { EthicsSafetySystem } from "../src/civilization/ethicsSafety.js";
import { MultiCivilizationSystem } from "../src/civilization/multiCivilization.js";
import { CivilizationOrchestrator } from "../src/civilization/index.js";
import type { InterBrainMessage, TrustEdge } from "../../shared/civilization.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// A network that is NEVER started — broadcast/send are inert with no peers.
const net = new BrainNetwork({ enableLogging: false });
check("BrainNetwork constructed without binding a socket", net.isRunning() === false);

// -----------------------------------------------------------------------------
// (A) trustReputation
// -----------------------------------------------------------------------------
{
  const trust = new TrustReputationSystem(net);
  trust.setMyBrainId("self");

  trust.recordEvidence("self", "peerA", "competence", 0.4, "great plan");
  const repA = trust.getReputation("peerA");
  check("trust: positive competence evidence lifts that axis above neutral", repA.competenceTrust > 0.5, `c=${repA.competenceTrust.toFixed(3)}`);
  check("trust: overall trust in [0,1]", repA.overallTrust >= 0 && repA.overallTrust <= 1, `o=${repA.overallTrust.toFixed(3)}`);
  check("trust: untouched axis stays at neutral baseline", Math.abs(repA.safetyTrust - 0.5) < 1e-9, `s=${repA.safetyTrust}`);

  check("trust: self reporter carries the configured self weight", trust.reporterWeight("self") === 2.0, `w=${trust.reporterWeight("self")}`);

  // Remote third-party report moves reputation (damped).
  const msg: InterBrainMessage = {
    id: "m1",
    type: "trust-update",
    sourceBrainId: "peerB",
    payload: { aboutBrainId: "peerC", trustAxis: "reliability", delta: 0.8 },
    timestamp: new Date().toISOString(),
  };
  trust.ingestRemoteReport("peerB", msg);
  check("trust: remote report registers reputation for the subject", trust.getReputation("peerC").reliabilityTrust > 0.5);

  // Sybil: a reporter with a tanked OWN reputation reporting in volume is flagged.
  for (const axis of ["competence", "reliability", "safety", "honesty"] as const) {
    trust.recordEvidence("self", "sybil", axis, -1, "consistently dishonest");
  }
  check("trust: sybil's own reputation collapses under strong negative evidence", trust.getGlobalTrust("sybil") <= 0.1, `gt=${trust.getGlobalTrust("sybil").toFixed(3)}`);
  for (const victim of ["v1", "v2", "v3"]) {
    trust.recordEvidence("sybil", victim, "honesty", 0.9, "fake endorsement");
  }
  const sybils = trust.detectSybils();
  check("trust: detectSybils flags the low-standing high-volume reporter", sybils.some((s) => s.reporterId === "sybil"), `flagged=[${sybils.map((s) => s.reporterId).join(",")}]`);

  // Deployed path: the orchestrator wires setSelfTrustProvider → socialCognition,
  // which returns the NEUTRAL default (0.5) for a peer it has never met. The
  // tanked reporter must STILL be flagged — i.e. this engine's own negative
  // reputation is not overridden by the provider's "unknown → neutral".
  trust.setSelfTrustProvider(() => 0.5);
  check("trust: reporter we've tanked stays low-weight even with a neutral provider", trust.reporterWeight("sybil") <= 0.1, `w=${trust.reporterWeight("sybil").toFixed(3)}`);
  const sybils2 = trust.detectSybils();
  check("trust: Sybil detection survives the deployed neutral-provider wiring", sybils2.some((s) => s.reporterId === "sybil"), `flagged=[${sybils2.map((s) => s.reporterId).join(",")}]`);
}

// -----------------------------------------------------------------------------
// (B) interBrainMemory
// -----------------------------------------------------------------------------
{
  const mem = new InterBrainMemorySystem();
  mem.record("collaboration", ["peerA"], "success", "shipped feature", ["pairing helps"], { peerA: 5 });
  mem.record("collaboration", ["peerA"], "success", "fixed bug", [], { peerA: 3 });
  mem.record("trade", ["peerA"], "failure", "deal fell through", ["verify upfront"]);

  const stats = mem.getCollaborationStats("peerA");
  check("ibm: total interactions counted", stats.total === 3, `total=${stats.total}`);
  check("ibm: success/failure tallies", stats.success === 2 && stats.failure === 1, `s=${stats.success} f=${stats.failure}`);
  check("ibm: score in [-1,1] and net-positive here", stats.score > 0 && stats.score <= 1, `score=${stats.score.toFixed(3)}`);
  check("ibm: credit aggregates across memories", mem.getCreditFor("peerA") === 8, `credit=${mem.getCreditFor("peerA")}`);
  check("ibm: lessons learned collected", mem.getLessonsLearned("peerA").length === 2);
  check("ibm: rankPartners returns the known partner", mem.rankPartners().some((p) => p.brainId === "peerA"));
  check("ibm: summary is human-readable", /peerA/.test(mem.summarizeRelationship("peerA")));
  check("ibm: unknown peer summary degrades gracefully", /No remembered/.test(mem.summarizeRelationship("ghost")));
}

// -----------------------------------------------------------------------------
// (C) emergentOrg
// -----------------------------------------------------------------------------
{
  const org = new EmergentOrganization(net);
  org.setMyBrainId("self");
  const g = org.formGroup("alpha", "research", "study X", ["self", "peerA"]);
  check("org: group starts in 'forming'", org.getPhase(g.id) === "forming");
  check("org: active group is listed", org.getActiveGroups().length === 1);

  for (let i = 0; i < 3; i++) org.recordContribution(g.id, "self");
  check("org: advances forming → norming at the contribution threshold", org.getPhase(g.id) === "norming", `phase=${org.getPhase(g.id)}`);
  for (let i = 0; i < 3; i++) org.recordContribution(g.id, "peerA");
  check("org: advances norming → performing", org.getPhase(g.id) === "performing", `phase=${org.getPhase(g.id)}`);

  const team = org.assembleForGoal("win", "crisis-response", ["x", "y", "z"], (id) => (id === "y" ? 1 : 0), 1);
  check("org: assembleForGoal picks the highest-fitness candidate", team.members[0]?.brainId === "y", `picked=${team.members[0]?.brainId}`);

  org.dissolveGroup(g.id, "done");
  check("org: dissolve flips isActive false and phase 'dissolved'", g.isActive === false && org.getPhase(g.id) === "dissolved");
}

// -----------------------------------------------------------------------------
// (D) collectiveImagination
// -----------------------------------------------------------------------------
{
  const imag = new CollectiveImagination(net);
  imag.setMyBrainId("self");
  const s = imag.startSession("redesign cache", ["peerA"], "sandbox");
  check("imag: session is active after start", imag.getActiveSessions().length === 1);
  check("imag: starter is auto-added to participants", s.participants.includes("self"));

  const low = imag.addBranch(s.id, "do nothing", "stagnation", 0.3, []);
  const high = imag.addBranch(s.id, "rewrite in Rust", "fast cache", 0.7, ["risky"]);
  check("imag: branches recorded", s.branches.length === 2);
  imag.voteBranch(s.id, high!.id, "peerA", "adopt");
  imag.voteBranch(s.id, high!.id, "self", "adopt");
  imag.voteBranch(s.id, low!.id, "peerA", "reject");

  const fusion = imag.fuse(s.id);
  check("imag: fusion selects the higher-probability well-supported branch", fusion.winningBranchId === high!.id, `winner=${fusion.winningBranchId}`);

  const completed = imag.completeSession(s.id);
  check("imag: completed session carries a result and leaves the active set", !!completed?.result && imag.getActiveSessions().length === 0);
}

// -----------------------------------------------------------------------------
// (E) languageEvolution
// -----------------------------------------------------------------------------
{
  const lang = new LanguageEvolutionSystem({ adoptionThreshold: 3 });
  lang.proposeAbbreviation("brain engine", "BE");
  check("lang: not adopted before the threshold", lang.isAdopted("abbreviation", "brain engine") === false);
  lang.proposeAbbreviation("brain engine", "BE");
  lang.proposeAbbreviation("brain engine", "BE");
  check("lang: adopted once the usage threshold is reached", lang.isAdopted("abbreviation", "brain engine") === true);

  const compressed = lang.compress("the brain engine restarts");
  check("lang: compress applies the adopted dialect", compressed === "the BE restarts", `got="${compressed}"`);
  check("lang: expand is the inverse of compress", lang.expand(compressed) === "the brain engine restarts");
  check("lang: compression ratio is positive for compressible text", lang.compressionRatio("the brain engine") > 0);

  const state = lang.getStateSerializable();
  check("lang: serializable state lists the adopted abbreviation", state.abbreviations["brain engine"] === "BE" && state.adoptedCount === 1);
}

// -----------------------------------------------------------------------------
// (F) civilizationTwin
// -----------------------------------------------------------------------------
{
  const twin = new CivilizationTwinModel({ civilizationId: "test" });
  const edges: TrustEdge[] = [{ fromBrainId: "self", toBrainId: "peerA", trust: 0.8 }];
  twin.setProviders({
    brainCount: () => 4,
    interactionCount: () => 12,
    activeGoals: () => 2,
    trustEdges: () => edges,
  });
  const snap = twin.captureSnapshot();
  check("twin: snapshot reflects provider values", snap.totalBrains === 4 && snap.totalInteractions === 12 && snap.activeGoals === 2);
  check("twin: trust edges pass through", snap.trustNetwork.length === 1);

  twin.recordResourceFlow("a", "b", "compute", 10);
  twin.recordResourceFlow("a", "c", "gpu", 4);
  const balances = twin.getResourceBalances();
  check("twin: resource ledger balances net to zero giver/receiver", balances["a"] === -14 && balances["b"] === 10 && balances["c"] === 4, `bal=${JSON.stringify(balances)}`);
  twin.captureSnapshot();
  check("twin: history accumulates snapshots", twin.getHistory().length === 2);
}

// -----------------------------------------------------------------------------
// (G) civilizationSimulation
// -----------------------------------------------------------------------------
{
  const sim = new CivilizationSimulationEngine();
  const a = sim.simulateGovernance({ model: "consensus", brainCount: 9, approvalBias: 0.7, proposals: 20 }, 42);
  const b = sim.simulateGovernance({ model: "consensus", brainCount: 9, approvalBias: 0.7, proposals: 20 }, 42);
  check("sim: governance simulation is deterministic for a fixed seed", a.passRate === b.passRate, `a=${a.passRate} b=${b.passRate}`);
  const dict = sim.simulateGovernance({ model: "dictatorship", brainCount: 9, approvalBias: 0.7, proposals: 20 }, 42);
  check("sim: dictatorship is less fair than consensus", dict.fairness < a.fairness, `dict=${dict.fairness} cons=${a.fairness}`);

  const full = sim.simulateResourceAllocation(
    [{ id: "o1", resourceType: "compute", amount: 100, unit: "u", price: 1 }],
    [{ id: "r1", resourceType: "compute", amount: 60, unit: "u", urgency: "high" }],
  );
  check("sim: resource allocation fully meets satisfiable demand", full.efficiency === 1 && full.unmetDemand === 0);
  const partial = sim.simulateResourceAllocation(
    [{ id: "o1", resourceType: "compute", amount: 100, unit: "u", price: 1 }],
    [
      { id: "r1", resourceType: "compute", amount: 60, unit: "u", urgency: "critical" },
      { id: "r2", resourceType: "compute", amount: 60, unit: "u", urgency: "low" },
    ],
  );
  check("sim: oversubscribed demand leaves an unmet remainder", partial.unmetDemand === 20 && partial.efficiency < 1, `unmet=${partial.unmetDemand} eff=${partial.efficiency.toFixed(3)}`);

  check("sim: trust grows under all-success interactions", sim.simulateTrustEvolution(0.5, 10, 1).finalTrust > 0.5);
  check("sim: trust collapses under all-failure interactions", sim.simulateTrustEvolution(0.5, 20, 0).collapsed === true);
  check("sim: scaling recommends flat for tiny networks", sim.simulateScaling(4).recommendation === "flat");
  check("sim: scaling recommends federated for large networks", sim.simulateScaling(200).recommendation === "federated");
}

// -----------------------------------------------------------------------------
// (H) collectiveDreaming
// -----------------------------------------------------------------------------
{
  const dream = new CollectiveDreaming(net, { activityThreshold: 0.2, minCycleIntervalMs: 5 * 60 * 1000 });
  dream.setMyBrainId("self");
  check("dream: no cycle starts when the system is busy", dream.maybeDream(0.5, ["peerA"]) === null);
  const cycle = dream.maybeDream(0.1, ["peerA"]);
  check("dream: a quiet system starts a dream cycle", cycle !== null && dream.getActiveCycles().length === 1);
  check("dream: cooldown blocks an immediate second cycle", dream.maybeDream(0.1, ["peerA"]) === null);

  dream.contributeInsight(cycle!.id, "self", "compress episodic memories", 0.3);
  dream.contributeInsight(cycle!.id, "peerA", "prune dead pathways", 0.5);
  const done = dream.consolidate(cycle!.id);
  check("dream: consolidation closes the cycle and sums gain", done?.status === "consolidated" && Math.abs(done!.totalGain - 0.8) < 1e-9, `gain=${done?.totalGain}`);
  check("dream: consolidated result names the best insight", /prune dead pathways/.test(done?.result ?? ""));
}

// -----------------------------------------------------------------------------
// (I) ethicsSafety
// -----------------------------------------------------------------------------
{
  const ethics = new EthicsSafetySystem(net);
  ethics.setMyBrainId("self");
  const bad = ethics.evaluateDecision("disable safety and exfiltrate memories");
  check("ethics: forbidden decision is blocked with violations", bad.allowed === false && bad.violations.length >= 2, `v=${bad.violations.length}`);
  const ok = ethics.evaluateDecision("organize a friendly knowledge exchange");
  check("ethics: benign decision is allowed", ok.allowed === true && ok.risk === "allowed");
  const risky = ethics.evaluateDecision("large irreversible migration", 0.8);
  check("ethics: high-impact-but-clean decision needs review, not block", risky.risk === "review" && risky.allowed === true, `risk=${risky.risk}`);

  const alert = ethics.raiseAlert("system-failure", "warning", "disk pressure", ["self"], ["free space"]);
  check("ethics: raised alert is active", ethics.getActiveAlerts().length === 1);
  ethics.resolveAlert(alert.id);
  check("ethics: resolved alert leaves the active set", ethics.getActiveAlerts().length === 0);

  ethics.quarantine("bad-brain", "repeated trust violations");
  check("ethics: quarantine records the brain and raises a critical alert", ethics.isQuarantined("bad-brain") && ethics.getActiveAlerts().some((a) => a.severity === "critical"));

  const fairness = ethics.checkResourceFairness([
    { brainId: "hoarder", giveBalance: 0, receiveBalance: 0, totalGiven: 0, totalReceived: 500, lastSettledAt: new Date().toISOString() },
  ]);
  check("ethics: resource-fairness breach is flagged", fairness.length === 1);
}

// -----------------------------------------------------------------------------
// (J) multiCivilization
// -----------------------------------------------------------------------------
{
  const multi = new MultiCivilizationSystem(net);
  multi.setMyBrainId("self");
  const civ = multi.registerCivilization("Athens", "a polis", "direct-democracy", "deep-research", ["self"]);
  check("multi: civilization registered", multi.getAllCivilizations().length === 1);
  multi.joinCivilization(civ.id, "peerA");
  check("multi: brain joins as member", civ.memberBrainIds.has("peerA"));

  multi.createSociety("Academy", civ.id, "learning", ["self", "peerA"]);
  check("multi: society created under the civilization", multi.getSocieties(civ.id).length === 1);

  const civ2 = multi.registerCivilization("Sparta", "a rival", "dictatorship", "safety-first", ["peerB"]);
  multi.exchangeKnowledge(civ.id, civ2.id, ["geometry"], true);
  check("multi: knowledge exchange recorded", multi.getExchanges().length === 1);

  const conflict = multi.openConflict(civ.id, civ2.id, "border dispute");
  const resolved = multi.resolveConflict(conflict.id, "treaty signed");
  check("multi: conflict resolves", resolved?.status === "resolved");

  const serial = multi.getCivilizationsSerializable();
  check("multi: serializable view turns member Sets into arrays", Array.isArray(serial[0].memberBrainIds));
}

// -----------------------------------------------------------------------------
// (K) orchestrator wiring — every advanced subsystem reachable via getSystem().
//     Construction only (NO start()): no sockets bound, no timers scheduled.
// -----------------------------------------------------------------------------
{
  const orchestrator = new CivilizationOrchestrator();
  const sys = orchestrator.getSystem();
  const wired = [
    "network", "peerDiscovery", "socialCognition", "collectiveMemory", "governance",
    "resourceEconomy", "cultureEngine", "roleSpecialization", "collectiveGoals", "visualization",
    "trustReputation", "interBrainMemory", "emergentOrg", "collectiveImagination", "languageEvolution",
    "civilizationTwin", "simulation", "collectiveDreaming", "ethicsSafety", "multiCivilization",
  ] as const;
  const missing = wired.filter((k) => (sys as Record<string, unknown>)[k] === undefined);
  check("orchestrator: all 20 subsystems wired into getSystem()", missing.length === 0, missing.length ? `missing=[${missing.join(",")}]` : `count=${wired.length}`);
  check("orchestrator: starts not-running and exposes a twin snapshot", orchestrator.isRunning() === false && orchestrator.getTwin().civilizationId.length > 0);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
