# Computer Brain Architecture

Computer Brain is a local-first AI nervous system for a laptop. It is not a chatbot shell: the chat panel is one interface into a persistent event-driven system made of agents, memory, project intelligence, tool routing, and a desktop pet.

## Runtime Flow

```
Sensory System
  file watcher, process monitor, git detector
      |
      v
Tokio Nervous System Event Bus
      |
      +--> ObserverAgent
      +--> ContextAgent
      +--> SummaryAgent
      +--> MemoryAgent
      +--> SemanticMemoryAgent
      +--> ProjectAgent
      +--> WorkflowAgent
      +--> ToolRouterAgent
      +--> CommandAgent
      +--> SchedulerAgent
      +--> PetAgent
      +--> SafetyAgent
      |
      v
Memory Cortex + Semantic Memory + Knowledge Graph + Timeline
      |
      v
Tauri Desktop Bridge
      |
      v
React UI + Floating Pet
```

## Crates

- `shared-types`: common events, records, IDs, agent state, tool calls, graph DTOs.
- `nervous-system`: Tokio broadcast event bus, event log, task messages.
- `cognitive-state`: live world state, cognitive mode, system body map, onboarding scanner.
- `agent-runtime`: custom Rust `Agent` trait, capabilities, registry, lifecycle runtime.
- `memory-cortex`: SQLite schema and structured memory/session/project/event/task/audit storage.
- `semantic-memory`: local hashed embeddings, vector search, semantic clustering.
- `knowledge-graph`: project/file/system/concept/bug/fix graph upserts and traversal.
- `context-engine`: active project, intent, related memory and tool detection.
- `planner-engine`: intent parsing and grounded plan generation.
- `execution-graph`: graph-shaped task runtime primitives, dependencies, replay summaries.
- `capability-system`: named capabilities, risk levels, approval requirements.
- `temporal-engine`: timeline reconstruction, decay, summaries, recurring work detection.
- `workflow-engine`: autonomous workflows, scheduled jobs, agent task chains.
- `tool-cortex`: Ollama, cloud model abstraction, shell/Python/GitHub tool routing.
- `sensory-system`: file watching, system activity, active process, git change detection.
- `safety-layer`: allowlists, dangerous command checks, audit decisions, local-first policy.
- `personality-engine`: persistent pet mood/personality and notification decisions.
- `observability`: event metrics, reasoning traces, task/debug inspection.
- `brain-core`: boots the system, registers required agents, coordinates subsystems.
- `desktop-bridge`: Tauri-facing facade around `BrainCore`.

## Required Agents

The MVP registers all required agents:

1. `ObserverAgent`
2. `SummaryAgent`
3. `MemoryAgent`
4. `SemanticMemoryAgent`
5. `PlannerAgent`
6. `ProjectAgent`
7. `ToolRouterAgent`
8. `CommandAgent`
9. `SchedulerAgent`
10. `ContextAgent`
11. `WorkflowAgent`
12. `PetAgent`
13. `SafetyAgent`

Every agent receives events from the nervous-system bus. Agent work emits follow-up events, persists state, or enqueues workflows.

## Computer Recognition + Brain Thought Process

When the Computer Brain is installed on a system, it should recognize the computer as its body.

The entire computer becomes the environment of the brain.

The system must scan, understand, and organize:

- installed applications
- developer tools
- local AI tools
- project folders
- coding environments
- terminal capabilities
- documents
- scripts
- APIs
- system resources
- available skills
- available agents
- previous work history

The brain should not randomly control the computer.

Instead, it should create an internal map of the system.

This map becomes the brain's understanding of its body.

## System Body Map

The Computer Brain should create a `System Body Map`.

This includes:

1. File System Map
   - important folders
   - projects
   - documents
   - source code
   - assets
   - logs
2. Tool Map
   - Rust
   - Python
   - Node.js
   - Git
   - Docker
   - Ollama
   - VS Code
   - Unreal Engine
   - Blender
   - installed CLIs
3. AI Tool Map
   - local models
   - cloud models
   - API access
   - embeddings
   - vector databases
4. Skill Map
   - what the system can do
   - available commands
   - available programming tools
   - available automation tools
5. Project Map
   - detected projects
   - languages used
   - build systems
   - dependencies
   - recent activity

## Memory As Thought Process

Memory should become the thought process of the brain.

The brain should use memory to understand:

- what the user worked on
- what tools are available
- what projects exist
- what skills the computer has
- what previous actions succeeded
- what previous actions failed
- what the user usually does

Memory layers:

1. System Memory: the computer's hardware, software, tools, and environment.
2. Project Memory: knowledge about each detected project.
3. Skill Memory: what the brain knows how to do on this computer.
4. Session Memory: what is happening right now.
5. Long-Term Memory: important knowledge preserved over time.

