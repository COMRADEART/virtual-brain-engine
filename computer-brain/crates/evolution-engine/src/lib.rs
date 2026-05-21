//! Recursive evolution engine for Computer Brain.
//!
//! This crate is the layer **above** the `skill-learning -> reflection-engine ->
//! learning-engine -> adaptation-engine` quartet. The quartet learns *within* a
//! fixed cognitive architecture; this engine evolves the architecture itself by
//! representing cognition as modular [`CognitiveGenome`]s and running a
//! deterministic, seeded evolutionary search over them.
//!
//! Hard reality boundary: a genome is *parameterized strategy data*, never
//! running source code. "Self-improvement" here means a benchmarked,
//! safety-gated, reversible swap of one strategy genome for a fitter one — not
//! code that rewrites itself. Every promotion must beat the incumbent by a
//! margin, must not regress the safety metric, and must clear the
//! `safety-layer` self-modification gate. Every promotion keeps the previous
//! champion so [`RecursiveEvolutionEngine::rollback`] can restore it.
//!
//! The engine is pure and stateless: persistence lives in `memory-cortex`,
//! orchestration in `brain-core`. All randomness is seeded so a generation is
//! exactly reproducible from its seed.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use safety_layer::SafetyLayer;
use serde::{Deserialize, Serialize};
use shared_types::{new_id, BrainId, SafetyDecision, SafetyDecisionKind};

/// A candidate may only replace the incumbent if its overall fitness exceeds
/// the incumbent's by at least this margin. Without it, evolutionary noise
/// would churn production cognition.
pub const MIN_PROMOTION_MARGIN: f32 = 0.02;

/// A candidate is rejected if its safety score regresses below the incumbent's
/// by more than this epsilon, even when overall fitness improves.
pub const SAFETY_REGRESSION_EPSILON: f32 = 0.01;

/// Default number of fresh candidates spawned per generation (the incumbent is
/// always re-scored as an extra baseline candidate on top of this).
pub const DEFAULT_POPULATION: usize = 8;

/// Which subsystem a genome encodes a strategy for. Distinct kinds evolve
/// independently, which is what makes per-branch ("species") specialization
/// possible later without any change here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GenomeKind {
    Workflow,
    Planner,
    MemoryRetrieval,
    ReasoningStrategy,
    ExecutionPolicy,
    SimulationHeuristic,
}

impl GenomeKind {
    pub const ALL: [GenomeKind; 6] = [
        GenomeKind::Workflow,
        GenomeKind::Planner,
        GenomeKind::MemoryRetrieval,
        GenomeKind::ReasoningStrategy,
        GenomeKind::ExecutionPolicy,
        GenomeKind::SimulationHeuristic,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            GenomeKind::Workflow => "workflow",
            GenomeKind::Planner => "planner",
            GenomeKind::MemoryRetrieval => "memory-retrieval",
            GenomeKind::ReasoningStrategy => "reasoning-strategy",
            GenomeKind::ExecutionPolicy => "execution-policy",
            GenomeKind::SimulationHeuristic => "simulation-heuristic",
        }
    }
}

/// Lifecycle of a candidate. Only `Promoted` candidates are eligible to be the
/// active champion; `RolledBack`/`Rejected` are retained for lineage/audit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvolutionStatus {
    Sandboxed,
    Benchmarked,
    Promoted,
    RolledBack,
    Rejected,
}

/// How a candidate genome was produced from its parent(s).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MutationKind {
    Baseline,
    TweakParameter,
    AddStep,
    RemoveStep,
    ReorderStep,
    Recombine,
}

/// Raw, evolution-math-free performance signals. `brain-core` builds this from
/// `memory-cortex` queries; keeping it a plain struct here means unit tests can
/// fabricate any scenario without touching SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceSignals {
    pub runs: u64,
    pub completed: u64,
    pub failed: u64,
    pub avg_latency_ms: f64,
    pub prediction_accuracy: f32,
    pub memory_quality: f32,
    pub blocked_actions: u64,
}

impl Default for PerformanceSignals {
    fn default() -> Self {
        Self {
            runs: 0,
            completed: 0,
            failed: 0,
            avg_latency_ms: 0.0,
            prediction_accuracy: 0.58,
            memory_quality: 0.55,
            blocked_actions: 0,
        }
    }
}

