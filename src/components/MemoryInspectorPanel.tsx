// Memory Inspector — the transparency surface: what does the brain know about
// me, where did each memory come from, and how do I make it forget?
//
// Three views over the same store:
//   * Recent  — newest memories with provenance (source, path, importance) and
//               a per-memory Forget button (DELETE /api/memory/:id).
//   * Search  — the hybrid vector+keyword search, same Forget affordance.
//   * Merged  — the dedup tombstone audit trail, with Restore (undo a merge).
// Plus a one-click corpus export (GET /api/memory/export).
//
// Gate-safety rules (mirror BrainStatePanel.tsx — the smoke tests assume them):
//   * Renders null until the WS bus connects (test:all boots Vite WITHOUT the
//     server, so the bus never connects and this renders nothing).
//   * No <input type=range> (smoke-actions grabs the last range slider).
//   * No <button> text colliding with the 7 action labels or "L Memory".
//   * Private `.meminspect-*` CSS namespace.
//   * Errors render to the UI, never console.error (smoke counts those).

import { useCallback, useEffect, useState } from "react";
import { Archive, ChevronDown, ChevronUp, Download, Loader2, RotateCcw, Search, Trash2 } from "lucide-react";
import { subscribeConnection } from "../engine/brainBus";
import { apiClient, ApiError } from "../engine/apiClient";
import type { MemoryPoint } from "../../shared/memory";

type View = "recent" | "search" | "merged";

interface Tombstone {
  id: string;
  keptId: string;
  reason: string;
  similarity: number | null;
  title: string | null;
  contentPreview: string;
  createdAt: string;
}

const PAGE_SIZE = 12;

function provenanceOf(m: MemoryPoint): string {
  const source = m.metadata?.["source"];
  if (typeof source === "string") {
    const path = m.metadata?.["sourcePath"];
    return typeof path === "string" && path ? `${source} · ${path}` : source;
  }
  if (m.filePath) return `file · ${m.filePath}`;
  return m.sourceType;
}

function isExternal(m: MemoryPoint): boolean {
  const source = m.metadata?.["source"];
  return source === "ingest:web" || source === "ingest:github";
}

function MemoryRow({
  memory,
  onForget,
  busy,
}: {
  memory: MemoryPoint;
  onForget: (id: string) => void;
  busy: boolean;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="meminspect-row">
      <div className="meminspect-row-main">
        <header>
          <span className="meminspect-title" title={memory.title ?? memory.id}>
            {memory.title || memory.filePath || memory.id.slice(-10)}
          </span>
          {isExternal(memory) ? <small className="meminspect-flag-ext">internet</small> : null}
          <small className="meminspect-imp" title="importance">
            {(memory.importance * 100).toFixed(0)}%
          </small>
        </header>
        <p>{memory.content.slice(0, 180)}{memory.content.length > 180 ? "…" : ""}</p>
        <small className="meminspect-prov" title={provenanceOf(memory)}>
          {provenanceOf(memory)} · {new Date(memory.createdAt).toLocaleDateString()}
        </small>
      </div>
      {confirming ? (
        <span className="meminspect-confirm">
          <button type="button" className="meminspect-danger" disabled={busy} onClick={() => onForget(memory.id)}>
            Forget it
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="meminspect-forget"
          aria-label={`Forget memory ${memory.id}`}
          title="Permanently delete this memory"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <Trash2 size={13} />
        </button>
      )}
    </li>
  );
}

