# Computer Brain Phase 2 Architecture

Phase 2 turns the Phase 1 assistant stack into a local-first cognitive nervous system. The implementation keeps the existing Brain Core, Tauri desktop shell, SQLite memory, event bus, agents, Ollama integration, file watcher, chat panel, and pet, then adds Rust crates for semantic memory, graph intelligence, temporal reasoning, workflow orchestration, autonomous scheduling, and personality.

## System Shape

```
Tauri UI
  Brain Dashboard
  Cortex Panel
  Semantic Search
  Knowledge Graph Viewer
  Memory Timeline
  Active Agents View
  Desktop Pet

Tauri Commands
  phase2_status
  semantic_memory_ingest/search
  knowledge_graph_snapshot
  context_engine_snapshot
  project_timeline_recent/record
  workflow_enqueue/next/complete/snapshot
  pet_personality_state/update
  autonomous_schedule_task/due

Phase 2 Rust Crates
  semantic-memory
  knowledge-graph
  context-engine
  temporal-engine
  workflow-engine
  personality-engine
  autonomous-runtime

SQLite Local Store
  memory_points
  memory_embeddings
  semantic_clusters
  graph_nodes / graph_edges
  context_snapshots
  project_timelines
  workflow_tasks / workflow_logs
  personality_states
  autonomous_tasks
  temporal_metadata
  memory_evolution_events
  project_milestones
```

## Crate Responsibilities

`semantic-memory`
- Embedding provider trait.
- Local hashed embedding provider for offline operation.
- Qdrant REST adapter for scalable vector storage.
- Semantic search, cosine scoring, lexical blending, importance boosts, and memory clustering.

`knowledge-graph`
- Nodes for projects, files, systems, concepts, agents, summaries, memories, bugs, commits, and discussions.
- Edges for containment, dependencies, implementation, mentions, derivation, related ideas, triggers, fixes, evolution, and ownership.
- Concept extraction and architecture snapshot support.

`context-engine`
- Builds context snapshots from active files, prompts, memories, project paths, and runtime signals.
- Detects likely intent, relevant tools, active files, and related memories.

`temporal-engine`
- Stores temporal events and project focus windows.
- Supports recent history, project focus reconstruction, recurring patterns, and memory decay scoring.

`workflow-engine`
- Priority task queue.
- Workflow definitions and event-triggered task chaining.
- Default observer to summary to memory to project to pet workflow.

`personality-engine`
- Persistent mood state: idle, focused, curious, excited, analyzing, assisting.
- Mood updates from workload, active agents, novelty, errors, and project context.

`autonomous-runtime`
- Persistent autonomous tasks.
- Interval/daily/weekly/once schedules.
- Tokio scheduler primitive for background due-task fanout.

## Database Updates

Phase 2 migrations are idempotent and run from Tauri startup. The new tables are:

- `memory_embeddings`: vector metadata and serialized vectors, with Qdrant point hook.
- `semantic_clusters`: cluster topics, memory IDs, centroids, and coherence.
- `graph_nodes`, `graph_edges`: local knowledge graph.
- `context_snapshots`: detected project/session context.
- `project_timelines`: time-ordered project intelligence events.
- `architecture_snapshots`: future architecture digests.
- `workflow_tasks`, `workflow_logs`: agent coordination queue and audit.
- `personality_states`: persistent pet mood/personality state.
- `autonomous_tasks`: scheduled local automations.
- `temporal_metadata`: access counts, last seen time, decay and importance data.
- `memory_evolution_events`: merge/compress/abstraction audit trail.
- `project_milestones`: durable project milestones.

## Event Flow

```
file/project activity
  -> temporal event
  -> workflow trigger
  -> SummaryAgent task
  -> MemoryAgent semantic indexing
  -> ProjectAgent graph update
  -> PetAgent notification
  -> personality state update
  -> UI and pet render live state
```

Semantic ingest also updates:

```
memory_points
memory_embeddings
graph_nodes / graph_edges
project_timelines
personality_states
```

## UI Design

The Phase 2 Cortex panel is embedded in the existing Brain OS panel and adds:

- Brain Dashboard stats.
- Semantic Search UI.
- Context inference readout.
- Knowledge Graph Viewer.
- Active Agents View.
- Memory Timeline.
- Memory capture and workflow queue actions.

The desktop pet now reads `pet_personality_state`, listens to agent events, and renders mood-specific colors, motion, focus level, and notifications.

## Implementation Roadmap

1. Foundation complete
   - Add seven Rust crates.
   - Add Phase 2 SQLite migrations.
   - Add Tauri-managed `Phase2System`.
   - Add Tauri commands for memory, graph, context, timeline, workflow, mood, and autonomous tasks.

2. Semantic memory depth
   - Connect configured Qdrant collection when available.
   - Add model-backed embeddings from Ollama/OpenAI-compatible local runtimes.
   - Persist and refresh semantic clusters.

3. Project intelligence
   - Emit timeline events from file watcher bursts and git activity.
   - Generate architecture snapshots from graph deltas.
   - Add milestone inference from summaries, commits, and recurring concepts.

4. Agent coordination
   - Bridge existing TypeScript agent bus to Rust workflow tasks.
   - Add permissions and safety policy per workflow action.
   - Add retry, backoff, cancellation, and workflow dependency constraints.

5. Memory evolution
   - Implement duplicate merge candidates from vector and hash similarity.
   - Compress older session memories into higher-level summaries.
   - Promote recurring themes into concept graph nodes.

6. Temporal reasoning
   - Add daily/weekly focus reports.
   - Add session playback metadata.
   - Expose "what changed last week" and "when did I modify X" commands.

7. Autonomous runtime
   - Start a Tokio background worker in Tauri setup.
   - Run nightly summary, weekly architecture digest, memory cleanup, and semantic indexing refresh.
   - Persist all automation outputs as timeline and memory events.

8. Advanced pet
   - Add recall popups, thought stream, and project status indicators.
   - Connect pet notifications to workflow logs and context snapshots.
   - Add mood preference learning from dismissed/accepted notifications.