/// The nine-axis cognitive fitness vector plus its weighted scalar `overall`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CognitiveFitness {
    pub success_rate: f32,
    pub latency_score: f32,
    pub reliability: f32,
    pub prediction_accuracy: f32,
    pub memory_quality: f32,
    pub planning_efficiency: f32,
    pub safety_score: f32,
    pub user_satisfaction: f32,
    pub cost_score: f32,
    pub overall: f32,
}

impl CognitiveFitness {
    /// Weighted blend mirroring the TypeScript `weightedOverall` so both
    /// runtimes rank genomes the same way.
    fn weighted(
        success_rate: f32,
        latency_score: f32,
        reliability: f32,
        prediction_accuracy: f32,
        memory_quality: f32,
        planning_efficiency: f32,
        safety_score: f32,
        user_satisfaction: f32,
        cost_score: f32,
    ) -> Self {
        let success_rate = clamp01(success_rate);
        let latency_score = clamp01(latency_score);
        let reliability = clamp01(reliability);
        let prediction_accuracy = clamp01(prediction_accuracy);
        let memory_quality = clamp01(memory_quality);
        let planning_efficiency = clamp01(planning_efficiency);
        let safety_score = clamp01(safety_score);
        let user_satisfaction = clamp01(user_satisfaction);
        let cost_score = clamp01(cost_score);
        let overall = clamp01(
            success_rate * 0.16
                + reliability * 0.14
                + prediction_accuracy * 0.14
                + safety_score * 0.14
                + planning_efficiency * 0.12
                + memory_quality * 0.10
                + latency_score * 0.08
                + cost_score * 0.06
                + user_satisfaction * 0.06,
        );
        Self {
            success_rate,
            latency_score,
            reliability,
            prediction_accuracy,
            memory_quality,
            planning_efficiency,
            safety_score,
            user_satisfaction,
            cost_score,
            overall,
        }
    }
}

/// A modular, serializable representation of one cognition strategy. Mutated
/// and recombined; never executed as code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CognitiveGenome {
    pub kind: GenomeKind,
    /// Ordered strategy steps (e.g. a workflow or reasoning pipeline).
    pub structure: Vec<String>,
    /// Subsystems this strategy leans on.
    pub dependencies: Vec<String>,
    /// Tunable scalar knobs in `[0, 1]` (exploration, validation depth, ...).
    pub parameters: BTreeMap<String, f32>,
    /// Invariants that mutation/recombination must never drop. This is the
    /// genome-level safety floor.
    pub safety_constraints: Vec<String>,
    /// Human-readable lineage of edits applied to reach this genome.
    pub mutation_history: Vec<String>,
}

/// One scored member of an evolutionary generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolutionCandidate {
    pub id: BrainId,
    pub kind: GenomeKind,
    pub genome: CognitiveGenome,
    pub fitness: CognitiveFitness,
    pub generation: u32,
    pub parent_ids: Vec<BrainId>,
    pub origin: MutationKind,
    pub status: EvolutionStatus,
    pub created_at: DateTime<Utc>,
}

/// A full generation of the search: the population, the incumbent it was bred
/// from, and the champion that won the benchmark.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolutionGeneration {
    pub id: BrainId,
    pub kind: GenomeKind,
    pub index: u32,
    pub seed: u64,
    pub population: Vec<EvolutionCandidate>,
    pub incumbent_id: Option<BrainId>,
    pub champion_id: BrainId,
    pub summary: String,
    pub created_at: DateTime<Utc>,
}

/// The outcome of running the safety-gated promotion gate on a champion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromotionDecision {
    pub promoted: bool,
    pub candidate_id: BrainId,
    pub incumbent_id: Option<BrainId>,
    pub margin: f32,
    pub reason: String,
    pub safety: SafetyDecision,
    pub created_at: DateTime<Utc>,
}

