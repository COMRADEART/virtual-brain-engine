import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CircleDot,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  Send,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from "lucide-react";
import { BRAIN_ACTIONS } from "../data/regionDefinitions";
import {
  generateTour,
  pickAction,
  streamChatTurn,
  streamTour,
  type TourStep,
} from "../engine/aiCompanion";
import {
  listModels,
  OllamaError,
  getOllamaBaseUrl,
  probeReachable,
  type OllamaMessage,
  type OllamaModelInfo,
} from "../engine/ollamaClient";
import {
  createSpeechSession,
  isSpeechSupported,
  type SpeechSession,
} from "../engine/speechInput";
import { cancelAllSpeech, isTtsSupported, speakText } from "../engine/speechOutput";
import type { BrainActionId } from "../engine/types";

type Tab = "command" | "tour" | "chat";
type ConnectionStatus =
  | { kind: "unknown" }
  | { kind: "connected"; models: OllamaModelInfo[] }
  | { kind: "offline"; reason: "down" | "cors" | "other"; message: string };

interface AiCompanionProps {
  onActionPick: (action: BrainActionId, why?: string) => void;
}

const ACTION_LABELS = Object.fromEntries(
  BRAIN_ACTIONS.map((action) => [action.id, action.label]),
) as Record<BrainActionId, string>;

const TOUR_STEP_MS = 4500;

