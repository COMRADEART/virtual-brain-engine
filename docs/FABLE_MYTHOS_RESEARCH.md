# Fable + Mythos — research note

Focused web research grounding the "make the brain think & execute more like Fable (fast/fluid)
and Mythos (narrative/identity)" upgrade. Used to finalize the F2 draft-selection method and the
M1 narrative-synthesis design.

## AXIS A — fast/fluid reasoning ("fable")

- **Self-consistency** samples N chain-of-thought paths and majority-votes the answer — but it
  needs a *closed-form, vote-able* answer, so it does not fit free-form reasoning plans.
  ([Self-Consistency, Medium](https://medium.com/@linz07m/self-consistency-a-better-approach-for-reasoning-in-llms-1a1b6798d443))
- **Universal Self-Consistency (USC)** re-prompts the model to pick the draft most consistent with
  the others — works for free-form output, no judge model — **but costs +1 LLM call per decision.**
  ([Self-Consistency Sampling](https://www.emergentmind.com/topics/self-consistency-sampling))
- **Embedding / lexical-similarity consensus** scores each draft by its **mean similarity to the
  other drafts** and picks the most central one. **Fully local, zero extra LLM calls** — the
  practical choice for a small local brain. ← **F2 selection method.**
  ([Self-Consistency Sampling](https://www.emergentmind.com/topics/self-consistency-sampling))
- **Self-certainty / Best-of-N** scores drafts by aggregated token log-probabilities (no extra
  calls) — but needs reliable logprobs, which the Ollama chat path doesn't surface cleanly, so we
  skip it. ([Scalable Best-of-N via Self-Certainty](https://arxiv.org/pdf/2502.18581))
- **BEST-Route / cascades / difficulty-aware routing**: *"generating multiple responses from small
  models and selecting the best can enhance quality while remaining cheaper than a single
  large-model response"* — directly validates **F2**. Cascades start cheap and **escalate only when
  confidence is insufficient** — directly validates **F1** (shallow→full salvage) and **F3**
  (difficulty-aware adaptive compute). ([BEST-Route](https://arxiv.org/abs/2506.22716),
  [Dynamic Model Routing & Cascading survey](https://arxiv.org/html/2603.04445v2))

**Design decisions:** F2 uses **local lexical consensus** (mean pairwise token-overlap, reusing
`tokens()` from `attention/saliency.ts`) — no judge, no logprobs, hermetically testable. F1 is the
cascade "escalate on weak signal" pattern. F3 is learned difficulty-aware routing with a no-regression floor.

## AXIS B — narrative self / identity ("mythos")

- **Generative Agents (Park et al. 2023)**: a memory stream retrieved by **recency × importance ×
  relevance**, plus periodic **reflection** — the agent *clusters related memories and synthesizes
  higher-order insights* ("Klaus has been eating alone and seems withdrawn"). A self-narrative is
  exactly a **reflection over the brain's identity material** (beliefs, goals, stage, competence,
  episodes). ← **M1 is a reflection step.**
  ([Generative Agents, ACM](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763),
  [Stanford architecture summary](https://www.subodhjena.com/blog/generative-agents-memory-stanford))
- **Narrative identity**: *"identity is narrative"* — organize life events into a coherent
  autobiographical structure, extract **themes**, integrate experiences into coherent
  self-understanding. ← validates M1's output shape: **identity / arc(themes) / values / pursuits.**
  ([Nature HSSC](https://www.nature.com/articles/s41599-025-06426-y),
  [Synthesizing the temporal self, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC11523108/))
- **Persistent-agent frameworks (Sophia)**: *"continuously evaluate each action against stored creed
  sentences to enforce narrative consistency."* ← validates **M3**: inject a compact first-person
  **creed/identity preamble** into the reasoning + response prompts to keep answers consistent with
  the self across sessions. ([Sophia](https://arxiv.org/pdf/2512.18202),
  [Persistent Identity in AI Agents](https://arxiv.org/pdf/2604.09588))

**Design decisions:** M1 = a sleep-time **reflection** that synthesizes `{identity, arc, values,
pursuits}` from beliefs/goals/stage/competence/episodes. M2 surfaces reflections as first-person
**inner monologue**. M3 injects a compact **creed preamble** (identity-grounded prompting) into the
hot-path prompts, length-bounded like `COGNITIVE_PRINCIPLES`.

## Confidence
Medium-high. Both axes rest on well-established, repeatedly-cited patterns (self-consistency family,
LLM cascades/routing, generative-agents reflection, narrative-identity theory). The novel part is
the *local-first, no-extra-LLM-call* adaptation, which the research explicitly supports as the cheap
path (embedding/lexical consensus; reflection during the existing sleep cycle).