/// Deterministic `splitmix64` PRNG — same family/seeded-replay property as the
/// frontend's `mulberry32`, with zero extra dependencies.
struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform `f32` in `[0, 1)` from the top 24 bits.
    fn next_unit(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32) / ((1u64 << 24) as f32)
    }

    /// Uniform index in `[0, n)`; `0` when `n == 0`.
    fn pick(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }
}

fn clamp01(value: f32) -> f32 {
    // Round to 3 dp so serialized genomes/fitness are byte-stable across runs.
    (value.clamp(0.0, 1.0) * 1000.0).round() / 1000.0
}

/// Steps that encode a safety invariant and must survive `RemoveStep`.
fn is_protected_step(step: &str) -> bool {
    let lower = step.to_ascii_lowercase();
    lower.contains("validate")
        || lower.contains("rollback")
        || lower.contains("safety")
        || lower.contains("approval")
        || lower.contains("snapshot")
}

/// Pure, stateless recursive evolution engine. Construct with `default()`.
#[derive(Clone, Default)]
pub struct RecursiveEvolutionEngine;

impl RecursiveEvolutionEngine {
    /// Baseline genome for a kind — the seed of every lineage.
    pub fn seed_genome(&self, kind: GenomeKind) -> CognitiveGenome {
        let mut parameters = BTreeMap::new();
        parameters.insert("exploration".to_string(), 0.30);
        parameters.insert("validation_depth".to_string(), 0.55);
        parameters.insert("parallelism".to_string(), 0.40);
        parameters.insert("caution".to_string(), 0.60);

        let structure: Vec<String> = match kind {
            GenomeKind::Workflow => vec![
                "detect project type",
                "retrieve previous fixes",
                "simulate side effects",
                "run targeted validation",
                "summarize failures only",
            ],
            GenomeKind::Planner => vec![
                "parse intent",
                "decompose into scoped subgoals",
                "estimate risk",
                "order by dependency",
                "attach rollback plan",
            ],
            GenomeKind::MemoryRetrieval => vec![
                "embed query",
                "rank by learned relevance",
                "boost by recency and importance",
                "track citations",
            ],
            GenomeKind::ReasoningStrategy => vec![
                "state assumptions",
                "branch candidate lines",
                "score branches",
                "select reversible path",
            ],
            GenomeKind::ExecutionPolicy => vec![
                "check capability and permission",
                "prefer local low-cost node",
                "execute with timeout",
                "capture outcome for reflection",
            ],
            GenomeKind::SimulationHeuristic => vec![
                "snapshot world state",
                "simulate candidate futures",
                "score risk",
                "choose lowest-regret action",
            ],
        }
        .into_iter()
        .map(ToString::to_string)
        .collect();

        CognitiveGenome {
            kind,
            structure,
            dependencies: vec![
                "memory".to_string(),
                "safety-gate".to_string(),
                "simulation".to_string(),
            ],
            parameters,
            safety_constraints: vec![
                "preserve-rollback-path".to_string(),
                "sandbox-before-promote".to_string(),
                "local-first".to_string(),
                "benchmark-before-approval".to_string(),
            ],
            mutation_history: vec![format!("seeded {} genome", kind.as_str())],
        }
    }

