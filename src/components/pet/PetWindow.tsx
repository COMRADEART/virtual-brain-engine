// Desktop pet: standalone Tauri companion window. It mirrors live agent events
// and Phase 2 personality state, can be dragged anywhere on screen, and can be
// expanded into a small chat surface that streams the brain's answers.
// It talks to the Node server over the existing /api + brain-bus seams and to
// the OS only through narrow, named Tauri commands — never the Tauri API package
// (a static import of that, or of Three.js, regresses the main canvas chunk).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Brain, Maximize2, MessageCircle, Send, X } from "lucide-react";
import { subscribeBrainBus } from "../../engine/brainBus";
import { apiClient } from "../../engine/apiClient";
import { MOOD_COLOR, MOOD_LABEL, moodFor, type Mood } from "./petMood";
import type { AgentRuntimeState } from "../../../shared/pipeline";
import type { PersonalityState } from "../../../shared/phase2";

const COLLAPSED: [number, number] = [220, 240];
const EXPANDED: [number, number] = [320, 440];

type TauriInternals = { invoke(cmd: string, args?: unknown): Promise<unknown> };

function tauriInvoke(): TauriInternals["invoke"] | null {
  if (typeof window === "undefined") return null;
  const internals = (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals?.invoke ? internals.invoke.bind(internals) : null;
}

async function invokeQuiet(cmd: string, args?: unknown): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) return;
  try {
    await invoke(cmd, args);
  } catch {
    /* best effort — no-op in the browser / when the command is unavailable */
  }
}

interface Exchange {
  question: string;
  answer: string;
}

interface PendingPlan {
  actionId: string;
  args: Record<string, unknown>;
  confirmToken?: string;
  rationale: string;
}

