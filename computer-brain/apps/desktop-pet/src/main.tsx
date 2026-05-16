import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Brain,
  Braces,
  CalendarClock,
  Database,
  GitBranch,
  Lock,
  MessageSquare,
  Network,
  PlugZap,
  Radar,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Terminal,
  Workflow
} from "lucide-react";
import "./styles.css";

type Agent = {
  name: string;
  state: string;
  capabilities: string[];
  last_seen_at: string;
};

type MemoryRecord = {
  id: string;
  kind: string;
  title?: string | null;
  content: string;
  importance: number;
  tags: string[];
  source_path?: string | null;
  updated_at: string;
};

type PetState = {
  mood: string;
  focus: number;
  arousal: number;
  current_project?: string | null;
  recent_brief: string;
  notification?: string | null;
};

type WorldState = {
  cognitive_mode: string;
  active_project?: string | null;
  active_window?: string | null;
  running_apps: string[];
  active_agents: string[];
  pending_tasks: number;
  current_focus: string;
  system_load: { cpu: number; memory: number };
  available_tools: string[];
  current_context?: string | null;
  recent_memories: string[];
  updated_at: string;
};

type BodyMap = {
  file_system: {
    important_folders: string[];
    project_roots: string[];
    document_roots: string[];
    source_roots: string[];
    asset_roots: string[];
    log_roots: string[];
  };
  tool_map: {
    languages: string[];
    terminals: string[];
    developer_tools: string[];
    clis: string[];
  };
  ai_tool_map: {
    local_models: string[];
    cloud_models: string[];
    api_access: string[];
    embedding_tools: string[];
    vector_databases: string[];
  };
  skill_map: {
    known_skills: string[];
    commands: string[];
    programming_tools: string[];
    automation_tools: string[];
  };
  project_map: Array<{ id: string; name: string; root_path: string; languages: string[]; build_systems: string[]; last_seen_at: string }>;
  identity_profile: string;
  scanned_at: string;
};

type Capability = {
  id: string;
  label: string;
  description: string;
  risk: string;
  approval_required: boolean;
};

type ReasoningTrace = {
  id: string;
  kind: string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type Dashboard = {
  counts: Record<string, number>;
  agents: Agent[];
  recent_memories: MemoryRecord[];
  recent_projects: Array<{ id: string; name: string; root_path: string; last_seen_at: string; summary?: string | null }>;
  recent_tasks: Array<{ id: string; agent: string; action: string; state: string; priority: number; updated_at: string }>;
  pet: PetState;
  events: Array<{ id: string; event: { kind: string; [key: string]: unknown }; occurred_at: string; source_agent?: string | null }>;
  cognitive_state: WorldState;
  body_map: BodyMap;
  capabilities: Capability[];
  recent_traces: ReasoningTrace[];
  event_metrics: { total_events: number; by_kind: Record<string, number> };
};

type ChatOutput = {
  answer: string;
  related_memories: Array<{ memory: MemoryRecord; score: number; reasons: string[] }>;
};

type GraphOutput = {
  nodes: Array<{ id: string; kind: string; label: string; project_id?: string | null }>;
  edges: Array<{ id: string; from_id: string; to_id: string; kind: string; weight: number }>;
};

type BrowserState = {
  memories: MemoryRecord[];
  projects: Dashboard["recent_projects"];
  events: Dashboard["events"];
};

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!(window as TauriWindow).__TAURI_INTERNALS__) {
    return browserInvoke<T>(cmd, args);
  }
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

