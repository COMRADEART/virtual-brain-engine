// Mind — the cognitive-organism introspection panel.
//
// The server grew ~24 read surfaces under /api/brain/* (beliefs, goal tree,
// procedures, episodes, neuromodulators, maturation, self/narrative) that had
// ZERO frontend reach — the organism was built but unobservable. This ONE
// tabbed panel exposes the highest-value ones; the rest stay API-only.
//
// Gate-safety rules (mirror BrainStatePanel.tsx — the smoke tests assume them):
//   * Renders null until the WS bus connects.
//   * No <input type=range>; no <button> text colliding with the 7 action labels.
//   * Private `.mind-*` CSS namespace.
//   * Errors render to the UI, never console.error.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Sparkles, User } from "lucide-react";
import { subscribeConnection } from "../../engine/brainBus";
import {
  apiClient,
  type BrainBeliefsView,
  type BrainGoalTreeView,
  type ContinuityView,
  type DaemonListView,
  type DaemonView,
  type EpisodeView,
  type GoalPursuitReportView,
  type MaturationStatusView,
  type ModulatorStatusView,
  type NarrativeView,
  type ProcedureView,
  type SelfRepresentationView,
} from "../../engine/apiClient";
import { beliefTone, flattenGoalTree, modulatorRows, stanceLabel } from "./mindFormat";
import { SystemStatusPanel } from "../SystemStatusPanel";
import { useUiPrefs } from "../../engine/uiPrefs";

const POLL_MS = 6_000;
const TABS = ["beliefs", "goals", "procedures", "episodes", "modulators", "self", "person", "system"] as const;
type MindTab = (typeof TABS)[number];

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

interface MindPanelProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function MindPanel({ collapsed, onCollapsedChange }: MindPanelProps): JSX.Element | null {
  const [busOk, setBusOk] = useState(false);
  const [tab, setTab] = useState<MindTab>("beliefs");
  const [error, setError] = useState<string | null>(null);
  const [beliefs, setBeliefs] = useState<BrainBeliefsView | null>(null);
  const [goals, setGoals] = useState<BrainGoalTreeView | null>(null);
  const [procedures, setProcedures] = useState<ProcedureView[] | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeView[] | null>(null);
  const [modulators, setModulators] = useState<ModulatorStatusView | null>(null);
  const [maturation, setMaturation] = useState<MaturationStatusView | null>(null);
  const [self, setSelf] = useState<SelfRepresentationView | null>(null);
  const [narrative, setNarrative] = useState<NarrativeView | null>(null);
  const [pursuit, setPursuit] = useState<GoalPursuitReportView | null>(null);
  const [pursuing, setPursuing] = useState(false);
  const [continuity, setContinuity] = useState<ContinuityView | null>(null);
  const [daemons, setDaemons] = useState<DaemonListView | null>(null);

  const { prefs } = useUiPrefs();
  const listenerEnabled = prefs.personListener.enabled;
  const personHotword = prefs.personListener.hotwords[0] ?? "brain";

  useEffect(() => subscribeConnection(setBusOk), []);

  const refresh = useCallback((active: MindTab): void => {
    const fail = (err: unknown): void => setError(err instanceof Error ? err.message : String(err));
    const ok = (): void => setError(null);
    switch (active) {
      case "beliefs":
        apiClient.brainBeliefs().then((v) => { setBeliefs(v); ok(); }).catch(fail);
        break;
      case "goals":
        apiClient.brainGoalTree().then((v) => { setGoals(v); ok(); }).catch(fail);
        break;
      case "procedures":
        apiClient.brainProcedures().then((v) => { setProcedures(v.procedures); ok(); }).catch(fail);
        break;
      case "episodes":
        apiClient.brainEpisodes().then((v) => { setEpisodes(v.episodes); ok(); }).catch(fail);
        break;
      case "modulators":
        apiClient.brainModulators().then((v) => { setModulators(v); ok(); }).catch(fail);
        apiClient.brainMaturation().then(setMaturation).catch(() => {});
        break;
      case "self":
        apiClient.brainSelf().then((v) => { setSelf(v); ok(); }).catch(fail);
        apiClient.brainNarrative().then((v) => setNarrative(v.narrative)).catch(() => {});
        break;
      case "person":
        apiClient.continuity("full").then((v) => { setContinuity(v); ok(); }).catch(fail);
        apiClient.daemonList().then((v) => { setDaemons(v); ok(); }).catch(fail);
        break;
      case "system":
        break; // SystemStatusPanel polls itself.
    }
  }, []);