The brain's thinking should come from combining:

- current user request
- system body map
- memory
- available tools
- available agents
- safety rules

## Agents As Movement

Agents are the movement system of the brain.

The brain thinks using memory.

The agents move through the computer to perform actions.

Example:

User asks: "Fix this Rust project."

Brain thought process:

1. Check memory
2. Detect active project
3. Recall previous errors
4. Identify available Rust tools
5. Plan safe actions

Agent movement:

1. `ObserverAgent` scans files
2. `ProjectAgent` understands structure
3. `CommandAgent` runs `cargo check`
4. `ToolRouterAgent` asks local AI/model for analysis
5. `MemoryAgent` stores results
6. `SummaryAgent` explains fix
7. `PetAgent` notifies user

Agents must never act randomly.

Every agent action must be:

- requested
- planned
- permission-checked
- logged
- stored in memory

## Installation Behavior

On first install, the Computer Brain should perform onboarding:

1. Scan system safely
2. Detect available tools
3. Detect projects
4. Build system body map
5. Create initial memory
6. Ask user what folders it can access
7. Ask user what actions need approval
8. Create first computer identity profile

Example identity profile:

"This system is a Windows development laptop with Rust, Python, Node.js, VS Code, Ollama, Git, and Unreal Engine available. The user works mainly on AI systems, game development, and Rust architecture projects."

## Cognitive Model

The Computer Brain should not be just an app.

It should become a cognitive layer over the computer.

- Memory = thought process
- Agents = movement
- Tools = body parts
- Projects = learned experience
- Desktop pet = visible personality
- Brain Core = decision center
- Safety Layer = conscience
- Event Bus = nervous system
- Computer = body

The computer is the body. The memory is the thought process. The agents are movement. The tools are organs. The desktop pet is the face. The brain core is the mind.

## Terminal + System Command Access

The Computer Brain must be able to access the local terminal and run system commands safely.

This feature must be handled through a dedicated Rust agent:

`CommandAgent`

Responsibilities:

- execute approved terminal commands
- run project build commands
- run tests
- run git commands
- install dependencies only with approval
- inspect folders/files
- start local servers
- stop local servers
- capture stdout/stderr
- return command results to Brain Core
- log every command execution

Supported shells:

- Windows PowerShell
- Windows CMD
- Git Bash optional
- Linux bash
- macOS zsh/bash

Rust implementation:

- use `tokio::process::Command`
- async command execution
- timeout support
- stdout/stderr capture
- working directory support
- environment variable support
- command history logs

`CommandAgent` must support:

1. Safe read commands without approval:
   - `dir` / `ls`
   - `pwd`
   - `tree`
   - `git status`
   - `git log`
   - `cargo check`
   - `cargo test`
   - `npm run build`
   - `npm test`
   - `python --version`
   - `node --version`
2. Approval-required commands:
   - `npm install`
   - `cargo install`
   - `pip install`
   - `git pull`
   - `git push`
   - file write/edit operations
   - process kill
   - server start
   - package upgrades
3. Blocked dangerous commands:
   - `rm -rf /`
   - `del /s /q C:\`
   - `format`
   - destructive `diskpart` commands
   - destructive registry edits
   - destructive `sudo` commands
   - commands that expose secrets
   - commands that upload private files without permission

The system must include:

- command allowlist
- command denylist
- risk scoring
- user confirmation prompts
- execution sandbox where possible
- audit logging
- per-project command permissions
- command timeout
- output truncation
- secure environment handling

Example user command flow:

User: "Run tests for my Rust project."

Brain Core:

1. Detects active project
2. Sends task to `CommandAgent`
3. `CommandAgent` checks safety rules
4. Runs `cargo test`
5. Captures output
6. Stores result in memory
7. `SummaryAgent` summarizes failures
8. `PetAgent` shows result notification

Example command result memory:

"Ran `cargo test` in computer-brain workspace. 42 tests passed, 2 failed in memory-cortex. Main issue: SQLite migration mismatch."

Terminal access must never be uncontrolled.

The AI brain can run commands only through `CommandAgent`, never directly. All terminal actions must be visible, logged, permission-checked, and reversible when possible.

## Data Model

The SQLite schema is in `crates/memory-cortex/src/schema.sql` and includes:

- `memories`
- `sessions`
- `projects`
- `agents`
- `events`
- `tasks`
- `graph_nodes`
- `graph_edges`
- `workflows`
- `context_snapshots`
- `pet_states`
- `tool_calls`
- `audit_logs`
- `semantic_vectors`
- `project_summaries`

## Privacy Rules

- Local memory is SQLite by default.
- Ollama is the default model provider.
- Cloud providers are disabled unless explicitly configured.
- No tool uploads content to cloud without an event/audit trail and an explicit permission decision.
- Shell commands are checked by the safety layer before execution.