async function browserInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const state = readBrowserState();
  const now = new Date().toISOString();

  switch (cmd) {
    case "brain_dashboard":
      return browserDashboard(state) as T;
    case "knowledge_graph":
      return browserGraph(state.memories) as T;
    case "brain_chat": {
      const input = args?.input as { message?: string } | undefined;
      const message = input?.message?.trim() ?? "";
      const related = relatedMemories(message, state.memories);
      state.events.unshift({
        id: newId("evt"),
        event: { kind: "BrowserPreviewMessage", message },
        occurred_at: now,
        source_agent: "BrowserPreview"
      });
      writeBrowserState(state);
      return {
        answer: related.length
          ? `Browser preview found ${related.length} local UI memories. Launch the Tauri app for the Rust brain runtime.`
          : "Browser preview is active. Launch the Tauri app to connect to the Rust brain runtime.",
        related_memories: related
      } as T;
    }
    case "ingest_memory": {
      const input = args?.input as { content?: string; tags?: string[]; source_path?: string | null } | undefined;
      const memory: MemoryRecord = {
        id: newId("mem"),
        kind: "LongTerm",
        title: "browser preview memory",
        content: input?.content ?? "",
        importance: 0.45,
        tags: input?.tags ?? ["browser-preview"],
        source_path: input?.source_path ?? null,
        updated_at: now
      };
      state.memories.unshift(memory);
      state.events.unshift({
        id: newId("evt"),
        event: { kind: "BrowserPreviewMemoryStored", memory_id: memory.id },
        occurred_at: now,
        source_agent: "BrowserPreview"
      });
      writeBrowserState(state);
      return memory as T;
    }
    case "observe_project": {
      const input = args?.input as { root_path?: string } | undefined;
      const root = input?.root_path ?? "browser-preview";
      const project = {
        id: newId("proj"),
        name: root.split(/[\\/]/).filter(Boolean).pop() ?? "browser-preview",
        root_path: root,
        last_seen_at: now,
        summary: "Browser preview project record"
      };
      state.projects.unshift(project);
      writeBrowserState(state);
      return project as T;
    }
    case "run_safe_command": {
      const input = args?.input as { command?: string } | undefined;
      state.events.unshift({
        id: newId("evt"),
        event: { kind: "BrowserPreviewCommandBlocked", command: input?.command ?? "" },
        occurred_at: now,
        source_agent: "SafetyAgent"
      });
      writeBrowserState(state);
      return undefined as T;
    }
    default:
      throw new Error(`${cmd} requires the Tauri desktop shell.`);
  }
}

function browserDashboard(state: BrowserState): Dashboard {
  const now = new Date().toISOString();
  const graph = browserGraph(state.memories);
  const bodyMap = previewBodyMap(now, state.projects);
  const capabilities = previewCapabilities();
  return {
    counts: {
      memories: state.memories.length,
      projects: state.projects.length,
      agents: agentNames.length,
      events: state.events.length,
      tasks: 0,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      toolCalls: 0,
      auditLogs: 0,
      skills: agentNames.length,
      permissions: 0,
      commandLogs: 0,
      bodyMaps: 1,
      worldStates: 1,
      reasoningTraces: 1
    },
    agents: agentNames.map((name) => ({
      name,
      state: "Idle",
      capabilities: agentCapabilities[name] ?? [],
      last_seen_at: now
    })),
    recent_memories: state.memories,
    recent_projects: state.projects,
    recent_tasks: [],
    pet: {
      mood: "curious",
      focus: 0.42,
      arousal: 0.34,
      recent_brief: "Browser preview mode. Tauri IPC is not attached.",
      notification: "Run npm run tauri:dev for the live Rust brain."
    },
    events: state.events,
    cognitive_state: {
      cognitive_mode: "planning",
      active_project: state.projects[0]?.id ?? null,
      active_window: null,
      running_apps: ["browser-preview"],
      active_agents: agentNames,
      pending_tasks: 0,
      current_focus: "browser preview of the cognitive operating layer",
      system_load: { cpu: 0, memory: 0 },
      available_tools: [...bodyMap.tool_map.languages, ...bodyMap.tool_map.clis, ...bodyMap.ai_tool_map.local_models],
      current_context: state.projects[0]?.root_path ?? null,
      recent_memories: state.memories.map((memory) => memory.id),
      updated_at: now
    },
    body_map: bodyMap,
    capabilities,
    recent_traces: [
      {
        id: "preview-trace",
        kind: "planning",
        summary: "Browser preview is showing cognitive state without Tauri IPC.",
        metadata: { mode: "preview" },
        created_at: now
      }
    ],
    event_metrics: {
      total_events: state.events.length,
      by_kind: state.events.reduce<Record<string, number>>((acc, event) => {
        acc[event.event.kind] = (acc[event.event.kind] ?? 0) + 1;
        return acc;
      }, {})
    }
  };
}

