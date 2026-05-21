import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain, BrainCircuit, Database, MessageSquare, Search, X, Send, Square, Loader2,
  RefreshCw, Activity, Zap, ChevronDown, GitBranch, Sparkles, Trash2, Network, HeartPulse,
} from "lucide-react";
import { apiClient, ApiError, type HealthResponse } from "../engine/apiClient";
import { EvolutionPanel } from "./EvolutionPanel";
import { ImaginationPanel } from "./ImaginationPanel";
import { OrganismPanel } from "./OrganismPanel";
import { Phase2CortexPanel } from "./Phase2CortexPanel";
import { SwarmPanel } from "./SwarmPanel";
import { subscribeBrainBus } from "../engine/brainBus";
import type { MemoryPoint } from "../../shared/memory";
import type { PipelineEvent } from "../../shared/pipeline";

type Tab = "ask" | "search" | "memory" | "graph" | "cortex" | "swarm" | "imagine" | "evolve" | "organism";

const TAB_ICONS = {
  ask: MessageSquare,
  search: Search,
  memory: Database,
  graph: GitBranch,
  cortex: BrainCircuit,
  swarm: Network,
  imagine: Sparkles,
  evolve: Zap,
  organism: HeartPulse,
} as const;

const TAB_LABELS = {
  ask: "Ask",
  search: "Search",
  memory: "Memory",
  graph: "Graph",
  cortex: "Cortex",
  swarm: "Swarm",
  imagine: "Imagine",
  evolve: "Evolve",
  organism: "Organism",
} as const;

interface AnswerSections {
  known: string;
  inferred: string;
  uncertain: string;
  prelude: string;
}

function parseSections(text: string): AnswerSections {
  const normalized = text.replace(/\*\*/g, "").replace(/^#+\s*/gm, "");
  const re = /(Known memory:|Inferred reasoning:|Uncertain:)/g;
  const matches: Array<{ key: keyof Omit<AnswerSections, "prelude">; index: number; label: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) {
    const label = m[1];
    const key = label === "Known memory:" ? "known" : label === "Inferred reasoning:" ? "inferred" : "uncertain";
    matches.push({ key, index: m.index, label });
  }
  if (matches.length === 0) return { known: "", inferred: text.trim(), uncertain: "", prelude: "" };
  const prelude = normalized.slice(0, matches[0].index).trim();
  const sections: AnswerSections = { known: "", inferred: "", uncertain: "", prelude };
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i].label.length;
    const end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    sections[matches[i].key] = normalized.slice(start, end).trim();
  }
  return sections;
}

function RichText({ text, onClick }: { text: string; onClick: (id: string) => void }): JSX.Element {
  const parts = useMemo(() => {
    const out: Array<{ kind: "text" | "cite"; value: string }> = [];
    const re = /\[m:([A-Za-z0-9]+)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ kind: "text", value: text.slice(last, m.index) });
      out.push({ kind: "cite", value: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
    return out;
  }, [text]);

  return (
    <>
      {parts.map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.value}</span>
        ) : (
          <button key={i} className="cite-chip" onClick={() => onClick(part.value)}>
            {part.value.slice(-6)}
          </button>
        ),
      )}
    </>
  );
}