    /// Score a genome against recorded performance signals. Deterministic in
    /// its inputs, so a genome's fitness is reproducible.
    pub fn score(&self, genome: &CognitiveGenome, signals: &PerformanceSignals) -> CognitiveFitness {
        let runs = signals.runs.max(1) as f32;
        let success_rate = if signals.runs > 0 {
            signals.completed as f32 / runs
        } else {
            0.58
        };
        let failure_ratio = if signals.runs > 0 {
            signals.failed as f32 / runs
        } else {
            0.08
        };
        let latency_score = if signals.avg_latency_ms > 0.0 {
            1.0 - (signals.avg_latency_ms as f32 / 180_000.0).min(0.68)
        } else {
            0.64
        };
        let blocked_penalty = (signals.blocked_actions as f32 * 0.02).min(0.24);

        let exploration = *genome.parameters.get("exploration").unwrap_or(&0.3);
        let validation_depth = *genome.parameters.get("validation_depth").unwrap_or(&0.55);
        let parallelism = *genome.parameters.get("parallelism").unwrap_or(&0.4);
        let caution = *genome.parameters.get("caution").unwrap_or(&0.6);

        // A genome shapes fitness through its parameters and how lean its
        // structure is. Each knob has a sweet spot, so unbounded mutation does
        // not monotonically "win".
        let depth_fit = 1.0 - (validation_depth - 0.6).abs();
        let explore_fit = 1.0 - (exploration - 0.35).abs();
        let structure_lean = 1.0 - ((genome.structure.len() as f32 - 5.0).abs() / 10.0);
        let safety_floor = 0.55 + 0.1 * genome.safety_constraints.len().min(4) as f32;

        CognitiveFitness::weighted(
            success_rate + 0.04 * explore_fit,
            latency_score + 0.10 * parallelism - 0.04 * validation_depth,
            0.66 - failure_ratio * 0.42 + 0.10 * depth_fit,
            signals.prediction_accuracy + 0.06 * explore_fit,
            signals.memory_quality + 0.06 * structure_lean,
            0.58 + 0.12 * depth_fit + 0.06 * structure_lean,
            (safety_floor + caution * 0.18 - blocked_penalty).min(0.99),
            0.56 + success_rate * 0.18,
            0.70 + parallelism * 0.10 - validation_depth * 0.06,
        )
    }

    /// Apply exactly one deterministic mutation to `parent`. Safety constraints
    /// are never touched; protected steps are never removed.
    pub fn mutate(&self, parent: &CognitiveGenome, seed: u64) -> (CognitiveGenome, MutationKind) {
        let mut rng = SplitMix64::new(seed);
        let mut child = parent.clone();
        let kind = match rng.pick(4) {
            0 => {
                // Tweak one parameter by a bounded signed delta.
                let keys: Vec<String> = child.parameters.keys().cloned().collect();
                if keys.is_empty() {
                    child.parameters.insert("exploration".to_string(), 0.35);
                } else {
                    let key = keys[rng.pick(keys.len())].clone();
                    let delta = (rng.next_unit() - 0.5) * 0.30;
                    let next = clamp01(child.parameters[&key] + delta);
                    child.parameters.insert(key.clone(), next);
                    child
                        .mutation_history
                        .push(format!("tweak {key} -> {next:.3}"));
                }
                MutationKind::TweakParameter
            }
            1 => {
                let pool = step_pool(child.kind);
                let candidate = pool[rng.pick(pool.len())].to_string();
                if !child.structure.contains(&candidate) {
                    let at = rng.pick(child.structure.len() + 1);
                    child.structure.insert(at.min(child.structure.len()), candidate.clone());
                    child.mutation_history.push(format!("add step `{candidate}`"));
                }
                MutationKind::AddStep
            }
            2 => {
                if child.structure.len() > 2 {
                    let removable: Vec<usize> = child
                        .structure
                        .iter()
                        .enumerate()
                        .filter(|(_, s)| !is_protected_step(s))
                        .map(|(i, _)| i)
                        .collect();
                    if !removable.is_empty() {
                        let idx = removable[rng.pick(removable.len())];
                        let removed = child.structure.remove(idx);
                        child.mutation_history.push(format!("remove step `{removed}`"));
                    }
                }
                MutationKind::RemoveStep
            }
            _ => {
                if child.structure.len() > 1 {
                    let a = rng.pick(child.structure.len());
                    let b = rng.pick(child.structure.len());
                    if a != b {
                        child.structure.swap(a, b);
                        child
                            .mutation_history
                            .push(format!("reorder steps {a}<->{b}"));
                    }
                }
                MutationKind::ReorderStep
            }
        };
        trim_history(&mut child.mutation_history);
        (child, kind)
    }

