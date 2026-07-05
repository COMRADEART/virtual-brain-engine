// Desktop pet: standalone Tauri companion window. It mirrors live agent events
// and Phase 2 personality state, can be dragged anywhere on screen, and can be
// expanded into a small chat surface that streams the brain's answers.
// It talks to the Node server over the existing /api + brain-bus seams and to
// the OS only through narrow, named Tauri commands — never the Tauri API package
// (a static import of that, or of Three.js, regresses the main canvas chunk).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Brain, Maximize2, MessageCircle, Mic, Send, ShieldCheck, Square, Volume2, VolumeX, X, Zap } from "lucide-react";
import { subscribeBrainBus } from "../../engine/brainBus";
import { apiClient } from "../../engine/apiClient";
import { MOOD_COLOR, MOOD_LABEL, moodFor, type Mood } from "./petMood";
import { speak as voiceSpeak, stopSpeaking } from "../../engine/voicePlayer";
import { StreamingSpeaker } from "../../engine/streamingSpeech";
import { appendExchange, updateLastAnswer, type Exchange } from "./chatHistory";
import { confirmScope } from "./confirmSummary";
import { usePushToTalk } from "./usePushToTalk";
import { PersonListener } from "./PersonListener";
import { useUiPrefs } from "../../engine/uiPrefs";
import type { AgentRuntimeState } from "../../../shared/pipeline";
import type { PersonalityState } from "../../../shared/phase2";
import type { AgentConfirmMode, AgentConfirmRequest } from "../../../shared/agent";
import type { ActionRiskTier } from "../../../shared/actions";

// How autonomously the pet runs confirm-tier actions (the "do any task on the
// laptop" power level). Maps onto the agent loop's confirmMode + a granted scope:
//   ask  → pause for approval on every confirm-tier action (safest; default)
//   auto → run anything within a granted ceiling without prompting (session-scope,
//          audited honestly — the way to let it chain multi-step PC tasks)
//   safe → never run confirm-tier actions on its own (read-only)
type PetAutonomy = "ask" | "auto" | "safe";

const FULL_SCOPE: { allow: ActionRiskTier[] } = { allow: ["safe", "confirm"] };

function agentOptionsFor(a: PetAutonomy): { confirmMode: AgentConfirmMode; scope?: { allow: ActionRiskTier[] } } {
  if (a === "auto") return { confirmMode: "scope", scope: FULL_SCOPE };
  if (a === "safe") return { confirmMode: "safe-only" };
  return { confirmMode: "ask" };
}

function readAutonomy(): PetAutonomy {
  try {
    const v = window.localStorage.getItem("pet-autonomy");
    return v === "auto" || v === "safe" ? v : "ask";
  } catch {
    return "ask";
  }
}

const AUTONOMY_OPTIONS: Array<{ id: PetAutonomy; label: string; icon: typeof Zap; title: string }> = [
  { id: "ask", label: "Ask", icon: ShieldCheck, title: "Ask before each action that changes anything" },
  { id: "auto", label: "Auto", icon: Zap, title: "Let me run multi-step tasks on your PC without asking each step" },
  { id: "safe", label: "Read", icon: Square, title: "Read-only — never change anything on its own" },
];

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