export function MemoryInspectorPanel(): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [view, setView] = useState<View>("recent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [memories, setMemories] = useState<MemoryPoint[]>([]);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [tombstones, setTombstones] = useState<Tombstone[]>([]);

  useEffect(() => subscribeConnection(setBusOk), []);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
  }, []);

  const loadRecent = useCallback(
    (nextOffset: number) => {
      setBusy(true);
      setError(null);
      apiClient
        .recentMemories(PAGE_SIZE, undefined, nextOffset)
        .then((res) => {
          setMemories(res.memories);
          setOffset(nextOffset);
        })
        .catch(fail)
        .finally(() => setBusy(false));
    },
    [fail],
  );

  const runSearch = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    apiClient
      .searchMemory(trimmed, { limit: PAGE_SIZE })
      .then((res) => setMemories(res.hits.map((h) => h.memory)))
      .catch(fail)
      .finally(() => setBusy(false));
  }, [fail, query]);

  const loadTombstones = useCallback(() => {
    setBusy(true);
    setError(null);
    apiClient
      .memoryTombstones()
      .then((res) => setTombstones(res.tombstones))
      .catch(fail)
      .finally(() => setBusy(false));
  }, [fail]);

  // Seed the active view when the panel opens or the view switches.
  useEffect(() => {
    if (!busOk || collapsed) return;
    if (view === "recent") loadRecent(0);
    else if (view === "merged") loadTombstones();
  }, [busOk, collapsed, view, loadRecent, loadTombstones]);

  const forget = useCallback(
    (id: string) => {
      setBusy(true);
      apiClient
        .deleteMemory(id)
        .then(() => setMemories((ms) => ms.filter((m) => m.id !== id)))
        .catch(fail)
        .finally(() => setBusy(false));
    },
    [fail],
  );

  const restore = useCallback(
    (id: string) => {
      setBusy(true);
      apiClient
        .restoreTombstone(id)
        .then(() => setTombstones((ts) => ts.filter((t) => t.id !== id)))
        .catch(fail)
        .finally(() => setBusy(false));
    },
    [fail],
  );

  if (!busOk) return null;

  return (
    <aside className="meminspect-panel" aria-label="Memory Inspector">
      <header className="meminspect-head">
        <Archive size={14} />
        <span>Memory Inspector</span>
        <button
          type="button"
          className="meminspect-toggle"
          aria-label={collapsed ? "Expand Memory Inspector" : "Collapse Memory Inspector"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="meminspect-body">
          <nav className="meminspect-tabs" aria-label="Memory views">
            <button type="button" className={view === "recent" ? "on" : ""} onClick={() => setView("recent")}>
              Recent
            </button>
            <button type="button" className={view === "search" ? "on" : ""} onClick={() => setView("search")}>
              Find
            </button>
            <button type="button" className={view === "merged" ? "on" : ""} onClick={() => setView("merged")}>
              Merged
            </button>
            <a
              className="meminspect-export"
              href={apiClient.memoryExportUrl()}
              download="brain-memory-export.txt"
              title="Download everything the brain knows as plain text"
            >
              <Download size={12} /> Export
            </a>
          </nav>

          {error ? <p className="meminspect-error">{error}</p> : null}
          {busy ? <p className="meminspect-busy"><Loader2 size={12} className="ai-spin" /> working…</p> : null}

          {view === "search" ? (
            <div className="meminspect-search">
              <input
                type="text"
                placeholder="what do you remember about…"
                value={query}
                disabled={busy}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runSearch();
                  }
                }}
              />
              <button type="button" disabled={!query.trim() || busy} onClick={runSearch} aria-label="Search memories">
                <Search size={13} />
              </button>
            </div>
          ) : null}

          {view !== "merged" ? (
            memories.length > 0 ? (
              <ul className="meminspect-list">
                {memories.map((m) => (
                  <MemoryRow key={m.id} memory={m} onForget={forget} busy={busy} />
                ))}
              </ul>
            ) : (
              <p className="meminspect-empty">
                {view === "recent" ? "No memories yet." : "No matches."}
              </p>
            )
          ) : tombstones.length > 0 ? (
            <ul className="meminspect-list">
              {tombstones.map((t) => (
                <li key={t.id} className="meminspect-row">
                  <div className="meminspect-row-main">
                    <header>
                      <span className="meminspect-title">{t.title || t.id.slice(-10)}</span>
                      {t.similarity !== null ? (
                        <small className="meminspect-imp" title="similarity at merge time">
                          {(t.similarity * 100).toFixed(0)}%
                        </small>
                      ) : null}
                    </header>
                    <p>{t.contentPreview}</p>
                    <small className="meminspect-prov">
                      merged into {t.keptId.slice(-10)} · {new Date(t.createdAt).toLocaleDateString()}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="meminspect-restore"
                    aria-label={`Restore memory ${t.id}`}
                    title="Undo this merge — bring the memory back"
                    disabled={busy}
                    onClick={() => restore(t.id)}
                  >
                    <RotateCcw size={13} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="meminspect-empty">No merged-away memories — dedup has deleted nothing.</p>
          )}

          {view === "recent" ? (
            <footer className="meminspect-pager">
              <button type="button" disabled={busy || offset === 0} onClick={() => loadRecent(Math.max(0, offset - PAGE_SIZE))}>
                Newer
              </button>
              <small>{offset + 1}–{offset + memories.length}</small>
              <button type="button" disabled={busy || memories.length < PAGE_SIZE} onClick={() => loadRecent(offset + PAGE_SIZE)}>
                Older
              </button>
            </footer>
          ) : null}
        </div>
      )}
    </aside>
  );
}