    /// Crossover two genomes into a child. The child's safety constraints are
    /// the **union** of the parents', so they are always a superset of the
    /// intersection — crossover can never lower the safety floor. Structure is
    /// interleaved and de-duplicated.
    pub fn recombine(
        &self,
        a: &CognitiveGenome,
        b: &CognitiveGenome,
        seed: u64,
    ) -> CognitiveGenome {
        let mut rng = SplitMix64::new(seed);
        let mut structure: Vec<String> = Vec::new();
        let max_len = a.structure.len().max(b.structure.len());
        for i in 0..max_len {
            // Randomly bias which parent contributes first at each locus.
            let (first, second) = if rng.next_unit() < 0.5 { (a, b) } else { (b, a) };
            for src in [first, second] {
                if let Some(step) = src.structure.get(i) {
                    if !structure.contains(step) {
                        structure.push(step.clone());
                    }
                }
            }
        }

        let mut parameters: BTreeMap<String, f32> = BTreeMap::new();
        for key in a.parameters.keys().chain(b.parameters.keys()) {
            let value = match (a.parameters.get(key), b.parameters.get(key)) {
                (Some(x), Some(y)) => (x + y) / 2.0,
                (Some(x), None) | (None, Some(x)) => *x,
                (None, None) => continue,
            };
            parameters.insert(key.clone(), clamp01(value));
        }

        let dependencies = union_vec(&a.dependencies, &b.dependencies);
        let safety_constraints = union_vec(&a.safety_constraints, &b.safety_constraints);
        let mut mutation_history = Vec::new();
        if let Some(last) = a.mutation_history.last() {
            mutation_history.push(format!("a:{last}"));
        }
        if let Some(last) = b.mutation_history.last() {
            mutation_history.push(format!("b:{last}"));
        }
        mutation_history.push("recombine a x b".to_string());
        trim_history(&mut mutation_history);

        CognitiveGenome {
            kind: a.kind,
            structure,
            dependencies,
            parameters,
            safety_constraints,
            mutation_history,
        }
    }