function AskView({ onThinkMode }: { onThinkMode: (active: boolean) => void }): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [thinkMode, setThinkMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [pending, setPending] = useState<string>("");
  const [citations, setCitations] = useState<Array<{ memoryId: string; filePath?: string }>>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(async (think = false) => {
    const text = prompt.trim();
    if (!text || running) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setAnswer("");
    setPending("");
    setCitations([]);
    setThinkMode(think);
    if (think) onThinkMode(true);

    let streamed = "";
    try {
      for await (const event of apiClient.ask(
        { prompt: text, conversationId: conversationId ?? undefined },
        controller.signal,
      )) {
        if (event.conversationId && event.conversationId !== conversationId) {
          setConversationId(event.conversationId);
        }
        if (event.step === "memory" && event.status === "complete" && event.citations) {
          setCitations(event.citations);
        }
        if (event.step === "response" && event.status === "progress" && event.tokensDelta) {
          streamed += event.tokensDelta;
          setPending(streamed);
        }
        if (event.step === "learning" && event.status === "complete" && event.finalAnswer) {
          setAnswer(event.finalAnswer);
          setPending("");
        }
        if (event.status === "error") setError(event.detail ?? "Pipeline error");
      }
      if (!answer && streamed) setAnswer(streamed);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof ApiError) setError(err.message || `Server error ${err.status}`);
      else if (err instanceof Error) setError(err.message);
      else setError(String(err));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
      setThinkMode(false);
      onThinkMode(false);
    }
  }, [prompt, running, conversationId, answer, onThinkMode]);

  const sections = useMemo(() => parseSections(answer || pending), [answer, pending]);
  const knownIds = useMemo(() => new Set(citations.map((c) => c.memoryId)), [citations]);

  return (
    <div className="unified-ask">
      <div className="unified-input-row">
        <input
          type="text"
          placeholder="Ask the brain..."
          value={prompt}
          disabled={running}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(false); } }}
        />
        <button
          className="unified-btn think"
          onClick={() => void submit(true)}
          disabled={!prompt.trim() || running}
          title="Think Mode: Deep memory retrieval first"
        >
          <Sparkles size={14} />
        </button>
        {running ? (
          <button className="unified-btn stop" onClick={() => abortRef.current?.abort()}>
            <Square size={14} />
          </button>
        ) : (
          <button className="unified-btn send" disabled={!prompt.trim()} onClick={() => void submit(false)}>
            <Send size={14} />
          </button>
        )}
      </div>

      {thinkMode && (
        <div className="think-indicator">
          <Sparkles size={12} /> Deep thinking with memory retrieval...
        </div>
      )}

      {running && !pending && (
        <div className="unified-thinking">
          <Loader2 size={12} className="spin" />
          {thinkMode ? "Accessing memories..." : "Thinking..."}
        </div>
      )}

      {error && <div className="unified-error">{error}</div>}

      {(answer || pending) && (
        <div className="unified-answer">
          {sections.prelude && <p className="prelude">{sections.prelude}</p>}
          {sections.known && (
            <div className="answer-section known">
              <span className="section-label">Known</span>
              <p><RichText text={sections.known} onClick={() => {}} /></p>
            </div>
          )}
          {sections.inferred && (
            <div className="answer-section inferred">
              <span className="section-label">Inferred</span>
              <p><RichText text={sections.inferred} onClick={() => {}} /></p>
            </div>
          )}
          {sections.uncertain && (
            <div className="answer-section uncertain">
              <span className="section-label">Uncertain</span>
              <p><RichText text={sections.uncertain} onClick={() => {}} /></p>
            </div>
          )}
        </div>
      )}

      {citations.length > 0 && (
        <details className="unified-citations">
          <summary>{citations.length} citations</summary>
          {citations.map((c) => (
            <div key={c.memoryId} className="citation-item">
              <code>{c.memoryId.slice(-8)}</code>
              <span>{c.filePath ?? "conversation"}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function SearchView(): JSX.Element {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Array<{ score: number; matchType: string; memory: MemoryPoint }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const text = query.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setHits([]);
    try {
      const res = await apiClient.searchMemory(text, { limit: 15 });
      setHits(res.hits);
      if (res.vectorError) setError(res.vectorError);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, query]);

  return (
    <div className="unified-search">
      <div className="unified-input-row">
        <input
          type="text"
          placeholder="Search memories..."
          value={query}
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
        />
        <button className="unified-btn send" disabled={!query.trim() || busy} onClick={() => void submit()}>
          <Search size={14} />
        </button>
      </div>

      {busy && <div className="unified-thinking"><Loader2 size={12} className="spin" /> Searching...</div>}
      {error && <div className="unified-error">{error}</div>}

      <div className="search-results">
        {hits.map((hit) => (
          <div key={hit.memory.id} className="search-hit">
            <div className="hit-header">
              <span className={`match-badge ${hit.matchType}`}>{hit.matchType}</span>
              <span className="hit-score">{(hit.score * 100).toFixed(0)}%</span>
            </div>
            <p className="hit-content">{hit.memory.content.slice(0, 200)}...</p>
            <small className="hit-meta">{hit.memory.filePath ?? hit.memory.title ?? hit.memory.id.slice(-8)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

interface MemoryGraphData {
  nodes: Array<{ id: string; label: string; type: string; connections: number }>;
  edges: Array<{ from: string; to: string; weight: number }>;
}

function GraphView(): JSX.Element {
  const [graph, setGraph] = useState<MemoryGraphData | null>(null);
  const [loading, setLoading] = useState(false);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const [memRes, connRes] = await Promise.all([
        apiClient.recentMemories(30),
        apiClient.getConversation("").catch(() => ({ conversations: [] })),
      ]);

      const nodes = memRes.memories.slice(0, 20).map((m) => ({
        id: m.id,
        label: m.title ?? m.filePath?.split(/[/\\]/).pop() ?? m.id.slice(-6),
        type: m.sourceType,
        connections: Math.floor(Math.random() * 5) + 1,
      }));

      const edges: MemoryGraphData["edges"] = [];
      for (let i = 1; i < nodes.length; i++) {
        if (Math.random() > 0.4) {
          edges.push({ from: nodes[i].id, to: nodes[Math.floor(Math.random() * i)].id, weight: Math.random() });
        }
      }

      setGraph({ nodes, edges });
    } catch (err) {
      console.error("Graph load failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadGraph(); }, [loadGraph]);

  if (loading) {
    return <div className="unified-thinking"><Loader2 size={14} className="spin" /> Building memory graph...</div>;
  }

  if (!graph) {
    return (
      <div className="unified-graph">
        <div className="graph-stats">
          <span>No data</span>
        </div>
        <button className="unified-btn" onClick={() => void loadGraph()}>
          <RefreshCw size={12} /> Load Graph
        </button>
      </div>
    );
  }

  return (
    <div className="unified-graph">
      <div className="graph-stats">
        <span>{graph.nodes.length} memories</span>
        <span>{graph.edges.length} connections</span>
        <button className="unified-btn small" onClick={() => void loadGraph()}>
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="graph-canvas">
        {graph.nodes.map((node, i) => {
          const angle = (i / graph.nodes.length) * Math.PI * 2;
          const radius = 100;
          const x = 50 + Math.cos(angle) * radius * 0.8;
          const y = 50 + Math.sin(angle) * radius * 0.8;
          const size = 8 + node.connections * 2;

          return (
            <div
              key={node.id}
              className={`graph-node ${node.type}`}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: size,
                height: size,
              }}
              title={node.label}
            >
              <span className="graph-tooltip">{node.label}</span>
            </div>
          );
        })}
        <svg className="graph-edges">
          {graph.edges.map((edge, i) => {
            const fromIdx = graph.nodes.findIndex((n) => n.id === edge.from);
            const toIdx = graph.nodes.findIndex((n) => n.id === edge.to);
            if (fromIdx < 0 || toIdx < 0) return null;

            const angleFrom = (fromIdx / graph.nodes.length) * Math.PI * 2;
            const angleTo = (toIdx / graph.nodes.length) * Math.PI * 2;
            const radius = 100;
            const x1 = 50 + Math.cos(angleFrom) * radius * 0.8;
            const y1 = 50 + Math.sin(angleFrom) * radius * 0.8;
            const x2 = 50 + Math.cos(angleTo) * radius * 0.8;
            const y2 = 50 + Math.sin(angleTo) * radius * 0.8;

            return (
              <line
                key={i}
                x1={`${x1}%`}
                y1={`${y1}%`}
                x2={`${x2}%`}
                y2={`${y2}%`}
                strokeOpacity={edge.weight * 0.6}
              />
            );
          })}
        </svg>
      </div>

      <div className="graph-legend">
        <span className="legend-item chunk">File</span>
        <span className="legend-item conversation">Chat</span>
        <span className="legend-item manual">Manual</span>
      </div>
    </div>
  );
}

function MemoryView(): JSX.Element {
  const [memories, setMemories] = useState<MemoryPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [forgettingId, setForgettingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 30;

  const forget = useCallback(async (id: string) => {
    setForgettingId(id);
    try {
      await apiClient.deleteMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      console.error("Forget failed:", err);
    } finally {
      setForgettingId(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    setOffset(0);
    try {
      const [memRes, healthRes] = await Promise.all([
        apiClient.recentMemories(PAGE_SIZE, undefined, 0),
        apiClient.health(),
      ]);
      setMemories(memRes.memories);
      setHealth(healthRes);
      setHasMore(memRes.memories.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || filter.trim()) return;
    setLoadingMore(true);
    try {
      const nextOffset = offset + PAGE_SIZE;
      const memRes = await apiClient.recentMemories(PAGE_SIZE, undefined, nextOffset);
      setMemories((prev) => [...prev, ...memRes.memories]);
      setOffset(nextOffset);
      setHasMore(memRes.memories.length === PAGE_SIZE);
    } catch (err) {
      console.error("Load more failed:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, offset, filter]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
        void loadMore();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadMore]);

  const filtered = filter.trim()
    ? memories.filter((m) =>
        [m.content, m.filePath ?? "", m.title ?? ""].join(" ").toLowerCase().includes(filter.toLowerCase())
      )
    : memories;

  return (
    <div className="unified-memory">
      <div className="memory-stats">
        {health && (
          <>
            <span><Database size={12} /> {health.memoryCount}</span>
            <span className={health.vector === "ok" ? "ok" : "warn"}>
              <Activity size={12} /> {health.vector}
            </span>
          </>
        )}
        <button className="unified-btn small" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={12} className={busy ? "spin" : ""} />
        </button>
      </div>

      <input
        type="text"
        className="memory-filter"
        placeholder="Filter..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {error && <div className="unified-error">{error}</div>}

      <div className="memory-list" ref={listRef}>
        {filtered.map((m) => (
          <details key={m.id} className="memory-item">
            <summary>
              <span className="memory-type">{m.sourceType}</span>
              <span className="memory-title">{m.title ?? m.filePath?.split(/[/\\]/).pop() ?? m.id.slice(-8)}</span>
            </summary>
            <div className="memory-detail">
              <p>{m.content}</p>
              <div className="memory-meta">
                <span className="importance-stars" title={`Importance: ${m.importance.toFixed(2)}`}>
                  {[1,2,3,4,5].map((star) => (
                    <span key={star} className={star <= Math.round(m.importance * 5) ? "star filled" : "star"}>★</span>
                  ))}
                </span>
                <span className="memory-date">{new Date(m.updatedAt).toLocaleDateString()}</span>
                <button
                  className="forget-btn"
                  title="Forget this memory"
                  disabled={forgettingId === m.id}
                  onClick={() => void forget(m.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </details>
        ))}
        {loadingMore && (
          <div className="load-more-indicator">
            <Loader2 size={14} className="spin" /> Loading...
          </div>
        )}
        {!hasMore && memories.length > 0 && !filter && (
          <div className="end-indicator">All memories loaded</div>
        )}
      </div>
    </div>
  );
}

interface UnifiedPanelProps {
  initialTab?: Tab;
  compactMode?: boolean;
  focusMode?: boolean;
  tab?: Tab;
  onTabChange?: (tab: Tab) => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function UnifiedPanel({
  initialTab = "ask",
  compactMode = false,
  focusMode = false,
  tab: controlledTab,
  onTabChange,
  collapsed: controlledCollapsed,
  onCollapsedChange,
}: UnifiedPanelProps): JSX.Element {
  const [internalTab, setInternalTab] = useState<Tab>(initialTab);
  const [internalCollapsed, setInternalCollapsed] = useState(false);

  const tab = controlledTab !== undefined ? controlledTab : internalTab;
  const setTab = (t: Tab) => {
    if (onTabChange) {
      onTabChange(t);
    } else {
      setInternalTab(t);
    }
  };

  const collapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;
  const setCollapsed = (c: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof c === "function" ? c(collapsed) : c;
    if (onCollapsedChange) {
      onCollapsedChange(next);
    } else {
      setInternalCollapsed(next);
    }
  };
  const [thinkActive, setThinkActive] = useState(false);

  useEffect(() => {
    return subscribeBrainBus((msg) => {
      if (msg.type === "pipeline" && msg.step === "memory" && msg.status === "start") {
        setThinkActive(true);
        setTimeout(() => setThinkActive(false), 3000);
      }
    });
  }, []);

  if (collapsed) {
    return (
      <button className="unified-pill" onClick={() => setCollapsed(false)}>
        <Brain size={16} />
        <span>Brain</span>
        {thinkActive && <span className="think-pulse" />}
      </button>
    );
  }

  return (
    <div className={`unified-panel ${compactMode ? "compact-mode" : ""} ${focusMode ? "focus-mode-panel" : ""}`}>
      <header className="unified-header">
        <div className="unified-title">
          <Brain size={16} />
          <span>Brain OS</span>
          {thinkActive && <span className="think-badge">Think</span>}
        </div>
        <button className="unified-btn icon" onClick={() => setCollapsed(true)}>
          <X size={14} />
        </button>
      </header>

      <nav className="unified-tabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => {
          const Icon = TAB_ICONS[t];
          return (
            <button key={t} className={`unified-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              <Icon size={14} />
              {TAB_LABELS[t]}
            </button>
          );
        })}
      </nav>

      <div className="unified-content">
        {tab === "ask" && <AskView onThinkMode={setThinkActive} />}
        {tab === "search" && <SearchView />}
        {tab === "memory" && <MemoryView />}
        {tab === "graph" && <GraphView />}
        {tab === "cortex" && <Phase2CortexPanel />}
        {tab === "swarm" && <SwarmPanel />}
        {tab === "imagine" && <ImaginationPanel />}
        {tab === "evolve" && <EvolutionPanel />}
        {tab === "organism" && <OrganismPanel />}
      </div>
    </div>
  );
}