  // Poll the active tab while open + connected.
  useEffect(() => {
    if (!busOk || collapsed) return;
    let cancelled = false;
    refresh(tab);
    const id = window.setInterval(() => {
      if (!cancelled) refresh(tab);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [busOk, collapsed, tab, refresh]);

  const pursueNow = useCallback((): void => {
    setPursuing(true);
    apiClient
      .brainGoalsPursue()
      .then((report) => {
        setPursuit(report);
        refresh("goals");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPursuing(false));
  }, [refresh]);

  if (!busOk) return null;

  return (
    <aside className="mind-panel" aria-label="Mind">
      <header className="mind-head">
        <Sparkles size={14} />
        <span>Mind</span>
        {beliefs ? <small className="mind-badge">{beliefs.stats.total} belief{beliefs.stats.total === 1 ? "" : "s"}</small> : null}
        <button
          type="button"
          className="mind-toggle"
          aria-label={collapsed ? "Expand Mind" : "Collapse Mind"}
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </header>

      {!collapsed && (
        <div className="mind-body">
          <nav className="mind-tabs" aria-label="Mind sections">
            {TABS.map((t) => (
              <button key={t} type="button" className={`mind-tab ${t === tab ? "on" : ""}`} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </nav>

          {tab === "beliefs" && (
            <section className="mind-section">
              {beliefs && beliefs.beliefs.length > 0 ? (
                <ul className="mind-list">
                  {beliefs.beliefs.map((b) => (
                    <li key={b.id} className="mind-belief-row" title={`${b.evidenceCount} evidence · updated ${b.lastUpdated}`}>
                      <span className={`mind-conf ${beliefTone(b.confidence)}`}>{b.confidence.toFixed(2)}</span>
                      <span className="mind-belief-text">{b.statement}</span>
                      <span className={`mind-stance st-${b.status}`}>{stanceLabel(b.status)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mind-empty">No beliefs yet — they form as the brain sleeps and distills experience.</p>
              )}
            </section>
          )}

          {tab === "goals" && (
            <section className="mind-section">
              <div className="mind-actions-row">
                <button type="button" className="mind-btn" onClick={pursueNow} disabled={pursuing}>
                  {pursuing ? "Pursuing…" : "Pursue now"}
                </button>
                {pursuit ? (
                  <small className="mind-pursuit-note">
                    {pursuit.pursued
                      ? `worked on "${pursuit.title}" — ${pursuit.status}`
                      : pursuit.reason ?? "nothing to pursue"}
                  </small>
                ) : null}
              </div>
              {goals && goals.tree.length > 0 ? (
                <ul className="mind-list">
                  {flattenGoalTree(goals.tree).map((g) => (
                    <li key={g.id} className="mind-goal-row" style={{ paddingLeft: `${g.depth * 14}px` }}>
                      <span className="mind-goal-title" title={`${g.level} · priority ${g.priority}`}>{g.title}</span>
                      <span className={`mind-goal-status st-${g.status}`}>{g.status}</span>
                      <span className="mind-goal-track"><span className="mind-goal-fill" style={{ width: pct(g.progress) }} /></span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mind-empty">No goals in the tree.</p>
              )}
            </section>
          )}

          {tab === "procedures" && (
            <section className="mind-section">
              {procedures && procedures.length > 0 ? (
                <ul className="mind-list">
                  {procedures.map((p) => (
                    <li key={p.id} className="mind-proc-row" title={p.steps.join(" → ")}>
                      <span className="mind-proc-score">{p.score.toFixed(2)}</span>
                      <span className="mind-proc-title">{p.title}</span>
                      <small className="mind-proc-tally">✓{p.successCount} ✗{p.failureCount}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mind-empty">No learned procedures yet — they're mined from action sequences during sleep.</p>
              )}
            </section>
          )}

          {tab === "episodes" && (
            <section className="mind-section">
              {episodes && episodes.length > 0 ? (
                <ul className="mind-list">
                  {episodes.map((e) => (
                    <li key={e.id} className="mind-episode-row">
                      <span className="mind-episode-title">{e.title}</span>
                      <small className="mind-episode-meta">{e.itemCount} item{e.itemCount === 1 ? "" : "s"} · {new Date(e.startedAt).toLocaleString()}</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mind-empty">No episodes segmented yet.</p>
              )}
            </section>
          )}

          {tab === "modulators" && (
            <section className="mind-section">
              {modulators ? (
                <>
                  <ul className="mind-list">
                    {modulatorRows(modulators).map(([name, level, baseline]) => (
                      <li key={name} className="mind-mod-row">
                        <span className="mind-mod-name">{name}</span>
                        <span className="mind-mod-track">
                          <span className="mind-mod-baseline" style={{ left: pct(baseline) }} />
                          <span className="mind-mod-fill" style={{ width: pct(level) }} />
                        </span>
                        <span className="mind-mod-val">{level.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                  {maturation ? (
                    <p className="mind-note">
                      developmental stage <strong>{maturation.stage}</strong>
                      {" · "}
                      {maturation.features.filter((f) => f.active).length}/{maturation.features.length} matured features active
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="mind-empty">Loading modulators…</p>
              )}
            </section>
          )}

          {tab === "self" && (
            <section className="mind-section">
              {self ? (
                <dl className="mind-self">
                  <dt>identity</dt><dd>{self.identity || "(still forming)"}</dd>
                  <dt>doing</dt><dd>{self.doing || "—"}</dd>
                  <dt>becoming</dt><dd>{self.becoming || "—"}</dd>
                  <dt>character</dt><dd>{self.character} · feels {self.emotion.name} ({self.emotion.value.toFixed(2)})</dd>
                  {narrative ? <><dt>narrative</dt><dd>{narrative.identity} {narrative.arc}</dd></> : null}
                </dl>
              ) : (
                <p className="mind-empty">No self-representation yet.</p>
              )}
            </section>
          )}

          {tab === "person" && (
            <section className="mind-section mind-person">
              {continuity ? (
                <div className="mind-person-block">
                  <header className="mind-person-head">
                    <strong>Since last time</strong>
                    <small className="mind-person-meta">{continuity.greeting}</small>
                  </header>
                  <p className="mind-person-briefing">{continuity.briefing}</p>
                </div>
              ) : (
                <p className="mind-empty">Loading continuity briefing…</p>
              )}

              <div className="mind-person-block">
                <header className="mind-person-head">
                  <strong>Watches</strong>
                  {daemons ? (
                    <small className="mind-person-meta">
                      {daemons.counts.running}/{daemons.counts.total} running
                    </small>
                  ) : null}
                </header>
                {daemons && daemons.daemons.length > 0 ? (
                  <ul className="mind-list">
                    {daemons.daemons.slice(0, 5).map((d: DaemonView) => (
                      <li key={d.id} className={`mind-daemon-row st-${d.status}`}>
                        <span className="mind-daemon-title">{d.title}</span>
                        <span className={`mind-daemon-status st-${d.status}`}>{d.status}</span>
                        <small className="mind-daemon-tally">
                          {d.runCount} run{d.runCount === 1 ? "" : "s"}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mind-empty">No watches yet — ask the pet to "watch my downloads folder" or use an action.</p>
                )}
              </div>

              <div className="mind-person-block">
                <header className="mind-person-head">
                  <strong>Listener</strong>
                </header>
                <p className="mind-person-note">
                  {listenerEnabled
                    ? `👂 listening for "${personHotword}"`
                    : "Mic off — enable in Settings → Voice → Always listen."}
                </p>
              </div>
            </section>
          )}

          {tab === "system" && (
            <section className="mind-section mind-system">
              <SystemStatusPanel />
            </section>
          )}

          {error ? <p className="mind-err">{error}</p> : null}
        </div>
      )}
    </aside>
  );
}