function previewBodyMap(now: string, projects: BrowserState["projects"]): BodyMap {
  return {
    file_system: {
      important_folders: ["C:\\Users\\allam", "C:\\Users\\allam\\projects"],
      project_roots: projects.map((project) => project.root_path),
      document_roots: [],
      source_roots: projects.map((project) => project.root_path),
      asset_roots: [],
      log_roots: []
    },
    tool_map: {
      languages: ["Rust", "Node.js", "TypeScript"],
      terminals: ["Windows PowerShell", "Windows CMD"],
      developer_tools: ["VS Code", "Git"],
      clis: ["cargo", "npm", "git"]
    },
    ai_tool_map: {
      local_models: ["Ollama"],
      cloud_models: ["OpenAI", "Claude", "Gemini"],
      api_access: [],
      embedding_tools: ["local-hash-embedding"],
      vector_databases: ["local SQLite vectors", "Qdrant/ChromaDB optional"]
    },
    skill_map: {
      known_skills: agentNames,
      commands: ["cargo check", "cargo test", "npm run build", "git status"],
      programming_tools: ["Rust", "Node.js"],
      automation_tools: ["cargo", "npm", "git"]
    },
    project_map: projects.map((project) => ({
      id: project.id,
      name: project.name,
      root_path: project.root_path,
      languages: ["Rust", "TypeScript"],
      build_systems: ["Cargo", "Vite"],
      last_seen_at: project.last_seen_at
    })),
    identity_profile: "Browser preview profile for a Windows development laptop running the Computer Brain workspace.",
    scanned_at: now
  };
}

function previewCapabilities(): Capability[] {
  return [
    ["filesystem.read", "Read Filesystem", "Inspect approved folders and files.", "read-only", false],
    ["terminal.execute", "Execute Terminal", "Run allowlisted terminal commands through CommandAgent.", "local-mutation", false],
    ["git.inspect", "Inspect Git", "Read git status, logs, branches, and diffs.", "read-only", false],
    ["memory.retrieve", "Retrieve Memory", "Search structured and semantic memory.", "read-only", false],
    ["memory.store", "Store Memory", "Persist new memories and summaries.", "local-mutation", false],
    ["summarize.code", "Summarize Code", "Create local summaries from project artifacts.", "read-only", false],
    ["graph.query", "Query Knowledge Graph", "Read project and concept relationships.", "read-only", false],
    ["network.cloud-model", "Cloud Model Call", "Use external AI providers.", "network", true],
    ["package.install", "Install Packages", "Install or upgrade dependencies.", "network", true],
    ["process.kill", "Stop Process", "Terminate a running process.", "destructive", true]
  ].map(([id, label, description, risk, approval_required]) => ({
    id: id as string,
    label: label as string,
    description: description as string,
    risk: risk as string,
    approval_required: approval_required as boolean
  }));
}

function browserGraph(memories: MemoryRecord[]): GraphOutput {
  const nodes: GraphOutput["nodes"] = [{ id: "browser-brain", kind: "Project", label: "Computer Brain Preview" }];
  const edges: GraphOutput["edges"] = [];
  memories.slice(0, 20).forEach((memory) => {
    const memoryNode = { id: `node-${memory.id}`, kind: "Memory", label: memory.title ?? memory.kind };
    nodes.push(memoryNode);
    edges.push({ id: `edge-${memory.id}`, from_id: "browser-brain", to_id: memoryNode.id, kind: "Contains", weight: 0.6 });
  });
  return { nodes, edges };
}

