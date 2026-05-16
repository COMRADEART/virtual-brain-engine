# Computer Brain Unified Prompt

You are a world-class systems architect, Rust engineer, AI infrastructure engineer, cognitive systems designer, and autonomous agent runtime developer.

Your task is to design and build a next-generation local-first cognitive operating layer called:

`COMPUTER BRAIN`

This is not a chatbot, a simple AI assistant, a wrapper around LLM APIs, or a normal automation tool.

This is a persistent cognitive runtime for a computer.

The system acts like a synthetic brain layered over the operating system.

- The computer becomes the body.
- Memory becomes thought.
- Agents become movement.
- Tools become organs.
- The desktop pet becomes the visible personality.
- The Brain Core becomes the mind.
- The event bus becomes the nervous system.
- The safety layer becomes conscience.

The goal is to create a true AI nervous system for the computer.

## Core Philosophy

The system should function like a living cognitive architecture.

The brain should observe, remember, reason, plan, execute, learn, and evolve.

The brain should build an understanding of the computer, projects, user workflows, installed tools, coding habits, recurring tasks, and available capabilities.

The system should become a cognitive layer above the OS.

## High-Level Goal

Build a Rust-based local-first AI nervous system capable of:

1. Observing laptop activity
2. Understanding projects deeply
3. Building semantic memory
4. Running autonomous workflows
5. Executing terminal commands safely
6. Coordinating multiple agents
7. Learning workflows over time
8. Building project intelligence
9. Creating long-term memory
10. Maintaining world-state awareness
11. Providing a desktop companion/pet
12. Acting as a cognitive operating runtime

## Core Architecture

Build the system using these major layers:

1. Brain Core
2. Nervous System Event Bus
3. Cognitive State Engine
4. Memory Cortex
5. Context Engine
6. Planner Engine
7. Execution Graph Runtime
8. Agent Runtime
9. Capability System
10. Tool Cortex
11. Sensory System
12. Personality Engine
13. Safety Layer
14. Desktop Pet Layer
15. Observability System

## Tech Stack

Mandatory core stack:

- Rust stable
- Tokio
- serde
- tracing
- anyhow
- async_trait
- reqwest
- sqlx or rusqlite

Desktop:

- Tauri v2
- React
- Vite
- TailwindCSS
- Framer Motion

Memory:

- SQLite
- Qdrant or ChromaDB
- embeddings support

System:

- notify
- sysinfo
- `tokio::process`
- Git integration

AI:

- Ollama
- local GGUF support optional
- OpenAI abstraction
- Claude abstraction
- Gemini abstraction

Optional:

- Python plugin execution
- Three.js visualization

## Rust Workspace Structure

```text
computer-brain/
├── Cargo.toml
├── crates/
│   ├── shared-types/
│   ├── brain-core/
│   ├── nervous-system/
│   ├── cognitive-state/
│   ├── memory-cortex/
│   ├── semantic-memory/
│   ├── context-engine/
│   ├── planner-engine/
│   ├── execution-graph/
│   ├── agent-runtime/
│   ├── capability-system/
│   ├── workflow-engine/
│   ├── knowledge-graph/
│   ├── temporal-engine/
│   ├── sensory-system/
│   ├── tool-cortex/
│   ├── personality-engine/
│   ├── safety-layer/
│   ├── observability/
│   └── desktop-bridge/
├── apps/
│   └── desktop-pet/
├── config/
├── data/
├── docs/
├── scripts/
└── tests/
```

## System Body Map

On installation, the Computer Brain should safely scan and understand the system.

Build a `System Body Map`.

The brain should detect installed tools, languages, terminals, project folders, Git repositories, local AI models, developer environments, APIs, build systems, and active applications.

This becomes the brain's understanding of its body.

## World State Model

Maintain a live runtime world state.

```rust
WorldState {
    active_project,
    active_window,
    running_apps,
    active_agents,
    pending_tasks,
    current_focus,
    system_load,
    available_tools,
    current_context,
    recent_memories,
}
```

The world model must update continuously.

## Cognitive State Engine

The brain must maintain cognitive states:

- Idle
- Observing
- Learning
- Focused
- Planning
- Executing
- Analyzing
- WaitingApproval
- Recovering

These states affect agent behavior, memory prioritization, pet mood, notifications, and execution flow.

## Event-Driven Nervous System

Everything must be event-driven.

All activity becomes events, including file changes, project opens, command execution, memory creation, generated summaries, agent triggers, failed tasks, and created plans.

Use Tokio broadcast channels, event replay, append-only logs, and async event streams.

## Memory Cortex

Memory is the thought process.

