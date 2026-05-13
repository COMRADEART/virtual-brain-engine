import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiClient } from "../engine/apiClient";
import type { MemoryPoint, MemoryRelation, MemorySourceType } from "../../shared/memory";

const TABS: Array<{ id: MemorySourceType | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "chunk", label: "Files" },
  { id: "conversation", label: "Conversations" },
];

interface ExpandedDetail {
  memory: MemoryPoint;
  relations: MemoryRelation[];
}

export function MemoryDashboard(): JSX.Element {
  const [activeTab, setActiveTab] = useState<MemorySourceType | "all">("all");
  const [memories, setMemories] = useState<MemoryPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, ExpandedDetail | "loading" | undefined>>({});
  const [filter, setFilter] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const kind = activeTab === "all" ? undefined : activeTab;
      const res = await apiClient.recentMemories(60, kind);
      setMemories(res.memories);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeTab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(async (memory: MemoryPoint) => {
    setExpanded((current) => {
      const next = { ...current };
      if (next[memory.id]) {
        delete next[memory.id];
      } else {
        next[memory.id] = "loading";
      }
      return next;
    });
    if (expanded[memory.id]) {
      return;
    }
    try {
      const detail = await apiClient.getMemory(memory.id);
      setExpanded((current) => ({ ...current, [memory.id]: detail }));
    } catch (err) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[memory.id];
        return next;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [expanded]);

  const visible = filter.trim()
    ? memories.filter((m) =>
        [m.content, m.filePath ?? "", m.title ?? "", m.projectName ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : memories;

  return (
    <div className="brain-os-section">
      <div className="ai-row" style={{ justifyContent: "space-between" }}>
        <nav className="segmented" style={{ flex: 1 }}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <button className="ai-icon-button" type="button" aria-label="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={14} />
        </button>
      </div>
      <input
        type="text"
        className="memory-filter"
        placeholder="Filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {error ? <p className="ai-error">{error}</p> : null}
      {busy && memories.length === 0 ? <p className="ai-hint">Loading…</p> : null}
      {visible.length === 0 && !busy && !error ? (
        <p className="ai-hint">
          {filter ? "No matches in current view." : "No memories yet. Run a scan or ask a question."}
        </p>
      ) : null}
      <ul className="memory-list">
        {visible.map((memory) => {
          const detail = expanded[memory.id];
          const isOpen = !!detail;
          return (
            <li key={memory.id} className={`memory-row ${isOpen ? "expanded" : ""}`}>
              <button type="button" className="memory-toggle" onClick={() => void toggle(memory)}>
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="memory-kind">{memory.sourceType}</span>
                <span className="memory-path" title={memory.filePath ?? memory.title ?? memory.id}>
                  {memory.filePath ?? memory.title ?? memory.id.slice(-8)}
                </span>
                {memory.projectName ? <span className="memory-project">{memory.projectName}</span> : null}
              </button>
              {!isOpen ? (
                <p className="memory-preview">
                  {memory.content.slice(0, 180)}
                  {memory.content.length > 180 ? "…" : ""}
                </p>
              ) : null}
              {detail === "loading" ? <p className="ai-hint">Loading details…</p> : null}
              {detail && detail !== "loading" ? (
                <div className="memory-detail">
                  <pre>{detail.memory.content}</pre>
                  <div className="memory-meta">
                    <small>importance {detail.memory.importance.toFixed(2)}</small>
                    <small>updated {new Date(detail.memory.updatedAt).toLocaleString()}</small>
                  </div>
                  {detail.relations.length > 0 ? (
                    <ul className="memory-relations">
                      {detail.relations.map((relation) => (
                        <li key={relation.id}>
                          <code>{relation.kind}</code>
                          <span>
                            {relation.fromId === memory.id ? "→ " : "← "}
                            {(relation.fromId === memory.id ? relation.toId : relation.fromId).slice(-8)}
                          </span>
                          <small>w {relation.weight.toFixed(2)}</small>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
