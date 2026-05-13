import { useCallback, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { apiClient, ApiError } from "../engine/apiClient";
import type { MemoryPoint } from "../../shared/memory";

interface Hit {
  score: number;
  matchType: "vector" | "keyword" | "hybrid";
  memory: MemoryPoint;
}

export function SearchPanel(): JSX.Element {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vectorWarning, setVectorWarning] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setVectorWarning(null);
    setHits([]);
    try {
      const res = await apiClient.searchMemory(trimmed, { limit: 15 });
      setHits(res.hits);
      if (res.vectorError) {
        setVectorWarning(res.vectorError);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, query]);

  return (
    <div className="brain-os-section">
      <p className="ai-hint">
        Hybrid vector + keyword search across everything that has been embedded so far.
      </p>
      <div className="ai-row">
        <input
          type="text"
          placeholder='e.g. "signal simulation"'
          value={query}
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="ai-send" type="button" disabled={!query.trim() || busy} onClick={() => void submit()}>
          {busy ? <Loader2 size={14} className="ai-spin" /> : <Search size={14} />} Search
        </button>
      </div>
      {vectorWarning ? <p className="ai-offline-hint">Vector search unavailable: {vectorWarning}</p> : null}
      {error ? <p className="ai-error">{error}</p> : null}
      {hits.length > 0 ? (
        <ul className="search-hits">
          {hits.map((hit) => (
            <li key={hit.memory.id} className={`search-hit ${hit.matchType}`}>
              <header>
                <span className="search-hit-path">
                  {hit.memory.filePath ?? hit.memory.title ?? hit.memory.id.slice(-8)}
                </span>
                <small>
                  {hit.matchType} · {(hit.score * 100).toFixed(0)}%
                </small>
              </header>
              <p>{hit.memory.content.slice(0, 220)}{hit.memory.content.length > 220 ? "…" : ""}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {!busy && !error && hits.length === 0 && query.trim() ? (
        <p className="ai-hint">No matches yet.</p>
      ) : null}
    </div>
  );
}
