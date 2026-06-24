// Deep Research Panel — the Fable-style /deep-research surface, live.
//
// Drives POST /api/research/deep and renders the investigation as it happens:
// the plan (sub-questions), per-round gathering (local memory + egress-gated
// web sources), streamed cited findings, reflection, and the final cited report
// (rendered through the shared RichText citation renderer; saved to memory). The
// 3D brain flashes its cortices from the same run via the WS bus (see BrainScene).
//
// Gate-safety (the SpinePanel/CognitionStreamPanel contract): renders null until
// the WS bus connects; no <input type=range>; icon-only action buttons (no text
// colliding with the 7 region-action labels); private `.dresearch-*` CSS
// namespace; errors render to the UI, never console.error.

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Database, Globe, Loader2, Square, Telescope } from "lucide-react";
import { subscribeConnection } from "../../engine/brainBus";
import { apiClient } from "../../engine/apiClient";
import { RichText } from "../RichText";
import type { DeepResearchReport, ResearchFinding, ResearchSource } from "../../../shared/research";

export interface DeepResearchPanelProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

// Merge new sources into the running set, keeping each memory's best score.
function mergeSources(prev: ResearchSource[], next: ResearchSource[]): ResearchSource[] {
  const byId = new Map(prev.map((s) => [s.memoryId, s]));
  for (const s of next) {
    const existing = byId.get(s.memoryId);
    if (!existing || s.score > existing.score) byId.set(s.memoryId, s);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

export function DeepResearchPanel({ collapsed, onCollapsedChange }: DeepResearchPanelProps): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("");
  const [round, setRound] = useState(0);
  const [plan, setPlan] = useState<string[]>([]);
  const [findings, setFindings] = useState<ResearchFinding[]>([]);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [reportText, setReportText] = useState("");
  const [report, setReport] = useState<DeepResearchReport | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => subscribeConnection(setBusOk), []);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function run(): Promise<void> {
    const q = question.trim();
    if (!q || running) return;
    setRunning(true);
    setError(null);
    setPhase("planning…");
    setRound(0);
    setPlan([]);
    setFindings([]);
    setSources([]);
    setReportText("");
    setReport(null);
    setHighlighted(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      for await (const ev of apiClient.deepResearch({ question: q }, ctrl.signal)) {
        switch (ev.type) {
          case "research-start":
            setPhase(ev.localOnly ? "researching (local memory only)…" : "researching (local + web)…");
            break;
          case "plan":
            setRound(ev.round);
            setPlan(ev.subQuestions);
            setPhase(`round ${ev.round}: planning ${ev.subQuestions.length} sub-questions`);
            break;
          case "gather":
            setSources((prev) => mergeSources(prev, ev.sources));
            setPhase(`round ${ev.round}: gathering — ${ev.subQuestion}`);
            break;
          case "synthesize":
            setFindings((prev) => [...prev, ev.finding]);
            break;
          case "reflect":
            setPhase(ev.converged ? "converged — writing report…" : `round ${ev.round}: ${ev.gaps.length} gaps → next round`);
            break;
          case "report-delta":
            setReportText((prev) => prev + ev.tokensDelta);
            break;
          case "report":
            setReport(ev.report);
            setReportText(ev.report.report);
            setSources(ev.report.sources);
            setPhase("done");
            break;
          case "error":
            setError(ev.detail);
            break;
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setRunning(false);
    }
  }

  function stop(): void {
    abortRef.current?.abort();
    setRunning(false);
    setPhase("stopped");
  }

  const knownIds = useMemo(() => new Set(sources.map((s) => s.memoryId)), [sources]);

  if (!busOk) return null;

  const webCount = sources.filter((s) => s.origin === "web").length;

  return (
    <aside className="dresearch-panel" aria-label="Deep Research">
      <header className="dresearch-head">
        <Telescope size={14} />
        <span>Deep research</span>
        {sources.length > 0 && (
          <span className="dresearch-counts" title="sources gathered">
            <em className="src-local">{sources.length - webCount}</em>
            <em className="src-web">{webCount}</em>
          </span>
        )}
        <button
          type="button"
          className="dresearch-toggle"
          aria-label={collapsed ? "Expand Deep Research" : "Collapse Deep Research"}
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="dresearch-body">
          {error && <p className="dresearch-error">{error}</p>}

          <form
            className="dresearch-ask"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <input
              className="dresearch-input"
              type="text"
              placeholder="Research a question deeply…"
              aria-label="Deep research question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={running}
            />
            {running ? (
              <button type="button" className="dresearch-go" aria-label="Stop research" onClick={stop}>
                <Square size={13} />
              </button>
            ) : (
              <button type="submit" className="dresearch-go" aria-label="Start deep research" disabled={question.trim().length === 0}>
                <Telescope size={13} />
              </button>
            )}
          </form>

          {(running || phase) && (
            <div className="dresearch-status">
              {running && <Loader2 size={12} className="dresearch-spin" />}
              <span>{phase}</span>
              {round > 0 && <span className="dresearch-round">r{round}</span>}
            </div>
          )}

          {plan.length > 0 && (
            <ol className="dresearch-plan">
              {/* ponytail: index keys — plan is replaced wholesale each round (setPlan),
                  never reordered mid-list, so index keys are correct here. */}
              {plan.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          )}

          {findings.length > 0 && !report && (
            <ul className="dresearch-findings">
              {/* ponytail: index keys — findings are append-only (one per sub-question,
                  pushed in order), so index keys are correct; revisit if insertion reorders. */}
              {findings.map((f, i) => (
                <li key={i}>
                  <span className="dresearch-fq">{f.subQuestion}</span>
                  <span className="dresearch-fa">
                    <RichText text={f.summary} knownIds={knownIds} onClickCitation={setHighlighted} />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {reportText && (
            <div className="dresearch-report">
              <RichText text={reportText} knownIds={knownIds} onClickCitation={setHighlighted} />
            </div>
          )}

          {sources.length > 0 && (
            <div className="dresearch-sources">
              <div className="dresearch-sources-head">
                {sources.length} source{sources.length === 1 ? "" : "s"}
                {report?.reportMemoryId && <span className="dresearch-saved" title="The report was saved to memory">· saved</span>}
              </div>
              <ul>
                {sources.map((s) => (
                  <li
                    key={s.memoryId}
                    className={highlighted === s.memoryId ? "dresearch-src highlight" : "dresearch-src"}
                  >
                    {s.origin === "web" ? <Globe size={11} /> : <Database size={11} />}
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                        {s.title ?? s.url}
                      </a>
                    ) : (
                      <span title={s.title ?? s.memoryId}>{s.title ?? `m:${s.memoryId.slice(-6)}`}</span>
                    )}
                    <span className="dresearch-score">{s.score.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!running && !report && !error && findings.length === 0 && (
            <p className="dresearch-empty">
              Ask a hard question — the brain plans sub-questions, gathers from memory and (when not local-only) the
              web, and writes a cited report it saves to memory.
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