Implement raw event memory, session memory, project memory, long-term memory, semantic memory, skill memory, and temporal memory.

Every memory entry includes timestamp, project, summary, embedding, importance, confidence, tags, and related memories.

Memory hierarchy:

```text
Raw Events
    ↓
Session Summaries
    ↓
Project Knowledge
    ↓
Long-Term Understanding
```

The system should compress and evolve memories over time.

## Semantic Memory

Implement embeddings, semantic search, memory clustering, similarity matching, and concept linking.

The brain should retrieve relevant memories automatically.

## Knowledge Graph

Create a project intelligence graph.

Track relationships between projects, files, workflows, bugs, commits, summaries, memories, systems, and tools.

The graph should evolve over time.

## Planner Engine

Do not allow agents to act randomly.

All actions must pass through intent parsing, context loading, memory retrieval, planning, and execution graph generation.

Execution flow:

```text
User Request
    ↓
Context Engine
    ↓
Memory Recall
    ↓
Planner
    ↓
Execution Graph
    ↓
Agents
    ↓
Tools
```

## Execution Graph Runtime

Tasks must execute as graphs.

Support retries, pause/resume, recovery, parallel execution, and workflow replay.

## Capability System

Do not hardcode behavior into agents. Use capabilities.

Examples:

- `filesystem.read`
- `terminal.execute`
- `git.inspect`
- `memory.retrieve`
- `memory.store`
- `summarize.code`
- `graph.query`

Agents dynamically use capabilities.

## Agent System

Agents are movement systems. Agents execute plans.

Implement:

1. ObserverAgent
2. SummaryAgent
3. MemoryAgent
4. SemanticMemoryAgent
5. PlannerAgent
6. ProjectAgent
7. ContextAgent
8. ToolRouterAgent
9. CommandAgent
10. WorkflowAgent
11. SchedulerAgent
12. SafetyAgent
13. PetAgent

Every agent subscribes to events, communicates through the event bus, logs actions, uses capabilities, and follows safety rules.

## Terminal Access

The brain may execute terminal commands safely through `CommandAgent` only.

Requirements:

- `tokio::process::Command`
- command allowlist
- denylist
- user approval system
- audit logging
- timeout handling
- stdout/stderr capture
- per-project permissions
- rollback awareness where possible

The AI never executes commands directly.

## Skill Learning System

The brain should learn workflows.

Repeated workflows such as `cargo check`, `cargo test`, and `cargo run` can become reusable skills like `Rust Validation Skill`.

The brain should detect recurring workflows, abstract reusable skills, store automation patterns, and improve over time.

## Personality Engine

The desktop pet should evolve personality.

Track habits, workflows, preferred tools, activity patterns, and coding styles.

Pet moods:

- focused
- curious
- assisting
- analyzing
- idle
- learning

The pet reacts to workload, project state, memory activity, and agent activity.

## Desktop Pet

Build with Tauri, React, transparent windows, always-on-top behavior, and draggable UI.

Features:

- floating assistant
- quick chat
- notifications
- memory recall
- project reminders
- thinking animations
- active task display

The pet is not the main UI.

## Main UI Requirements

Build:

1. Brain Dashboard
2. Memory Timeline
3. Semantic Search
4. Knowledge Graph Viewer
5. Active Agents Panel
6. Workflow Inspector
7. Event Stream Viewer
8. Context Viewer
9. System Body Map
10. Tool Capability Panel
11. Safety Permissions Panel

## Observability System

Implement event tracing, agent monitoring, workflow graphs, memory inspection, reasoning traces, model latency, command logs, and task history.

Without observability, the system is not debuggable.

## Safety + Privacy

Mandatory:

- local-first design
- encrypted secrets
- no silent cloud uploads
- explicit permission system
- audit logs
- safe command execution
- project-level permissions

## Database Requirements

Create SQLite schema for:

- memories
- semantic memories
- projects
- workflows
- graph nodes
- graph edges
- events
- tasks
- skills
- permissions
- pet states
- context snapshots
- command logs
- audit logs

## Implementation Requirements

Generate:

1. Full architecture
2. Cargo workspace
3. Rust crate implementations
4. Database schema
5. Event system
6. Agent runtime
7. Planner engine
8. Execution graph runtime
9. Memory systems
10. Semantic search
11. Knowledge graph
12. Context engine
13. Skill learning system
14. Command system
15. Safety layer
16. Desktop pet
17. React UI
18. Tauri integration
19. Observability system
20. Step-by-step implementation roadmap

Do not simplify this into a chatbot.

Build it as a true cognitive operating layer and local AI nervous system for the computer.