export function PetWindow(): JSX.Element {
  const [lastState, setLastState] = useState<AgentRuntimeState | null>(null);
  const [personality, setPersonality] = useState<PersonalityState | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [subtitle, setSubtitle] = useState<string>("starting up...");
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [asking, setAsking] = useState(false);
  // A confirm-tier action the agent loop paused on, awaiting Run/Cancel. The
  // run is parked server-side under confirm.runId; we resume it via confirmAgent.
  const [pendingConfirm, setPendingConfirm] = useState<AgentConfirmRequest | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  // How autonomously the pet acts on the computer (persisted). The loop reads it
  // via a ref so the stable streamAgent callback always sees the latest value.
  const [autonomy, setAutonomy] = useState<PetAutonomy>(readAutonomy);
  const resetTimer = useRef<number | null>(null);
  const askAbort = useRef<AbortController | null>(null);
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const autonomyRef = useRef(autonomy);
  autonomyRef.current = autonomy;

  useEffect(() => {
    try {
      window.localStorage.setItem("pet-autonomy", autonomy);
    } catch {
      /* ignore */
    }
  }, [autonomy]);

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
        return;
      }
      // Proactive presence: the IdleAgent already broadcasts what the brain is
      // mulling when the system is quiet. Surface it as a gentle subtitle and,
      // when voice is on, let the pet THINK OUT LOUD (best-effort).
      if (message.type === "idle-thought") {
        setSubtitle(`⊕ ${message.preview}`);
        if (voiceOnRef.current && message.preview) {
          // The server's speech policy decides if an idle-thought is spoken
          // (only in voiceMode "proactive") and caps/redacts the text.
          void voiceSpeak(message.preview, { kind: "idle-thought" });
        }
        return;
      }
      if (message.type === "exploration-scheduled") {
        setSubtitle(`exploring ${message.target}`);
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

  // Drive the agentic loop (the brain's "main thinking") and render its stream
  // into the current exchange. The loop THINKS and ACTS in steps: tool activity
  // shows live; the streamed/final answer fills the chat. A confirm-tier action
  // pauses with a `confirm-request` frame — we park it and surface Run/Cancel.
  // Bare PipelineEvents (has `step`) are visualizer telemetry and skipped here.
  // `resume` continues a paused run after the user's decision.
  const streamAgent = useCallback(
    async (
      question: string,
      resume?: { runId: string; approve: boolean; grant?: boolean },
    ) => {
      askAbort.current?.abort();
      const controller = new AbortController();
      askAbort.current = controller;
      let answer = "";
      const tools: string[] = [];
      // Speaks completed sentences as they stream in (delta frames), instead
      // of waiting for the final frame — the pet starts talking seconds
      // earlier on a long answer. Gated on the pet's own voiceOn toggle, not
      // the shared uiPrefs one AskPanel uses.
      const speaker = new StreamingSpeaker({ kind: "answer", isEnabled: () => voiceOnRef.current });
      const render = () => {
        const body = answer || tools.join("\n") || "thinking…";
        setExchanges((list) => updateLastAnswer(list, body));
      };
      try {
        const stream = resume
          ? apiClient.confirmAgent(
              {
                runId: resume.runId,
                approve: resume.approve,
                // "Run all": widen the run's grant so the rest of the task runs
                // without a prompt for each step (session-scope, audited honestly).
                grantScope: resume.grant ? FULL_SCOPE : undefined,
              },
              controller.signal,
            )
          : apiClient.agent({ prompt: question, ...agentOptionsFor(autonomyRef.current) }, controller.signal);
        for await (const frame of stream) {
          if (!("type" in frame)) continue; // PipelineEvent telemetry → visualizer only
          switch (frame.type) {
            case "thought":
              if (!answer && frame.text) setSubtitle(frame.text);
              break;
            case "tool-start":
              if (frame.tool) {
                tools.push(`⚙ ${frame.tool.actionId}…`);
                render();
              }
              break;
            case "tool-result":
              if (frame.tool) {
                tools[tools.length - 1] =
                  `${frame.tool.ok ? "✓" : "✗"} ${frame.tool.actionId}: ${frame.tool.ok ? frame.tool.summary ?? "done" : frame.tool.error ?? "failed"}`;
                // os-surface actions return a directive the OS op runs here.
                if (frame.tool.ok && frame.tool.osDirective) {
                  void invokeQuiet(frame.tool.osDirective.command, frame.tool.osDirective.args);
                }
                render();
              }
              break;
            case "confirm-request":
              if (frame.confirm) {
                setPendingConfirm(frame.confirm);
                setExchanges((list) =>
                  updateLastAnswer(
                    list,
                    `${frame.confirm?.rationale || "Run this action?"}\n→ ${frame.confirm?.title}`,
                  ),
                );
              }
              return; // pause — wait for the user's Run/Cancel
            case "delta":
              answer += frame.text ?? "";
              render();
              speaker.push(answer);
              break;
            case "final":
              answer = frame.text ?? answer;
              render();
              // Skip TTS if the user already pressed Stop. The server policy
              // sanitizes/redacts/caps the answer; flush() speaks whatever the
              // streaming pass hasn't already queued (best-effort, don't await).
              if (answer && !controller.signal.aborted) {
                speaker.flush(answer);
              }
              break;
            case "error":
              answer = answer || `⚠ ${frame.detail ?? "agent error"}`;
              render();
              break;
            default:
              break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          setExchanges((list) => updateLastAnswer(list, answer || `⚠ ${msg}`));
        }
      } finally {
        if (askAbort.current === controller) askAbort.current = null;
      }
    },
    [],
  );

  // Single entry point for the chat box: everything goes through the agentic
  // loop. A plain question is triaged to the fast 7-step pipeline server-side; a
  // command / multi-step / "do X" request runs the loop, which executes tools
  // through the permissioned executor (pausing for confirm-tier approvals).
  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || asking) return;
      if (!expanded) applyExpanded(true);
      setInput("");
      setPendingConfirm(null);
      stopSpeaking(); // barge-in: a new question silences any in-flight voice
      setExchanges((list) => appendExchange(list, { question: text, answer: "…" }));
      setAsking(true);
      try {
        await streamAgent(text);
      } finally {
        setAsking(false);
      }
    },
    [asking, expanded, applyExpanded, streamAgent],
  );

  // Push-to-talk: press-and-hold the mic → record → local faster-whisper STT →
  // feed the transcript straight into the agentic loop. No cloud STT.
  const ptt = usePushToTalk(
    (text) => void submit(text),
    (msg) => setSubtitle(msg),
  );

  // Always-listener: when the user toggles "Listen for 'Brain'" in Settings
  // (or via the tray menu), the pet holds the mic open in 3-second chunks
  // and only submits when the transcript contains a hotword. Coexists with
  // PTT — the hotword submit and the press-and-hold submit share the same
  // `submit()` entry point. Rendered inside the JSX as a null-returning
  // component (no DOM).
  const { prefs } = useUiPrefs();
  const personListenerEnabled = prefs.personListener.enabled;

  // Approve the paused confirm-tier action and resume the loop. The human just
  // approved THIS exact plan, so the server mints an honest, plan-bound confirm
  // token on resume.
  const runPending = useCallback(async () => {
    if (!pendingConfirm || asking) return;
    const runId = pendingConfirm.runId;
    setPendingConfirm(null);
    setAsking(true);
    setExchanges((list) => updateLastAnswer(list, "working…"));
    try {
      await streamAgent("", { runId, approve: true });
    } finally {
      setAsking(false);
    }
  }, [pendingConfirm, asking, streamAgent]);

  // Approve AND grant the run a risk ceiling so the rest of the task runs without
  // a prompt for every step — the way to let it carry out a multi-step PC job.
  const runAllPending = useCallback(async () => {
    if (!pendingConfirm || asking) return;
    const runId = pendingConfirm.runId;
    setPendingConfirm(null);
    setAsking(true);
    setExchanges((list) => updateLastAnswer(list, "working…"));
    try {
      await streamAgent("", { runId, approve: true, grant: true });
    } finally {
      setAsking(false);
    }
  }, [pendingConfirm, asking, streamAgent]);

  // Deny the action and let the loop continue (it wraps up without it).
  const cancelPending = useCallback(async () => {
    if (!pendingConfirm) return;
    const runId = pendingConfirm.runId;
    setPendingConfirm(null);
    setAsking(true);
    try {
      await streamAgent("", { runId, approve: false });
    } finally {
      setAsking(false);
    }
  }, [pendingConfirm, streamAgent]);

  // Abort an in-flight run (the brain keeps any work already committed; the
  // stream just stops). Clears any pending confirm too.
  const stop = useCallback(() => {
    askAbort.current?.abort();
    askAbort.current = null;
    stopSpeaking(); // silence any clip already playing / mid-synthesis
    setPendingConfirm(null);
    setAsking(false);
    setSubtitle("stopped");
  }, []);

  const mood: Mood = useMemo(() => moodFor(lastState, personality), [lastState, personality]);
  const color = MOOD_COLOR[mood];
  const focus = Math.round((personality?.focus ?? 0.35) * 100);
  const arousal = Math.round((personality?.arousal ?? 0.25) * 100);
  const pulseSeconds = Math.max(1.6, 3.2 - arousal / 42);
  const orbitSeconds = Math.max(2.2, 5.2 - arousal / 25);

  return (
    <div className={`pet-root ${expanded ? "expanded" : ""}`}>
      <PersonListener
        enabled={personListenerEnabled}
        onPrompt={(text) => void submit(text)}
        onError={(msg) => setSubtitle(msg)}
      />
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
        .pet-chat-turn { margin-bottom: 10px; }
        .pet-chat-turn:last-child { margin-bottom: 0; }
        .pet-chat-q { color: ${color}; margin-bottom: 4px; }
        .pet-chat-a { white-space: pre-wrap; color: #c7c7da; }
        .pet-chat-empty { color: #6a6a82; font-size: 10px; }
        .pet-confirm { display: flex; flex-direction: column; gap: 6px; }
        .pet-confirm-scope {
          font-size: 10px; line-height: 1.35; color: #c7c7da; padding: 6px 8px;
          border-radius: 8px; background: rgba(12, 12, 20, 0.6); border: 1px solid ${color}33;
        }
        .pet-confirm-hint { display: block; font-size: 9px; color: #8b8ba3; margin-top: 4px; }
        .pet-confirm-risk {
          display: inline-block; font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em;
          color: #0a0a0f; background: ${color}; border-radius: 999px; padding: 1px 6px; margin-right: 6px;
        }
        .pet-quick { display: flex; gap: 4px; flex-wrap: wrap; }
        .pet-quick button {
          font-size: 9px; padding: 3px 7px; border-radius: 999px; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.12); color: #b9b9cf; background: rgba(20,20,30,0.55);
        }
        .pet-quick button:hover { background: rgba(40,40,60,0.85); color: #fff; }
        .pet-quick button:disabled { opacity: 0.4; cursor: default; }
        .pet-stop { color: #ff8b8b; }
        .pet-stop:hover { background: rgba(60,20,20,0.85); color: #fff; }
        .pet-autonomy {
          display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
        }
        .pet-autonomy-label { font-size: 9px; color: #6a6a82; margin-right: 1px; }
        .pet-autonomy button {
          display: inline-flex; align-items: center; gap: 3px;
          font-size: 9px; padding: 2px 7px; border-radius: 999px; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.12); color: #b9b9cf; background: rgba(20,20,30,0.55);
        }
        .pet-autonomy button.active { color: #0a0a0f; background: ${color}; border-color: transparent; }
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
        {asking ? (
          <button
            type="button"
            className="pet-iconbtn pet-stop"
            title="Stop"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={stop}
          >
            <Square size={11} />
          </button>
        ) : null}
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
        {ptt.supported ? (
          <button
            type="button"
            className="pet-iconbtn"
            title={
              ptt.transcribing
                ? "Transcribing…"
                : ptt.recording
                  ? "Listening… release to send"
                  : "Hold to talk"
            }
            aria-pressed={ptt.recording}
            style={ptt.recording ? { background: color, color: "#0a0a0f" } : undefined}
            onMouseDown={(e) => {
              e.stopPropagation();
              ptt.start();
            }}
            onMouseUp={(e) => {
              e.stopPropagation();
              ptt.stop();
            }}
            onMouseLeave={() => {
              if (ptt.recording) ptt.stop();
            }}
            onTouchStart={(e) => {
              e.stopPropagation();
              ptt.start();
            }}
            onTouchEnd={(e) => {
              e.stopPropagation();
              ptt.stop();
            }}
          >
            <Mic size={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="pet-iconbtn"
          title={voiceOn ? "Mute voice" : "Enable voice"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() =>
            setVoiceOn((v) => {
              if (v) stopSpeaking(); // muting silences in-flight speech
              return !v;
            })
          }
        >
          {voiceOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
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
            {exchanges.length > 0 ? (
              exchanges.map((ex, i) => (
                <div className="pet-chat-turn" key={i}>
                  <div className="pet-chat-q">› {ex.question}</div>
                  <div className="pet-chat-a">
                    {ex.answer || (asking && i === exchanges.length - 1 ? "thinking…" : "")}
                  </div>
                </div>
              ))
            ) : (
              <div className="pet-chat-empty">{summary || subtitle}</div>
            )}
          </div>
          {pendingConfirm ? (
            <div className="pet-confirm" role="group" aria-label="Confirm action">
              <div className="pet-confirm-scope">
                <span className="pet-confirm-risk">
                  {confirmScope(pendingConfirm.actionId, pendingConfirm.args, pendingConfirm.risk).riskLabel}
                </span>
                {confirmScope(pendingConfirm.actionId, pendingConfirm.args, pendingConfirm.risk).detail}
              </div>
              <div className="pet-quick">
                <button type="button" disabled={asking} onClick={() => void runPending()}>
                  run ✓
                </button>
                <button type="button" disabled={asking} onClick={() => void runAllPending()} title="Run this and the rest of the task without asking again">
                  run all ✓✓
                </button>
                <button type="button" disabled={asking} onClick={() => void cancelPending()}>
                  cancel
                </button>
              </div>
              <small className="pet-confirm-hint">
                "run all" grants this run session-wide permission at this risk tier (every step audited)
              </small>
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
              <button
                type="button"
                disabled={asking}
                onClick={() => void submit("Show me my system info — CPU, memory, disk.")}
              >
                system info
              </button>
              <button
                type="button"
                disabled={asking}
                onClick={() => void submit("What apps and processes are running on my PC right now?")}
              >
                what's running
              </button>
              <button type="button" onClick={openMainWindow}>
                brain os
              </button>
            </div>
          )}

          <div className="pet-autonomy" role="radiogroup" aria-label="Autonomy">
            <span className="pet-autonomy-label">acts:</span>
            {AUTONOMY_OPTIONS.map(({ id, label, icon: Icon, title }) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={autonomy === id}
                className={autonomy === id ? "active" : ""}
                title={title}
                onClick={() => setAutonomy(id)}
              >
                <Icon size={9} /> {label}
              </button>
            ))}
          </div>
          <form
            className="pet-inputbar"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(input);
            }}
          >
            <input
              type="text"
              placeholder="ask, command, or run anything on your PC…"
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