function relatedMemories(query: string, memories: MemoryRecord[]): ChatOutput["related_memories"] {
  const queryTerms = tokenize(query);
  return memories
    .map((memory) => {
      const terms = tokenize(`${memory.tags.join(" ")} ${memory.content}`);
      const overlap = queryTerms.filter((term) => terms.includes(term)).length;
      return {
        memory,
        score: queryTerms.length ? overlap / queryTerms.length : 0,
        reasons: [`browser-preview-overlap=${overlap}`]
      };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function readBrowserState(): BrowserState {
  const stored = window.localStorage.getItem("computer-brain-preview");
  if (stored) {
    try {
      return JSON.parse(stored) as BrowserState;
    } catch {
      window.localStorage.removeItem("computer-brain-preview");
    }
  }
  const now = new Date().toISOString();
  return {
    memories: [
      {
        id: "preview-memory",
        kind: "LongTerm",
        title: "browser preview",
        content: "The React shell is running without Tauri IPC. The Rust brain core is available through the desktop app.",
        importance: 0.4,
        tags: ["browser-preview", "tauri"],
        source_path: null,
        updated_at: now
      }
    ],
    projects: [
      {
        id: "preview-project",
        name: "computer-brain",
        root_path: "C:\\Users\\allam\\projects\\star\\computer-brain",
        last_seen_at: now,
        summary: "Unified local-first AI nervous system workspace"
      }
    ],
    events: [
      {
        id: "preview-event",
        event: { kind: "BrowserPreviewStarted" },
        occurred_at: now,
        source_agent: "DesktopBridge"
      }
    ]
  };
}

function writeBrowserState(state: BrowserState): void {
  window.localStorage.setItem(
    "computer-brain-preview",
    JSON.stringify({
      memories: state.memories.slice(0, 100),
      projects: state.projects.slice(0, 20),
      events: state.events.slice(0, 100)
    })
  );
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_-]+/).filter((term) => term.length > 2);
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

const agentNames = [
  "ObserverAgent",
  "SummaryAgent",
  "MemoryAgent",
  "SemanticMemoryAgent",
  "PlannerAgent",
  "ProjectAgent",
  "ToolRouterAgent",
  "CommandAgent",
  "SchedulerAgent",
  "ContextAgent",
  "WorkflowAgent",
  "PetAgent",
  "SafetyAgent"
];

const agentCapabilities: Record<string, string[]> = {
  ObserverAgent: ["ObserveFiles"],
  SummaryAgent: ["Summarize", "WriteMemory"],
  MemoryAgent: ["ReadMemory", "WriteMemory"],
  SemanticMemoryAgent: ["SemanticSearch", "ReadMemory"],
  PlannerAgent: ["PlanTasks", "BuildExecutionGraph"],
  ProjectAgent: ["UpdateProjectGraph"],
  ToolRouterAgent: ["RouteTools"],
  CommandAgent: ["ExecuteSafeCommands"],
  SchedulerAgent: ["ScheduleWorkflows"],
  ContextAgent: ["InferContext", "ReadMemory"],
  WorkflowAgent: ["ScheduleWorkflows"],
  PetAgent: ["UpdatePet"],
  SafetyAgent: ["EnforceSafety"]
};

function useDashboard(): {
  dashboard: Dashboard | null;
  graph: GraphOutput | null;
  refresh: () => Promise<void>;
  error: string | null;
  busy: boolean;
} {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [graph, setGraph] = useState<GraphOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const [dash, graphData] = await Promise.all([
        invoke<Dashboard>("brain_dashboard"),
        invoke<GraphOutput>("knowledge_graph")
      ]);
      setDashboard(dash);
      setGraph(graphData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => window.clearInterval(timer);
  }, []);

  return { dashboard, graph, refresh, error, busy };
}

function PetWindow(): JSX.Element {
  const { dashboard } = useDashboard();
  const pet = dashboard?.pet;
  const mood = pet?.mood ?? "idle";
  const color = mood === "analyzing" ? "#7aa7ff" : mood === "focused" ? "#83ffb0" : mood === "curious" ? "#ffcf5a" : "#5df2ff";
  return (
    <main className="pet-root" style={{ ["--pet" as string]: color }}>
      <div className="pet-orbit" />
      <div className="pet-orb">
        <Brain size={48} />
      </div>
      <strong>{mood}</strong>
      <div className="pet-meter">
        <span style={{ width: `${Math.round((pet?.focus ?? 0.2) * 100)}%` }} />
      </div>
      <p>{pet?.notification ?? pet?.recent_brief ?? "Watching local activity"}</p>
    </main>
  );
}

function App(): JSX.Element {
  const params = new URLSearchParams(window.location.search);
  if (params.get("window") === "pet") return <PetWindow />;
  return <BrainShell />;
}

function BrainShell(): JSX.Element {
  const { dashboard, graph, refresh, error, busy } = useDashboard();
  const [tab, setTab] = useState("dashboard");
  const [message, setMessage] = useState("");
  const [chat, setChat] = useState<ChatOutput | null>(null);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [command, setCommand] = useState("git status --short");

  const send = async () => {
    if (!message.trim()) return;
    setChat(await invoke<ChatOutput>("brain_chat", { input: { message } }));
    setMessage("");
    await refresh();
  };

  const ingest = async () => {
    if (!memoryDraft.trim()) return;
    await invoke("ingest_memory", { input: { content: memoryDraft, tags: ["manual", "desktop"], source_path: null } });
    setMemoryDraft("");
    await refresh();
  };

  const runCommand = async () => {
    if (!command.trim()) return;
    await invoke("run_safe_command", { input: { command, cwd: null } });
    await refresh();
  };

  const counts = dashboard?.counts ?? {};
  return (
    <main className="brain-shell">
      <aside className="rail">
        <div className="brand"><Brain /> Computer Brain</div>
        {[
          ["dashboard", Brain, "Brain Dashboard"],
          ["chat", MessageSquare, "Chat Panel"],
          ["memory", Database, "Memory Timeline"],
          ["search", Search, "Semantic Search"],
          ["graph", Network, "Knowledge Graph"],
          ["agents", Activity, "Active Agents"],
          ["workflows", Workflow, "Workflow Inspector"],
          ["events", Braces, "Event Stream"],
          ["context", Radar, "Context Viewer"],
          ["body", Brain, "System Body Map"],
          ["capabilities", PlugZap, "Capabilities"],
          ["projects", GitBranch, "Project Intelligence"],
          ["tools", PlugZap, "Tool Connections"],
          ["settings", Settings, "Safety Permissions"]
        ].map(([id, Icon, label]) => (
          <button key={id as string} className={tab === id ? "active" : ""} onClick={() => setTab(id as string)}>
            {React.createElement(Icon as typeof Brain, { size: 17 })}
            <span>{label as string}</span>
          </button>
        ))}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">local-first nervous system</span>
            <h1>{tabLabel(tab)}</h1>
          </div>
          <button className="icon-button" onClick={() => void refresh()}>{busy ? <Sparkles /> : <RefreshCw />}</button>
        </header>
        {error ? <div className="error">{error}</div> : null}

        {tab === "dashboard" && (
          <div className="grid dashboard-grid">
            <Metric icon={<Database />} label="memories" value={counts.memories ?? 0} />
            <Metric icon={<Activity />} label="agents" value={dashboard?.agents.length ?? 0} />
            <Metric icon={<Network />} label="graph nodes" value={counts.graphNodes ?? 0} />
            <Metric icon={<Workflow />} label="tasks" value={counts.tasks ?? 0} />
            <Panel title="Recent Work Brief" icon={<Radar />}>
              <p className="large-copy">{dashboard?.pet.recent_brief ?? "Computer Brain is starting."}</p>
            </Panel>
            <Panel title="Event Stream" icon={<Braces />}>
              <Timeline rows={(dashboard?.events ?? []).slice(0, 8).map((e) => ({
                title: e.event.kind,
                detail: e.source_agent ?? "system",
                time: e.occurred_at
              }))} />
            </Panel>
          </div>
        )}

        {tab === "chat" && (
          <Panel title="Chat Panel" icon={<MessageSquare />}>
            <div className="composer">
              <input value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }} placeholder="Ask the computer brain..." />
              <button onClick={() => void send()}><Send size={16} /></button>
            </div>
            {chat ? (
              <div className="answer">
                <strong>{chat.answer}</strong>
                {chat.related_memories.map((hit) => (
                  <article key={hit.memory.id}>
                    <span>{Math.round(hit.score * 100)}%</span>
                    <p>{hit.memory.content}</p>
                  </article>
                ))}
              </div>
            ) : null}
          </Panel>
        )}

        {tab === "memory" && (
          <Panel title="Memory Timeline" icon={<CalendarClock />}>
            <div className="composer">
              <input value={memoryDraft} onChange={(e) => setMemoryDraft(e.target.value)} placeholder="Capture a durable local memory..." />
              <button onClick={() => void ingest()}><Send size={16} /></button>
            </div>
            <Timeline rows={(dashboard?.recent_memories ?? []).map((m) => ({
              title: m.title ?? m.kind,
              detail: m.content,
              time: m.updated_at
            }))} />
          </Panel>
        )}

        {tab === "search" && (
          <Panel title="Semantic Search" icon={<Search />}>
            <p className="muted">Semantic recall is driven by local vector embeddings stored alongside SQLite memory.</p>
            <Timeline rows={(chat?.related_memories ?? []).map((hit) => ({
              title: `${Math.round(hit.score * 100)}% ${hit.memory.title ?? hit.memory.kind}`,
              detail: hit.memory.content,
              time: hit.memory.updated_at
            }))} />
          </Panel>
        )}

        {tab === "graph" && <GraphView graph={graph} />}

        {tab === "agents" && (
          <Panel title="Active Agents" icon={<Activity />}>
            <div className="agent-grid">
              {(dashboard?.agents ?? []).map((agent) => (
                <article key={agent.name}>
                  <strong>{agent.name}</strong>
                  <span>{agent.state}</span>
                  <small>{agent.capabilities.join(", ")}</small>
                </article>
              ))}
            </div>
          </Panel>
        )}

        {tab === "workflows" && (
          <Panel title="Workflow Inspector" icon={<Workflow />}>
            <Timeline rows={(dashboard?.recent_tasks ?? []).map((task) => ({
              title: `${task.agent}: ${task.action}`,
              detail: `${task.state} / priority ${task.priority}`,
              time: task.updated_at
            }))} />
            <TraceList traces={dashboard?.recent_traces ?? []} />
          </Panel>
        )}

        {tab === "events" && (
          <Panel title="Event Stream Viewer" icon={<Braces />}>
            <div className="metric-row">
              <Metric icon={<Activity />} label="events" value={dashboard?.event_metrics.total_events ?? 0} />
              <Metric icon={<Braces />} label="event kinds" value={Object.keys(dashboard?.event_metrics.by_kind ?? {}).length} />
            </div>
            <Timeline rows={(dashboard?.events ?? []).map((event) => ({
              title: event.event.kind,
              detail: event.source_agent ?? "system",
              time: event.occurred_at
            }))} />
          </Panel>
        )}

        {tab === "context" && (
          <Panel title="Context Viewer" icon={<Radar />}>
            <div className="settings-grid">
              <div><strong>Mode</strong><span>{dashboard?.cognitive_state.cognitive_mode ?? "unknown"}</span></div>
              <div><strong>Focus</strong><span>{dashboard?.cognitive_state.current_focus ?? "none"}</span></div>
              <div><strong>Pending tasks</strong><span>{dashboard?.cognitive_state.pending_tasks ?? 0}</span></div>
              <div><strong>System load</strong><span>{Math.round((dashboard?.cognitive_state.system_load.cpu ?? 0) * 100) / 100}% CPU</span></div>
              <div><strong>Current context</strong><span>{dashboard?.cognitive_state.current_context ?? "ambient"}</span></div>
              <div><strong>Recent memories</strong><span>{dashboard?.cognitive_state.recent_memories.length ?? 0}</span></div>
            </div>
          </Panel>
        )}

        {tab === "body" && (
          <Panel title="System Body Map" icon={<Brain />}>
            <p className="large-copy">{dashboard?.body_map.identity_profile ?? "System body map has not been scanned yet."}</p>
            <MapSection title="Languages" values={dashboard?.body_map.tool_map.languages ?? []} />
            <MapSection title="Terminals" values={dashboard?.body_map.tool_map.terminals ?? []} />
            <MapSection title="Developer Tools" values={dashboard?.body_map.tool_map.developer_tools ?? []} />
            <MapSection title="CLI Organs" values={dashboard?.body_map.tool_map.clis ?? []} />
            <MapSection title="AI Tools" values={[...(dashboard?.body_map.ai_tool_map.local_models ?? []), ...(dashboard?.body_map.ai_tool_map.vector_databases ?? [])]} />
            <MapSection title="Known Folders" values={dashboard?.body_map.file_system.important_folders ?? []} />
          </Panel>
        )}

        {tab === "capabilities" && (
          <Panel title="Tool Capability Panel" icon={<PlugZap />}>
            <div className="tool-list">
              {(dashboard?.capabilities ?? []).map((capability) => (
                <article key={capability.id}>
                  <strong>{capability.label}</strong>
                  <p>{capability.description}</p>
                  <span>{capability.risk} / {capability.approval_required ? "approval required" : "auto allowed"}</span>
                </article>
              ))}
            </div>
          </Panel>
        )}

        {tab === "projects" && (
          <Panel title="Project Intelligence" icon={<GitBranch />}>
            <Timeline rows={(dashboard?.recent_projects ?? []).map((p) => ({
              title: p.name,
              detail: p.root_path,
              time: p.last_seen_at
            }))} />
          </Panel>
        )}

        {tab === "tools" && (
          <Panel title="Tool Connections" icon={<PlugZap />}>
            <div className="tool-list">
              <Tool label="Ollama" status="local default" />
              <Tool label="OpenAI" status="disabled until permission" />
              <Tool label="Claude" status="disabled until permission" />
              <Tool label="Gemini" status="disabled until permission" />
              <Tool label="Shell" status="allowlist guarded" />
            </div>
            <div className="composer">
              <input value={command} onChange={(e) => setCommand(e.target.value)} />
              <button onClick={() => void runCommand()}><Terminal size={16} /></button>
            </div>
          </Panel>
        )}

        {tab === "settings" && (
          <Panel title="Safety Permissions Panel" icon={<Lock />}>
            <div className="settings-grid">
              <div><strong>Local first</strong><span>Cloud uploads blocked by default</span></div>
              <div><strong>Command safety</strong><span>Allowlist plus dangerous command confirmation</span></div>
              <div><strong>API keys</strong><span>Reserved for encrypted key storage</span></div>
              <div><strong>Audit trail</strong><span>{counts.auditLogs ?? 0} safety records</span></div>
            </div>
          </Panel>
        )}
      </section>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }): JSX.Element {
  return <div className="metric">{icon}<strong>{value}</strong><span>{label}</span></div>;
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return <section className="panel"><h2>{icon}{title}</h2>{children}</section>;
}