function formatError(error: unknown): string {
  if (error instanceof OllamaError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error.";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      resolve();
    }, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export function AiCompanion({ onActionPick }: AiCompanionProps): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>({ kind: "unknown" });
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [tab, setTab] = useState<Tab>("command");
  // On screens that already host the control + info panels, start collapsed so
  // the AI panel doesn't crash into them. Desktop defaults to expanded.
  const [collapsed, setCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth < 980);

  // Command tab state.
  const [commandInput, setCommandInput] = useState("");
  const [commandPick, setCommandPick] = useState<{ action: BrainActionId; why: string } | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);

  // Tour tab state.
  const [tourSteps, setTourSteps] = useState<TourStep[]>([]);
  const [tourIndex, setTourIndex] = useState(-1);
  const [tourBusy, setTourBusy] = useState(false);
  const [tourError, setTourError] = useState<string | null>(null);

  // Chat tab state.
  const [chatHistory, setChatHistory] = useState<OllamaMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatPending, setChatPending] = useState<string>("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const speechRef = useRef<SpeechSession | null>(null);
  const [listeningFor, setListeningFor] = useState<"command" | "chat" | null>(null);
  const speechSupported = useMemo(() => isSpeechSupported(), []);
  const ttsSupported = useMemo(() => isTtsSupported(), []);
  // TTS on by default when available so the AI's responses feel like a reply
  // and not a notification. Users can mute via the header toggle.
  const [ttsEnabled, setTtsEnabled] = useState(ttsSupported);

  // Speak only when TTS is supported AND the user has it enabled. Cancelling
  // happens via cancelAllSpeech(); SpeechSynthesis's queue is global so we
  // can't cancel one utterance without draining the others.
  const maybeSpeak = useCallback(
    (text: string | undefined | null) => {
      if (!ttsSupported || !ttsEnabled || !text) {
        return;
      }
      cancelAllSpeech();
      speakText(text);
    },
    [ttsEnabled, ttsSupported],
  );

  const refreshModels = useCallback(async () => {
    setStatus({ kind: "unknown" });
    try {
      const models = await listModels();
      setStatus({ kind: "connected", models });
      setSelectedModel((current) => {
        if (current && models.some((entry) => entry.name === current)) {
          return current;
        }
        return models[0]?.name ?? "";
      });
    } catch (error) {
      const baseMessage = formatError(error);
      // When listModels fails as "unreachable", that could mean the daemon is
      // down OR Ollama is up but rejecting our origin via CORS — both look the
      // same to fetch. Probe with no-cors to tell them apart and give an
      // actionable hint.
      if (error instanceof OllamaError && error.kind === "unreachable") {
        try {
          const probe = await probeReachable();
          if (probe === "online") {
            setStatus({
              kind: "offline",
              reason: "cors",
              message:
                "Ollama is running but it's blocking this page's origin. Stop the daemon and restart it with `OLLAMA_ORIGINS='*' ollama serve` (or include http://127.0.0.1:5173 in the env var).",
            });
            return;
          }
        } catch {
          // Fall through to the generic offline message.
        }
        setStatus({
          kind: "offline",
          reason: "down",
          message: "Ollama isn't reachable. Start it with `ollama serve` (or `OLLAMA_ORIGINS='*' ollama serve` if you'll call it from this page).",
        });
        return;
      }
      setStatus({ kind: "offline", reason: "other", message: baseMessage });
    }
  }, []);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatHistory, chatPending]);

  // Cancel anything mid-flight when switching tabs so a backgrounded request
  // can't keep streaming into a hidden panel.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      speechRef.current?.dispose();
      cancelAllSpeech();
    };
  }, []);

  // Don't keep talking after the user switches tabs or collapses the panel —
  // it's disorienting to hear an unrelated stream when the UI is gone.
  useEffect(() => {
    cancelAllSpeech();
  }, [tab, collapsed]);

  const startListening = useCallback(
    (target: "command" | "chat") => {
      if (!speechSupported) {
        return;
      }
      speechRef.current?.dispose();
      const setInput = target === "command" ? setCommandInput : setChatInput;
      const setError = target === "command" ? setCommandError : setChatError;
      const session = createSpeechSession({
        onInterim: (text) => setInput(text),
        onFinal: (text) => setInput(text),
        onError: (message) => {
          setError(`Voice input: ${message}`);
        },
        onListeningChange: (listening) => {
          setListeningFor(listening ? target : null);
        },
      });
      speechRef.current = session;
      session?.start();
    },
    [speechSupported],
  );

  const stopListening = useCallback(() => {
    speechRef.current?.stop();
  }, []);

  const ready = status.kind === "connected" && selectedModel.length > 0;
  const anyBusy = commandBusy || tourBusy || chatBusy;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    cancelAllSpeech();
  }, []);

  const handleSendCommand = useCallback(async () => {
    const trimmed = commandInput.trim();
    if (!trimmed || !ready || anyBusy) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCommandBusy(true);
    setCommandError(null);
    setCommandPick(null);
    try {
      const result = await pickAction(trimmed, selectedModel, controller.signal);
      setCommandPick(result);
      onActionPick(result.action, result.why);
      maybeSpeak(result.why);
    } catch (error) {
      if (error instanceof OllamaError && error.kind === "aborted") {
        // Intentionally silent — user cancelled.
      } else {
        setCommandError(formatError(error));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setCommandBusy(false);
    }
  }, [anyBusy, commandInput, onActionPick, ready, selectedModel]);

  const handleRunTour = useCallback(async () => {
    if (!ready || anyBusy) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setTourBusy(true);
    setTourError(null);
    setTourSteps([]);
    setTourIndex(-1);

    const collected: TourStep[] = [];
    let streamingFinished = false;
    let playerPromise: Promise<void> | null = null;

    // The player advances through `collected` one step at a time, waiting for
    // more entries while streaming is still in progress. This way the brain
    // starts switching as soon as the first JSON line arrives — we don't have
    // to wait for the full script.
    const player = async (): Promise<void> => {
      let i = 0;
      while (!controller.signal.aborted) {
        while (i >= collected.length && !streamingFinished) {
          try {
            await sleep(120, controller.signal);
          } catch {
            return;
          }
        }
        if (i >= collected.length) {
          return;
        }
        const step = collected[i];
        setTourIndex(i);
        onActionPick(step.action, step.narration);
        maybeSpeak(step.narration);
        try {
          await sleep(TOUR_STEP_MS, controller.signal);
        } catch {
          return;
        }
        i += 1;
      }
    };

    const ensurePlayer = (): void => {
      if (!playerPromise) {
        playerPromise = player();
      }
    };

    try {
      await streamTour(
        selectedModel,
        (step) => {
          collected.push(step);
          setTourSteps([...collected]);
          ensurePlayer();
        },
        controller.signal,
        4,
      );

      // Fallback path: if the model produced zero valid NDJSON lines (small
      // models sometimes wrap the output in an array or markdown), fall back
      // to the JSON one-shot — slower but more forgiving.
      if (collected.length === 0 && !controller.signal.aborted) {
        const fallback = await generateTour(selectedModel, controller.signal, 4);
        if (fallback.length === 0) {
          throw new Error("Model returned no tour steps.");
        }
        for (const step of fallback) {
          collected.push(step);
        }
        setTourSteps([...collected]);
        ensurePlayer();
      }

      streamingFinished = true;
      if (playerPromise) {
        await playerPromise;
      }
    } catch (error) {
      streamingFinished = true;
      if (error instanceof OllamaError && error.kind === "aborted") {
        // ignore
      } else {
        setTourError(formatError(error));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setTourBusy(false);
    }
  }, [anyBusy, onActionPick, ready, selectedModel]);

  const handleSendChat = useCallback(async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || !ready || anyBusy) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const nextHistory: OllamaMessage[] = [
      ...chatHistory,
      { role: "user", content: trimmed },
    ];
    setChatHistory(nextHistory);
    setChatInput("");
    setChatPending("");
    setChatBusy(true);
    setChatError(null);
    let streamed = "";
    try {
      streamed = await streamChatTurn(
        nextHistory,
        selectedModel,
        (token) => {
          streamed += token;
          setChatPending((current) => current + token);
        },
        controller.signal,
      );
      setChatHistory((current) => [...current, { role: "assistant", content: streamed }]);
      setChatPending("");
      maybeSpeak(streamed);
    } catch (error) {
      if (error instanceof OllamaError && error.kind === "aborted") {
        if (streamed.length > 0) {
          // Preserve whatever the user already saw on the screen.
          setChatHistory((current) => [...current, { role: "assistant", content: streamed }]);
        }
        setChatPending("");
      } else {
        setChatError(formatError(error));
        setChatPending("");
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setChatBusy(false);
    }
  }, [anyBusy, chatHistory, chatInput, ready, selectedModel]);

  const statusDot = useMemo(() => {
    if (status.kind === "connected") {
      return { color: "live", label: `Ollama · ${status.models.length} model${status.models.length === 1 ? "" : "s"}` };
    }
    if (status.kind === "offline") {
      return { color: "offline", label: "Ollama offline" };
    }
    return { color: "pending", label: "Checking Ollama…" };
  }, [status]);

  if (collapsed) {
    return (
      <button
        className="ai-pill"
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Open AI companion"
      >
        <Bot size={16} />
        <span>AI companion</span>
        <span className={`ai-status-dot ${statusDot.color}`} aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside className="ai-panel" aria-label="AI companion">
      <header className="ai-header">
        <div className="ai-title">
          <Bot size={16} />
          <span>AI companion</span>
          <span className={`ai-status-dot ${statusDot.color}`} aria-hidden="true" />
          <small className="ai-status-label">{statusDot.label}</small>
        </div>
        <div className="ai-header-controls">
          <select
            aria-label="Ollama model"
            disabled={status.kind !== "connected"}
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
          >
            {status.kind === "connected" && status.models.length === 0 ? (
              <option value="">No models pulled</option>
            ) : null}
            {status.kind === "connected"
              ? status.models.map((model) => (
                  <option key={model.name} value={model.name}>
                    {model.name}
                  </option>
                ))
              : <option value="">—</option>}
          </select>
          {ttsSupported ? (
            <button
              className="ai-icon-button"
              type="button"
              onClick={() => {
                setTtsEnabled((current) => {
                  const next = !current;
                  if (!next) {
                    cancelAllSpeech();
                  }
                  return next;
                });
              }}
              aria-label={ttsEnabled ? "Mute voice output" : "Enable voice output"}
              title={ttsEnabled ? "Voice output on" : "Voice output muted"}
            >
              {ttsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
          ) : null}
          <button
            className="ai-icon-button"
            type="button"
            onClick={() => void refreshModels()}
            aria-label="Refresh model list"
            title={`Refresh from ${getOllamaBaseUrl()}`}
          >
            <CircleDot size={14} />
          </button>
          <button
            className="ai-icon-button"
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label="Minimise AI companion"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <nav className="ai-tabs" role="tablist">
        <button
          className={tab === "command" ? "active" : ""}
          role="tab"
          aria-selected={tab === "command"}
          type="button"
          onClick={() => setTab("command")}
        >
          <Wand2 size={14} /> Command
        </button>
        <button
          className={tab === "tour" ? "active" : ""}
          role="tab"
          aria-selected={tab === "tour"}
          type="button"
          onClick={() => setTab("tour")}
        >
          <Sparkles size={14} /> Tour
        </button>
        <button
          className={tab === "chat" ? "active" : ""}
          role="tab"
          aria-selected={tab === "chat"}
          type="button"
          onClick={() => setTab("chat")}
        >
          <MessageSquare size={14} /> Chat
        </button>
      </nav>

      <div className="ai-body">
        {status.kind === "offline" ? (
          <p className="ai-offline-hint">
            {status.message}
            {status.reason === "down" ? (
              <>
                <br />
                <small>
                  After it's running, pull a small model (e.g. <code>ollama pull llama3.2:3b</code>) and click refresh.
                </small>
              </>
            ) : null}
          </p>
        ) : null}

        {tab === "command" ? (
          <div className="ai-section">
            <p className="ai-hint">Describe what you want to think about. The model picks an action and the brain lights up.</p>
            <div className="ai-row">
              <input
                type="text"
                placeholder='e.g. "I just heard a loud noise behind me"'
                value={commandInput}
                disabled={!ready || commandBusy}
                onChange={(event) => setCommandInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSendCommand();
                  }
                }}
              />
              {speechSupported ? (
                <button
                  className={listeningFor === "command" ? "ai-mic listening" : "ai-mic"}
                  type="button"
                  aria-label={listeningFor === "command" ? "Stop voice input" : "Start voice input"}
                  onClick={() =>
                    listeningFor === "command" ? stopListening() : startListening("command")
                  }
                >
                  {listeningFor === "command" ? <MicOff size={14} /> : <Mic size={14} />}
                </button>
              ) : null}
              {commandBusy ? (
                <button className="ai-cancel" type="button" onClick={cancel}>
                  <Square size={14} /> Stop
                </button>
              ) : (
                <button
                  className="ai-send"
                  type="button"
                  disabled={!ready || !commandInput.trim()}
                  onClick={() => void handleSendCommand()}
                >
                  <Send size={14} /> Send
                </button>
              )}
            </div>
            {commandBusy ? (
              <p className="ai-thinking">
                <Loader2 size={14} className="ai-spin" /> Thinking…
              </p>
            ) : null}
            {commandPick && !commandBusy ? (
              <p className="ai-result">
                Triggered <strong>{ACTION_LABELS[commandPick.action]}</strong> — {commandPick.why}
              </p>
            ) : null}
            {commandError ? <p className="ai-error">{commandError}</p> : null}
          </div>
        ) : null}

        {tab === "tour" ? (
          <div className="ai-section">
            <p className="ai-hint">Let the model script a guided tour. Each step triggers a brain action for {Math.round(TOUR_STEP_MS / 1000)}s.</p>
            <div className="ai-row">
              {tourBusy ? (
                <button className="ai-cancel" type="button" onClick={cancel}>
                  <Square size={14} /> Stop tour
                </button>
              ) : (
                <button
                  className="ai-send"
                  type="button"
                  disabled={!ready}
                  onClick={() => void handleRunTour()}
                >
                  <Sparkles size={14} /> Run tour
                </button>
              )}
            </div>
            {tourSteps.length > 0 ? (
              <ol className="ai-tour-list">
                {tourSteps.map((step, index) => (
                  <li key={`${step.action}-${index}`} className={index === tourIndex ? "active" : ""}>
                    <span className="ai-tour-action">{ACTION_LABELS[step.action]}</span>
                    <span className="ai-tour-narration">{step.narration}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {tourBusy && tourSteps.length === 0 ? (
              <p className="ai-thinking">
                <Loader2 size={14} className="ai-spin" /> Scripting tour…
              </p>
            ) : null}
            {tourError ? <p className="ai-error">{tourError}</p> : null}
          </div>
        ) : null}

        {tab === "chat" ? (
          <div className="ai-section ai-chat">
            <div className="ai-chat-log" ref={chatScrollRef}>
              {chatHistory.length === 0 && !chatPending ? (
                <p className="ai-hint">Ask about a region, a pathway, or how to trigger an action.</p>
              ) : null}
              {chatHistory.map((message, index) => (
                <div key={index} className={`ai-chat-msg ${message.role}`}>
                  <span className="ai-chat-role">{message.role === "user" ? "You" : "Brain"}</span>
                  <span className="ai-chat-text">{message.content}</span>
                </div>
              ))}
              {chatPending ? (
                <div className="ai-chat-msg assistant pending">
                  <span className="ai-chat-role">Brain</span>
                  <span className="ai-chat-text">{chatPending}</span>
                </div>
              ) : null}
            </div>
            <div className="ai-row">
              <input
                type="text"
                placeholder="Ask the brain anything…"
                value={chatInput}
                disabled={!ready || chatBusy}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSendChat();
                  }
                }}
              />
              {speechSupported ? (
                <button
                  className={listeningFor === "chat" ? "ai-mic listening" : "ai-mic"}
                  type="button"
                  aria-label={listeningFor === "chat" ? "Stop voice input" : "Start voice input"}
                  onClick={() =>
                    listeningFor === "chat" ? stopListening() : startListening("chat")
                  }
                >
                  {listeningFor === "chat" ? <MicOff size={14} /> : <Mic size={14} />}
                </button>
              ) : null}
              {chatBusy ? (
                <button className="ai-cancel" type="button" onClick={cancel}>
                  <Square size={14} /> Stop
                </button>
              ) : (
                <button
                  className="ai-send"
                  type="button"
                  disabled={!ready || !chatInput.trim()}
                  onClick={() => void handleSendChat()}
                >
                  <Send size={14} /> Send
                </button>
              )}
            </div>
            {chatError ? <p className="ai-error">{chatError}</p> : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