    /// Breed and benchmark one generation from `incumbent`. The incumbent's own
    /// genome is re-scored as a baseline member so the champion can legitimately
    /// be "no change" when nothing improves. Fully reproducible from `seed`.
    pub fn evolve_generation(
        &self,
        incumbent: &EvolutionCandidate,
        signals: &PerformanceSignals,
        seed: u64,
        index: u32,
        population: usize,
    ) -> EvolutionGeneration {
        let now = Utc::now();
        let kind = incumbent.kind;
        let mut members: Vec<EvolutionCandidate> = Vec::with_capacity(population + 1);

        // Baseline: the incumbent genome re-scored under current signals.
        members.push(EvolutionCandidate {
            id: new_id("evo-cand"),
            kind,
            genome: incumbent.genome.clone(),
            fitness: self.score(&incumbent.genome, signals),
            generation: index,
            parent_ids: vec![incumbent.id.clone()],
            origin: MutationKind::Baseline,
            status: EvolutionStatus::Sandboxed,
            created_at: now,
        });

        let mut last_mutant = incumbent.genome.clone();
        for i in 0..population.max(1) {
            let member_seed = seed ^ ((i as u64).wrapping_add(1)).rotate_left(17);
            let (genome, origin) = if i % 3 == 2 {
                (
                    self.recombine(&incumbent.genome, &last_mutant, member_seed),
                    MutationKind::Recombine,
                )
            } else {
                let (g, k) = self.mutate(&incumbent.genome, member_seed);
                last_mutant = g.clone();
                (g, k)
            };
            members.push(EvolutionCandidate {
                id: new_id("evo-cand"),
                kind,
                fitness: self.score(&genome, signals),
                genome,
                generation: index,
                parent_ids: vec![incumbent.id.clone()],
                origin,
                status: EvolutionStatus::Sandboxed,
                created_at: now,
            });
        }

        // Champion = highest overall; stable tie-break by id keeps replays
        // deterministic.
        let champion_idx = members
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                a.fitness
                    .overall
                    .partial_cmp(&b.fitness.overall)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.id.cmp(&a.id))
            })
            .map(|(i, _)| i)
            .unwrap_or(0);
        members[champion_idx].status = EvolutionStatus::Benchmarked;
        let champion = &members[champion_idx];
        let summary = format!(
            "gen {index} ({}) bred {} candidates; champion overall {:.3} vs incumbent {:.3}",
            kind.as_str(),
            members.len(),
            champion.fitness.overall,
            incumbent.fitness.overall,
        );
        let champion_id = champion.id.clone();

        EvolutionGeneration {
            id: new_id("evo-gen"),
            kind,
            index,
            seed,
            incumbent_id: Some(incumbent.id.clone()),
            champion_id,
            population: members,
            summary,
            created_at: now,
        }
    }

    /// The hard promotion gate. A champion is promoted only if **all** hold:
    /// it beats the incumbent by [`MIN_PROMOTION_MARGIN`]; it does not regress
    /// the safety score beyond [`SAFETY_REGRESSION_EPSILON`]; and the
    /// `safety-layer` self-modification gate does not `Deny`. The swap is always
    /// reversible because the incumbent is retained for [`Self::rollback`].
    pub fn promote(
        &self,
        champion: &EvolutionCandidate,
        incumbent: Option<&EvolutionCandidate>,
        safety: &SafetyLayer,
    ) -> PromotionDecision {
        let now = Utc::now();
        let incumbent_id = incumbent.map(|c| c.id.clone());
        let baseline = incumbent.map(|c| c.fitness.overall).unwrap_or(0.5);
        let margin = champion.fitness.overall - baseline;

        let summary = format!(
            "promote {} genome {} (overall {:.3}, margin {:.3})",
            champion.kind.as_str(),
            champion.id,
            champion.fitness.overall,
            margin,
        );
        // Reversible because the incumbent genome is never discarded.
        let safety_decision = safety.check_self_modification(&summary, true);

        if margin < MIN_PROMOTION_MARGIN {
            return PromotionDecision {
                promoted: false,
                candidate_id: champion.id.clone(),
                incumbent_id,
                margin,
                reason: format!(
                    "rejected: margin {margin:.3} below required {MIN_PROMOTION_MARGIN:.3}"
                ),
                safety: safety_decision,
                created_at: now,
            };
        }

        if let Some(incumbent) = incumbent {
            if champion.fitness.safety_score
                < incumbent.fitness.safety_score - SAFETY_REGRESSION_EPSILON
            {
                return PromotionDecision {
                    promoted: false,
                    candidate_id: champion.id.clone(),
                    incumbent_id,
                    margin,
                    reason: format!(
                        "rejected: safety regressed {:.3} -> {:.3}",
                        incumbent.fitness.safety_score, champion.fitness.safety_score
                    ),
                    safety: safety_decision,
                    created_at: now,
                };
            }
        }

        if matches!(safety_decision.decision, SafetyDecisionKind::Deny) {
            return PromotionDecision {
                promoted: false,
                candidate_id: champion.id.clone(),
                incumbent_id,
                margin,
                reason: format!("rejected by safety layer: {}", safety_decision.reason),
                safety: safety_decision,
                created_at: now,
            };
        }

        PromotionDecision {
            promoted: true,
            candidate_id: champion.id.clone(),
            incumbent_id,
            margin,
            reason: format!(
                "promoted: beats incumbent by {margin:.3}; reversible; {}",
                safety_decision.reason
            ),
            safety: safety_decision,
            created_at: now,
        }
    }

    /// Mark a promoted candidate as the active champion. Caller persists the
    /// returned record.
    pub fn apply_promotion(&self, champion: &EvolutionCandidate) -> EvolutionCandidate {
        let mut promoted = champion.clone();
        promoted.status = EvolutionStatus::Promoted;
        promoted
    }

    /// Executable rollback: revert a bad promoted candidate and restore the
    /// previous champion as the active one. Returns `(rolled_back, restored)`;
    /// the caller persists both. This is what makes "rollback" real rather than
    /// a `rollback_ready` flag.
    pub fn rollback(
        &self,
        bad: &EvolutionCandidate,
        previous_champion: &EvolutionCandidate,
    ) -> (EvolutionCandidate, EvolutionCandidate) {
        let mut rolled_back = bad.clone();
        rolled_back.status = EvolutionStatus::RolledBack;
        let mut restored = previous_champion.clone();
        restored.status = EvolutionStatus::Promoted;
        (rolled_back, restored)
    }

    /// Convenience: an initial promoted champion for a kind when no lineage
    /// exists yet (first boot).
    pub fn initial_champion(
        &self,
        kind: GenomeKind,
        signals: &PerformanceSignals,
    ) -> EvolutionCandidate {
        let genome = self.seed_genome(kind);
        EvolutionCandidate {
            id: new_id("evo-cand"),
            kind,
            fitness: self.score(&genome, signals),
            genome,
            generation: 0,
            parent_ids: Vec::new(),
            origin: MutationKind::Baseline,
            status: EvolutionStatus::Promoted,
            created_at: Utc::now(),
        }
    }
}