function Timeline({ rows }: { rows: Array<{ title: string; detail: string; time: string }> }): JSX.Element {
  return <div className="timeline">{rows.map((row, i) => <article key={`${row.title}-${i}`}><strong>{row.title}</strong><p>{row.detail}</p><time>{new Date(row.time).toLocaleString()}</time></article>)}</div>;
}

function TraceList({ traces }: { traces: ReasoningTrace[] }): JSX.Element {
  return (
    <div className="trace-list">
      {traces.map((trace) => (
        <article key={trace.id}>
          <strong>{trace.kind}</strong>
          <p>{trace.summary}</p>
          <time>{new Date(trace.created_at).toLocaleString()}</time>
        </article>
      ))}
    </div>
  );
}

function MapSection({ title, values }: { title: string; values: string[] }): JSX.Element {
  return (
    <section className="map-section">
      <strong>{title}</strong>
      <div className="chip-list">
        {values.length ? values.map((value) => <span key={value}>{value}</span>) : <span>not detected</span>}
      </div>
    </section>
  );
}

function GraphView({ graph }: { graph: GraphOutput | null }): JSX.Element {
  const nodes = graph?.nodes ?? [];
  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    nodes.forEach((node, i) => {
      const angle = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
      map.set(node.id, { x: 50 + Math.cos(angle) * 38, y: 50 + Math.sin(angle) * 38 });
    });
    return map;
  }, [nodes]);
  return (
    <Panel title="Knowledge Graph View" icon={<Network />}>
      <svg className="graph" viewBox="0 0 100 100">
        {(graph?.edges ?? []).map((edge) => {
          const a = positions.get(edge.from_id);
          const b = positions.get(edge.to_id);
          if (!a || !b) return null;
          return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
        {nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          return <circle key={node.id} cx={pos.x} cy={pos.y} r={node.kind.includes("project") ? 3.4 : 2.3}><title>{node.label}</title></circle>;
        })}
      </svg>
    </Panel>
  );
}

function Tool({ label, status }: { label: string; status: string }): JSX.Element {
  return <article><strong>{label}</strong><span>{status}</span></article>;
}

function tabLabel(tab: string): string {
  return ({
    dashboard: "Brain Dashboard",
    chat: "Chat Panel",
    memory: "Memory Timeline",
    search: "Semantic Search",
    graph: "Knowledge Graph View",
    agents: "Agent Status View",
    workflows: "Workflow Inspector",
    events: "Event Stream Viewer",
    context: "Context Viewer",
    body: "System Body Map",
    capabilities: "Tool Capability Panel",
    projects: "Project Summary View",
    tools: "Tool Connections Panel",
    settings: "Safety Permissions Panel"
  } as Record<string, string>)[tab] ?? "Computer Brain";
}

createRoot(document.getElementById("root")!).render(<App />);