export function PetWindow(): JSX.Element {
  const [lastState, setLastState] = useState<AgentRuntimeState | null>(null);
  const [personality, setPersonality] = useState<PersonalityState | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [subtitle, setSubtitle] = useState<string>("starting up...");
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [asking, setAsking] = useState(false);
  // A resolved confirm-tier action awaiting the user's explicit Run/Cancel.
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const resetTimer = useRef<number | null>(null);
  const askAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    let stopped = false;
    const load = async () => {
      try {
        const state = (await invoke("pet_personality_state")) as PersonalityState;
        if (!stopped) setPersonality(state);
      } catch {
        /* best effort */
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type === "agent-status") {
        setLastState(message.state);
        if (resetTimer.current) window.clearTimeout(resetTimer.current);
        if (message.state === "thinking" || message.state === "acting") {
          resetTimer.current = window.setTimeout(() => setLastState("idle"), 8000);
        }
        return;
      }
      if (message.type === "activity-observed") {
        setSubtitle(message.detail);
        const invoke = tauriInvoke();
        if (invoke) {
          void invoke("update_pet_activity", {
            input: {
              activity: message.detail,
              workload: Math.min(1, message.fileCount / 12),
              agentCount: 1,
              projectName: message.projectName,
              novelty: 0.45,
            },
          })
            .then((state) => setPersonality(state as PersonalityState))
            .catch(() => {});
        }
        return;
      }
      if (message.type === "summary-created") {
        setSummary(message.summary);
        setSubtitle(
          message.projectName ? `summarized ${message.projectName}` : "summarized recent work",
        );
      }
    });
  }, []);

  // Abort any in-flight ask when the pet unmounts.
  useEffect(() => () => askAbort.current?.abort(), []);

  const applyExpanded = useCallback((next: boolean) => {
    setExpanded(next);
    const [width, height] = next ? EXPANDED : COLLAPSED;
    void invokeQuiet("pet_set_size", { width, height });
  }, []);

  const startDrag = useCallback(() => {
    void invokeQuiet("pet_start_drag");
  }, []);

  const openMainWindow = useCallback((event?: React.MouseEvent) => {
    event?.stopPropagation();
    void invokeQuiet("show_main_window");
  }, []);

  // Stream a question through the 7-step /api/ask pipeline into the current
  // exchange. Mirrors the UnifiedPanel contract: tokens on "response" progress,
  // the validated answer on "learning" complete. Assumes the exchange + asking
  // flags are already set by the caller.
  const streamAsk = useCallback(async (question: string) => {
    askAbort.current?.abort();
    const controller = new AbortController();
    askAbort.current = controller;
    let streamed = "";
    try {
      for await (const event of apiClient.ask({ prompt: question }, controller.signal)) {
        if (event.step === "response" && event.status === "progress" && event.tokensDelta) {
          streamed += event.tokensDelta;
          setExchange((c) => (c ? { ...c, answer: streamed } : c));
        }
        if (event.step === "learning" && event.status === "complete" && event.finalAnswer) {
          streamed = event.finalAnswer;
          setExchange((c) => (c ? { ...c, answer: event.finalAnswer as string } : c));
        }
        if (event.status === "error") {
          setExchange((c) => (c ? { ...c, answer: streamed || `⚠ ${event.detail ?? "pipeline error"}` } : c));
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : String(err);
        setExchange((c) => (c ? { ...c, answer: streamed || `⚠ ${msg}` } : c));
      }
    } finally {
      if (askAbort.current === controller) askAbort.current = null;
    }
  }, []);

  // Single entry point for the chat box: try to resolve the text as an
  // allowlisted COMMAND first. A safe command runs immediately; a confirm-tier
  // command parks as a pendingPlan for explicit Run/Cancel; anything that isn't
  // a command falls through to the /api/ask question pipeline.
  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || asking) return;
      if (!expanded) applyExpanded(true);
      setInput("");
      setPendingPlan(null);
      setExchange({ question: text, answer: "…" });
      setAsking(true);
      try {
        const resolved = await apiClient.resolveAction(text);
        if (resolved.plan) {
          const { actionId, args, rationale } = resolved.plan;
          if (resolved.needsConfirm) {
            setPendingPlan({ actionId, args, confirmToken: resolved.confirmToken, rationale });
            setExchange({ question: text, answer: rationale || `Run command “${actionId}”?` });
            return;
          }
          const result = await apiClient.executeAction({ actionId, args });
          if (result.ok && result.osDirective) {
            void invokeQuiet(result.osDirective.command, result.osDirective.args);
          }
          setExchange({ question: text, answer: result.ok ? result.summary : `⚠ ${result.error ?? "failed"}` });
          return;
        }
        // Not a command → answer it as a question.
        await streamAsk(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setExchange((c) => (c ? { ...c, answer: `⚠ ${msg}` } : c));
      } finally {
        setAsking(false);
      }
    },
    [asking, expanded, applyExpanded, streamAsk],
  );

  // Confirm + run a parked confirm-tier plan. The confirm token (minted at
  // resolve time, plan-bound + single-use) is what the server's gate requires.
  const runPending = useCallback(async () => {
    if (!pendingPlan || asking) return;
    const plan = pendingPlan;
    setPendingPlan(null);
    setAsking(true);
    setExchange((c) => (c ? { ...c, answer: "working…" } : c));
    try {
      const result = await apiClient.executeAction({
        actionId: plan.actionId,
        args: plan.args,
        confirmToken: plan.confirmToken,
      });
      // os-surface actions return a directive; the OS op runs here in Tauri.
      if (result.ok && result.osDirective) {
        void invokeQuiet(result.osDirective.command, result.osDirective.args);
      }
      setExchange((c) => (c ? { ...c, answer: result.ok ? result.summary : `⚠ ${result.error ?? "failed"}` } : c));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExchange((c) => (c ? { ...c, answer: `⚠ ${msg}` } : c));
    } finally {
      setAsking(false);
    }
  }, [pendingPlan, asking]);

  const cancelPending = useCallback(() => {
    setPendingPlan(null);
    setExchange((c) => (c ? { ...c, answer: "cancelled" } : c));
  }, []);

  const mood: Mood = useMemo(() => moodFor(lastState, personality), [lastState, personality]);
  const color = MOOD_COLOR[mood];
  const focus = Math.round((personality?.focus ?? 0.35) * 100);
  const arousal = Math.round((personality?.arousal ?? 0.25) * 100);
  const pulseSeconds = Math.max(1.6, 3.2 - arousal / 42);
  const orbitSeconds = Math.max(2.2, 5.2 - arousal / 25);

  return (
    <div className={`pet-root ${expanded ? "expanded" : ""}`}>
      <style>{`
        html, body, #root { background: transparent !important; margin: 0; height: 100%; overflow: hidden; }
        .pet-root {
          position: relative; width: 100vw; height: 100vh; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 8px;
          font-family: ui-monospace, "JetBrains Mono", monospace; user-select: none;
          -webkit-user-select: none;
        }
        .pet-root.expanded { justify-content: flex-start; padding-top: 6px; }
        .pet-controls {
          position: absolute; top: 6px; right: 8px; z-index: 5; display: flex; gap: 4px;
        }
        .pet-iconbtn {
          width: 22px; height: 22px; display: grid; place-items: center; cursor: pointer;
          border: none; border-radius: 6px; color: #c7c7da;
          background: rgba(20, 20, 30, 0.55); transition: background 160ms ease, color 160ms ease;
        }
        .pet-iconbtn:hover { background: rgba(40, 40, 60, 0.85); color: #fff; }
        .pet-drag { display: flex; flex-direction: column; align-items: center; gap: 8px; cursor: grab; }
        .pet-drag:active { cursor: grabbing; }
        .pet-stage { position: relative; width: 118px; height: 118px; display: grid; place-items: center; }
        .pet-root.expanded .pet-stage { width: 84px; height: 84px; }
        .pet-ring {
          position: absolute; inset: 0; border-radius: 50%;
          border: 1px solid ${color}66; opacity: 0.9;
          animation: petOrbit ${orbitSeconds}s linear infinite;
        }
        .pet-ring.second { inset: 10px; opacity: 0.55; animation-direction: reverse; }
        .pet-orb {
          position: relative; z-index: 2; width: 96px; height: 96px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          color: #0a0a0f; transition: background 220ms ease, box-shadow 220ms ease, width 200ms ease, height 200ms ease;
          animation: petPulse ${pulseSeconds}s ease-in-out infinite;
        }
        .pet-root.expanded .pet-orb { width: 66px; height: 66px; }
        .pet-orb::after {
          content: ""; position: absolute; width: 18px; height: 6px; border-radius: 999px;
          bottom: 23px; background: rgba(10, 10, 15, 0.54);
          box-shadow: ${mood === "curious" ? "12px -18px 0 -2px rgba(10,10,15,.5)" : "none"};
        }
        @keyframes petPulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }
        @keyframes petOrbit { to { transform: rotate(360deg); } }
        .pet-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
        .pet-sub {
          font-size: 10px; max-width: 200px; text-align: center; line-height: 1.35;
          color: #8888a0; display: -webkit-box; -webkit-line-clamp: 2;
          -webkit-box-orient: vertical; overflow: hidden;
        }
        .pet-meter {
          display: flex; align-items: center; gap: 6px; color: ${color};
          font-size: 9px; opacity: 0.9;
        }
        .pet-meter-bar {
          width: 56px; height: 3px; border-radius: 999px; background: rgba(255,255,255,0.14); overflow: hidden;
        }
        .pet-meter-bar span { display: block; width: ${focus}%; height: 100%; background: ${color}; }
        .pet-panel {
          flex: 1; width: calc(100% - 16px); margin: 6px 8px 8px; display: flex; flex-direction: column;
          min-height: 0; gap: 6px;
        }
        .pet-chat {
          flex: 1; min-height: 0; overflow-y: auto; padding: 8px; border-radius: 10px;
          background: rgba(12, 12, 20, 0.6); font-size: 11px; line-height: 1.45; color: #d6d6e6;
        }
        .pet-chat-q { color: ${color}; margin-bottom: 4px; }
        .pet-chat-a { white-space: pre-wrap; color: #c7c7da; }
        .pet-chat-empty { color: #6a6a82; font-size: 10px; }
        .pet-quick { display: flex; gap: 4px; flex-wrap: wrap; }
        .pet-quick button {
          font-size: 9px; padding: 3px 7px; border-radius: 999px; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.12); color: #b9b9cf; background: rgba(20,20,30,0.55);
        }
        .pet-quick button:hover { background: rgba(40,40,60,0.85); color: #fff; }
        .pet-quick button:disabled { opacity: 0.4; cursor: default; }
        .pet-inputbar {
          display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 10px;
          border-radius: 999px; background: rgba(12, 12, 20, 0.72); border: 1px solid ${color}44;
        }
        .pet-inputbar input {
          flex: 1; background: transparent; border: none; outline: none; color: #eaeaf4;
          font-size: 11px; font-family: inherit;
        }
        .pet-inputbar input::placeholder { color: #6a6a82; }
        .pet-send {
          width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer;
          border: none; border-radius: 50%; color: #0a0a0f; background: ${color};
        }
        .pet-send:disabled { opacity: 0.4; cursor: default; }
      `}</style>

      <div className="pet-controls">
        <button
          type="button"
          className="pet-iconbtn"
          title={expanded ? "Collapse" : "Chat with the brain"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => applyExpanded(!expanded)}
        >
          {expanded ? <X size={13} /> : <MessageCircle size={13} />}
        </button>
        <button
          type="button"
          className="pet-iconbtn"
          title="Open Brain OS"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={openMainWindow}
        >
          <Maximize2 size={13} />
        </button>
      </div>

      <div className="pet-drag" onMouseDown={startDrag} title="Drag to move">
        <div className="pet-stage">
          <div className="pet-ring" />
          <div className="pet-ring second" />
          <div
            className="pet-orb"
            style={{ background: color, boxShadow: `0 0 28px 6px ${color}66` }}
            aria-label={`Brain pet - ${MOOD_LABEL[mood]}`}
          >
            <Brain size={expanded ? 30 : 44} strokeWidth={1.6} />
          </div>
        </div>
        <div className="pet-label" style={{ color }}>
          {MOOD_LABEL[mood]}
        </div>
        <div className="pet-meter">
          <Activity size={10} />
          <div className="pet-meter-bar"><span /></div>
          <span>{focus}</span>
        </div>
        {!expanded ? <div className="pet-sub">{summary || subtitle}</div> : null}
        {!expanded && personality?.notification ? (
          <div className="pet-sub">{personality.notification}</div>
        ) : null}
      </div>

      {expanded ? (
        <div className="pet-panel">
          <div className="pet-chat">
            {exchange ? (
              <>
                <div className="pet-chat-q">› {exchange.question}</div>
                <div className="pet-chat-a">
                  {exchange.answer || (asking ? "thinking…" : "")}
                </div>
              </>
            ) : (
              <div className="pet-chat-empty">{summary || subtitle}</div>
            )}
          </div>
          {pendingPlan ? (
            <div className="pet-quick" role="group" aria-label="Confirm action">
              <button type="button" disabled={asking} onClick={() => void runPending()}>
                run ✓
              </button>
              <button type="button" disabled={asking} onClick={cancelPending}>
                cancel
              </button>
            </div>
          ) : (
            <div className="pet-quick">
              <button
                type="button"
                disabled={asking}
                onClick={() => void submit("What am I working on right now?")}
              >
                what am I doing?
              </button>
              <button type="button" onClick={openMainWindow}>
                open brain os
              </button>
            </div>
          )}
          <form
            className="pet-inputbar"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(input);
            }}
          >
            <input
              type="text"
              placeholder="ask, command, or learn a url…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
            <button type="submit" className="pet-send" disabled={asking || !input.trim()}>
              <Send size={12} />
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