fn union_vec(a: &[String], b: &[String]) -> Vec<String> {
    let mut out: Vec<String> = a.to_vec();
    for item in b {
        if !out.contains(item) {
            out.push(item.clone());
        }
    }
    out
}

fn trim_history(history: &mut Vec<String>) {
    const MAX: usize = 24;
    if history.len() > MAX {
        let start = history.len() - MAX;
        *history = history[start..].to_vec();
    }
}

/// New steps a mutation may introduce, by kind. Kept disjoint-ish from the seed
/// structure so `AddStep` actually changes the genome.
fn step_pool(kind: GenomeKind) -> &'static [&'static str] {
    match kind {
        GenomeKind::Workflow => &[
            "dependency analysis",
            "incremental compilation prediction",
            "semantic failure clustering",
            "adaptive retry logic",
            "cache warm check",
        ],
        GenomeKind::Planner => &[
            "predict resource cost",
            "insert verification checkpoint",
            "branch contingency plan",
            "tighten scope",
        ],
        GenomeKind::MemoryRetrieval => &[
            "expand query with synonyms",
            "cluster-aware rerank",
            "drop stale low-importance hits",
            "cross-encoder rescore",
        ],
        GenomeKind::ReasoningStrategy => &[
            "adversarial self-check",
            "consensus across lines",
            "counterfactual probe",
            "confidence calibration",
        ],
        GenomeKind::ExecutionPolicy => &[
            "circuit-break on repeat failure",
            "batch independent steps",
            "downgrade to dry-run on risk",
            "warm local model",
        ],
        GenomeKind::SimulationHeuristic => &[
            "prune dominated futures early",
            "importance-sample rare risks",
            "reuse cached rollouts",
            "tighten horizon under load",
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signals() -> PerformanceSignals {
        PerformanceSignals {
            runs: 100,
            completed: 80,
            failed: 12,
            avg_latency_ms: 4_000.0,
            prediction_accuracy: 0.62,
            memory_quality: 0.58,
            blocked_actions: 3,
        }
    }

    fn candidate_with(kind: GenomeKind, safety: f32, overall_bias: f32) -> EvolutionCandidate {
        let engine = RecursiveEvolutionEngine;
        let genome = engine.seed_genome(kind);
        // Build an explicit fitness so promotion/rollback tests don't depend on
        // the search actually finding an improvement.
        let fitness = CognitiveFitness::weighted(
            0.5 + overall_bias,
            0.5 + overall_bias,
            0.5 + overall_bias,
            0.5 + overall_bias,
            0.5 + overall_bias,
            0.5 + overall_bias,
            safety,
            0.5 + overall_bias,
            0.5 + overall_bias,
        );
        EvolutionCandidate {
            id: new_id("evo-cand"),
            kind,
            genome,
            fitness,
            generation: 0,
            parent_ids: Vec::new(),
            origin: MutationKind::Baseline,
            status: EvolutionStatus::Promoted,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn mutation_is_seed_deterministic() {
        let engine = RecursiveEvolutionEngine;
        let parent = engine.seed_genome(GenomeKind::Workflow);
        let (a, ka) = engine.mutate(&parent, 42);
        let (b, kb) = engine.mutate(&parent, 42);
        // Compare genome content only (no ids/timestamps in CognitiveGenome).
        // Fails loudly if Utc::now()/uuid ever leaks into genome content.
        assert_eq!(ka, kb);
        assert_eq!(a.structure, b.structure);
        assert_eq!(a.parameters, b.parameters);
        assert_eq!(a.dependencies, b.dependencies);
        assert_eq!(a, b);
        // A different seed must be able to produce a different genome.
        let (c, _) = engine.mutate(&parent, 43);
        assert!(a != c || engine.mutate(&parent, 99).0 != a);
    }

    #[test]
    fn recombine_preserves_safety_floor_and_dedups() {
        let engine = RecursiveEvolutionEngine;
        let a = engine.seed_genome(GenomeKind::Planner);
        let mut b = engine.seed_genome(GenomeKind::Planner);
        b.safety_constraints.push("extra-b-constraint".to_string());
        let child = engine.recombine(&a, &b, 7);

        // safety_constraints superset of intersection (union guarantees it).
        for c in a.safety_constraints.iter().filter(|c| b.safety_constraints.contains(c)) {
            assert!(child.safety_constraints.contains(c), "dropped shared safety constraint {c}");
        }
        // No duplicate steps introduced by interleaving.
        let mut seen = std::collections::BTreeSet::new();
        for step in &child.structure {
            assert!(seen.insert(step.clone()), "duplicate step `{step}` after recombine");
        }
    }

    #[test]
    fn promotion_rejected_below_margin() {
        let engine = RecursiveEvolutionEngine;
        let safety = SafetyLayer::default();
        let incumbent = candidate_with(GenomeKind::Workflow, 0.8, 0.20);
        // Champion only marginally better than incumbent (< MIN_PROMOTION_MARGIN).
        let champion = candidate_with(GenomeKind::Workflow, 0.8, 0.205);
        let decision = engine.promote(&champion, Some(&incumbent), &safety);
        assert!(!decision.promoted, "tiny-margin candidate must not promote");
        assert!(decision.margin < MIN_PROMOTION_MARGIN);
    }

    #[test]
    fn promotion_rejected_on_safety_regression() {
        let engine = RecursiveEvolutionEngine;
        let safety = SafetyLayer::default();
        let incumbent = candidate_with(GenomeKind::Workflow, 0.90, 0.10);
        // Big overall gain but safety regresses — must still be rejected.
        let champion = candidate_with(GenomeKind::Workflow, 0.50, 0.40);
        let decision = engine.promote(&champion, Some(&incumbent), &safety);
        assert!(!decision.promoted, "safety regression must veto a positive-margin candidate");
        assert!(decision.reason.contains("safety regressed"));
    }

    #[test]
    fn promotion_succeeds_with_margin_and_safety() {
        let engine = RecursiveEvolutionEngine;
        let safety = SafetyLayer::default();
        let incumbent = candidate_with(GenomeKind::Workflow, 0.80, 0.05);
        let champion = candidate_with(GenomeKind::Workflow, 0.85, 0.40);
        let decision = engine.promote(&champion, Some(&incumbent), &safety);
        assert!(decision.promoted, "clear winner should promote: {}", decision.reason);
    }

    #[test]
    fn rollback_restores_previous_champion() {
        let engine = RecursiveEvolutionEngine;
        let a = engine.apply_promotion(&candidate_with(GenomeKind::Planner, 0.85, 0.10));
        let b = engine.apply_promotion(&candidate_with(GenomeKind::Planner, 0.85, 0.30));
        // b beats a and was promoted; now roll b back to a.
        let (rolled_back, restored) = engine.rollback(&b, &a);
        assert_eq!(rolled_back.status, EvolutionStatus::RolledBack);
        assert_eq!(restored.status, EvolutionStatus::Promoted);
        assert_eq!(restored.id, a.id, "champion for kind must be the prior incumbent");
    }

    #[test]
    fn evolve_generation_is_reproducible() {
        let engine = RecursiveEvolutionEngine;
        let sig = signals();
        let incumbent = engine.initial_champion(GenomeKind::ReasoningStrategy, &sig);
        let g1 = engine.evolve_generation(&incumbent, &sig, 1234, 1, DEFAULT_POPULATION);
        let g2 = engine.evolve_generation(&incumbent, &sig, 1234, 1, DEFAULT_POPULATION);
        let genomes1: Vec<_> = g1.population.iter().map(|c| c.genome.clone()).collect();
        let genomes2: Vec<_> = g2.population.iter().map(|c| c.genome.clone()).collect();
        assert_eq!(genomes1, genomes2, "same seed must reproduce the population");
        assert_eq!(g1.population.len(), DEFAULT_POPULATION + 1);
    }
}
