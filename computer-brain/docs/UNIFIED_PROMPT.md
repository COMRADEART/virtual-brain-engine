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

## Cognitive Architecture Layer

Computer Brain must evolve beyond a tool-routing agent system into a true cognitive architecture.

The brain continuously performs:

1. Perception
2. Understanding
3. Planning
4. Execution
5. Reflection
6. Learning
7. Adaptation

This is the main intelligence loop:

```text
Perceive
    |
Understand
    |
Plan
    |
Execute
    |
Reflect
    |
Learn
    |
Adapt
    |
Repeat
```

Perception gathers filesystem activity, active applications, terminal output, browser activity, Git repositories, user requests, running workflows, agent events, system resources, and memory activity, then converts raw activity into structured observations.

Understanding loads context, retrieves relevant memories, detects intent, analyzes project state, identifies relationships, detects recurring patterns, and estimates confidence.

Planning generates explicit inspectable plans, chooses tools, assigns agents, estimates risk, prioritizes tasks, creates execution graphs, and evaluates permissions.

Execution performs actions through agents, tools, terminal access, APIs, workflows, and local models while logging outputs, retries, rollback awareness, and pause/resume state.

Reflection analyzes what succeeded, what failed, what was inefficient, what patterns appeared, and what can be learned.

Learning creates or improves skills, detects habits, optimizes execution, builds reusable abstractions, and improves planning quality.

Adaptation changes behavior dynamically by reducing notifications during focus mode, preferring local models when offline, switching workflows by project type, prioritizing frequently used tools, and changing execution strategy based on failure history.

New required crates:

- `perception-engine`
- `understanding-engine`
- `planning-engine`
- `reflection-engine`
- `learning-engine`
- `adaptation-engine`

## Consciousness Loop

The Computer Brain must include a persistent Consciousness Loop.

Every cycle should:

1. Observe current world state
2. Recall relevant memories
3. Detect user goals
4. Identify available tools and skills
5. Estimate risks
6. Create or update plans
7. Execute safe actions through agents
8. Reflect on results
9. Store new memories
10. Improve skills over time

The Consciousness Loop must be bounded by permissions, safety rules, user intent, current context, risk scoring, and audit logs.

Supported modes:

1. Passive: observe, store memory, and create summaries.
2. Assisted: propose plans and ask before acting.
3. Active: execute approved safe actions.
4. Autonomous: run trusted workflows only.

The brain must always know its current operating mode, and the user can switch modes at any time.

## Goal Stack

The brain maintains a goal stack.

Each goal includes:

- priority
- status
- owner agent
- required tools
- risk level
- memory links
- optional deadline

Example:

```text
Current Goal:
Fix Rust build

Subgoals:
1. Inspect project
2. Run cargo check
3. Analyze errors
4. Apply safe fix
5. Run tests
6. Summarize result
```

Goals and subgoals must be inspectable and persisted locally.

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

## OpenClaw + Hermes-Style Behavior

Computer Brain should combine two advanced agent patterns:

1. OpenClaw-style action system
2. Hermes-style self-learning memory and skill system

OpenClaw-inspired behavior:

- act across real computer tools
- use terminal access
- use browser automation
- use files and folders
- use APIs
- run scheduled tasks
- operate through chat, desktop pet, and command interface
- behave like an AI that can actually do things, not just answer questions

Hermes-inspired behavior:

- learn from repeated actions
- create reusable skills from experience
- improve skills over time
- persist knowledge across sessions
- build a long-term model of the user
- remember projects, preferences, tools, and workflows
- become more capable the longer it runs

Computer Brain should not copy these systems directly. It should implement the same class of capability in a Rust-based local-first architecture.

## Self-Improving Skill Loop

The brain must include a skill learning loop:

1. Observe action
2. Store result
3. Detect repeated workflow
4. Abstract workflow into a skill
5. Test skill safely
6. Store skill in Skill Memory
7. Reuse skill later
8. Improve skill from future results

Repeated actions such as opening a Rust project, running `cargo check`, inspecting compiler errors, fixing code, running `cargo test`, and summarizing results can become a reusable `Rust Project Repair Workflow`.

The skill stores trigger conditions, required tools, required permissions, execution graph, failure handling, memory references, and confidence score.

## Full-Time Agent Loop

The system should support a heartbeat loop like a persistent agent.

Heartbeat cycle:

1. Check current world state
2. Check scheduled tasks
3. Check active projects
4. Check pending workflows
5. Check memory updates
6. Decide whether action is needed
7. Ask permission when required
8. Execute through agents
9. Store result in memory

The agent should run continuously but safely.

It should never perform risky actions silently.

## Multi-Channel Control

The user should be able to control the brain from:

- desktop pet
- main dashboard
- terminal command
- local web UI
- optional Telegram/Discord/Slack bridge
- optional mobile chat bridge

All external channels must pass through the same safety layer.

## Action Capabilities

The brain should support terminal commands, project builds, test execution, file reading/writing with permission, Git inspection, browser automation, email/calendar integration later, API calls, local scripts, AI model calls, and scheduled tasks.

All actions must be planned, permission checked, logged, reversible where possible, and summarized into memory.

## Skill Memory Database

Add database tables for:

- `learned_skills`
- `skill_versions`
- `skill_runs`
- `skill_failures`
- `skill_permissions`
- `skill_triggers`
- `skill_confidence`
- `skill_improvements`

Each skill should evolve over time.

OpenClaw-style action gives the brain hands.

Hermes-style learning gives the brain growth.

Computer Brain must combine action, memory, skill evolution, safety, and desktop presence.

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
- reflections
- lessons
- execution outcomes
- skill evolution
- adaptation history
- workflow efficiency
- planning quality
- operating mode state
- goal stack
- consciousness cycles

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
