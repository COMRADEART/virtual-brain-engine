import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Brain, HelpCircle, Loader2, Send, Sparkles, Square, ThumbsDown, ThumbsUp, Volume2, VolumeX } from "lucide-react";
import { apiClient, ApiError } from "../engine/apiClient";
import { speak as speakVoice, stopSpeaking } from "../engine/voicePlayer";
import { getUiPrefs, useUiPrefs } from "../engine/uiPrefs";
import { RichText } from "./RichText";
import type { PipelineEvent } from "../../shared/pipeline";

interface Citation {
  memoryId: string;
  filePath?: string;
  score?: number;
}

interface AskPanelProps {
  onConversationChange?: (conversationId: string) => void;
}

const SUGGESTED_PROMPTS = [
  "What does the signal simulation do?",
  "How are anatomical regions wired together?",
  "Where is the AI Companion implemented?",
  "Show me everything about brain pulses.",
];

interface AnswerSections {
  known: string;
  inferred: string;
  uncertain: string;
  prelude: string;
}

function parseSections(text: string): AnswerSections {
  // Headers may be bolded ("**Known memory:**"), prefixed with a hash, or plain.
  // We just look for the three label strings and split on them. Anything before
  // the first known header lands in `prelude` so we never silently drop text.
  const normalized = text.replace(/\*\*/g, "").replace(/^#+\s*/gm, "");
  const re = /(Known memory:|Inferred reasoning:|Uncertain:)/g;
  const matches: Array<{ key: keyof Omit<AnswerSections, "prelude">; index: number; label: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) {
    const label = m[1];
    const key =
      label === "Known memory:" ? "known" : label === "Inferred reasoning:" ? "inferred" : "uncertain";
    matches.push({ key, index: m.index, label });
  }

  if (matches.length === 0) {
    return { known: "", inferred: text.trim(), uncertain: "", prelude: "" };
  }

  const prelude = normalized.slice(0, matches[0].index).trim();
  const sections: AnswerSections = { known: "", inferred: "", uncertain: "", prelude };
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i].label.length;
    const end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
    sections[matches[i].key] = normalized.slice(start, end).trim();
  }
  return sections;
}

export function AskPanel({ onConversationChange }: AskPanelProps): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [pending, setPending] = useState<string>("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [highlightedCitation, setHighlightedCitation] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [feedbackSent, setFeedbackSent] = useState<1 | -1 | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const citationsRef = useRef<HTMLUListElement | null>(null);
  const { prefs: uiPrefs, update: updateUi } = useUiPrefs();

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const submit = useCallback(
    async (overridePrompt?: string) => {
      const sourceText = (overridePrompt ?? prompt).trim();
      if (!sourceText || running) {
        return;
      }
      if (overridePrompt !== undefined) {
        setPrompt(overridePrompt);
      }
      abortRef.current?.abort();
      stopSpeaking(); // barge-in: a new question cuts off any in-flight speech
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError(null);
      setAnswer("");
      setPending("");
      setCitations([]);
      setHighlightedCitation(null);
      setRunId(null);
      setFeedbackSent(null);

      let streamed = "";
      // Coalesce token updates to ONE React state write per animation frame.
      // Writing setPending on every tokensDelta re-renders the answer tree (and
      // re-runs its full-text regex parse) per token — O(n²) over a long answer
      // and a main-thread competitor for the 3D scene. Batching to ~60fps keeps
      // the stream visibly live while collapsing the render churn.
      let rafId: number | null = null;
      const flushPending = (): void => {
        rafId = null;
        setPending(streamed);
      };
      const scheduleFlush = (): void => {
        if (rafId === null) rafId = requestAnimationFrame(flushPending);
      };
      const cancelFlush = (): void => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      };
      try {
        for await (const event of apiClient.ask(
          { prompt: sourceText, conversationId: conversationId ?? undefined },
          controller.signal,
        )) {
          if (event.conversationId && event.conversationId !== conversationId) {
            setConversationId(event.conversationId);
            onConversationChange?.(event.conversationId);
          }
          if (event.runId) {
            setRunId(event.runId);
          }
          if (event.step === "memory" && event.status === "complete" && event.citations) {
            setCitations(event.citations);
          }
          if (event.step === "response" && event.status === "progress" && event.tokensDelta) {
            streamed += event.tokensDelta;
            scheduleFlush();
          }
          if (event.step === "learning" && event.status === "complete" && event.finalAnswer) {
            cancelFlush();
            setAnswer(event.finalAnswer);
            setPending("");
            // Speak the answer (server governs whether/what — read live, not the
            // closure-captured prefs). The server strips markers/redacts/caps.
            if (getUiPrefs().voiceEnabled) {
              void speakVoice(event.finalAnswer, { kind: "answer" });
            }
          }
          if (event.status === "error") {
            setError(event.detail ?? "Pipeline error");
          }
        }
        cancelFlush();
        if (!answer && streamed) {
          setAnswer(streamed);
        }
      } catch (err) {
        cancelFlush();
        if (err instanceof DOMException && err.name === "AbortError") {
          // user cancelled
        } else if (err instanceof ApiError) {
          setError(err.message || `Server error ${err.status}`);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError(String(err));
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setRunning(false);
      }
    },
    [answer, conversationId, onConversationChange, prompt, running],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const submitFeedback = useCallback(
    async (rating: 1 | -1) => {
      if (!runId || feedbackBusy || feedbackSent !== null) {
        return;
      }
      setFeedbackBusy(true);
      try {
        await apiClient.sendFeedback({
          runId,
          rating,
          conversationId: conversationId ?? undefined,
        });
        setFeedbackSent(rating);
      } catch {
        // Feedback is best-effort — a failed write shouldn't disrupt the user.
      } finally {
        setFeedbackBusy(false);
      }
    },
    [runId, feedbackBusy, feedbackSent, conversationId],
  );

  const knownIds = useMemo(() => new Set(citations.map((c) => c.memoryId)), [citations]);
  const visibleText = answer || pending;
  const sections = useMemo(() => parseSections(visibleText), [visibleText]);

  const jumpToCitation = useCallback((memoryId: string) => {
    setHighlightedCitation(memoryId);
    const node = citationsRef.current?.querySelector(`[data-memory-id="${memoryId}"]`);
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    window.setTimeout(() => setHighlightedCitation(null), 1800);
  }, []);

  const ServerDown = error?.includes("fetch") || error?.includes("Server error 0") || error?.includes("unreachable");

  return (
    <div className="brain-os-section ask-panel">
      <p className="ai-hint">
        Ask anything. The pipeline embeds, recalls memory, drafts a plan, drafts a response, and stores what it learned.
      </p>
      {!visibleText && !running ? (
        <div className="ask-suggestions" aria-label="Suggested prompts">
          {SUGGESTED_PROMPTS.map((suggestion) => (
            <button key={suggestion} type="button" className="ask-suggestion" onClick={() => void submit(suggestion)}>
              <Sparkles size={12} /> {suggestion}
            </button>
          ))}
        </div>
      ) : null}
      <div className="ai-row">
        <input
          type="text"
          aria-label="Ask the brain"
          placeholder='Ask the brain anything…'
          value={prompt}
          disabled={running}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="ai-voice-toggle"
          type="button"
          aria-pressed={uiPrefs.voiceEnabled}
          title={uiPrefs.voiceEnabled ? "Voice on — click to mute" : "Voice off — click to have the brain speak answers"}
          onClick={() => {
            const next = !uiPrefs.voiceEnabled;
            updateUi({ voiceEnabled: next });
            if (!next) stopSpeaking();
          }}
        >
          {uiPrefs.voiceEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
        {running ? (
          <button className="ai-cancel" type="button" onClick={cancel}>
            <Square size={14} /> Stop
          </button>
        ) : (
          <button className="ai-send" type="button" disabled={!prompt.trim()} onClick={() => void submit()}>
            <Send size={14} /> Ask
          </button>
        )}
      </div>
      {running && !pending ? (
        <p className="ai-thinking">
          <Loader2 size={14} className="ai-spin" /> Routing through memory cortex…
        </p>
      ) : null}
      {visibleText ? (
        <article className="ask-answer">
          {sections.prelude ? (
            <p className="ask-prelude">
              <RichText text={sections.prelude} knownIds={knownIds} onClickCitation={jumpToCitation} />
            </p>
          ) : null}
          <section className="ask-section ask-section-known">
            <header>
              <BookOpen size={13} /> Known memory
            </header>
            {sections.known ? (
              <p>
                <RichText text={sections.known} knownIds={knownIds} onClickCitation={jumpToCitation} />
              </p>
            ) : (
              <p className="ask-empty">(no facts grounded in retrieved memory)</p>
            )}
          </section>
          <section className="ask-section ask-section-inferred">
            <header>
              <Brain size={13} /> Inferred reasoning
            </header>
            {sections.inferred ? (
              <p>
                <RichText text={sections.inferred} knownIds={knownIds} onClickCitation={jumpToCitation} />
              </p>
            ) : (
              <p className="ask-empty">(nothing inferred)</p>
            )}
          </section>
          <section className="ask-section ask-section-uncertain">
            <header>
              <HelpCircle size={13} /> Uncertain
            </header>
            {sections.uncertain ? (
              <p>
                <RichText text={sections.uncertain} knownIds={knownIds} onClickCitation={jumpToCitation} />
              </p>
            ) : (
              <p className="ask-empty">(no caveats reported)</p>
            )}
          </section>
          {running && pending ? <span className="ask-cursor" aria-hidden="true" /> : null}
          {citations.length > 0 ? (
            <ul className="ask-citations" ref={citationsRef}>
              {citations.map((c) => (
                <li
                  key={c.memoryId}
                  data-memory-id={c.memoryId}
                  className={highlightedCitation === c.memoryId ? "highlight" : ""}
                >
                  <code>m:{c.memoryId.slice(-6)}</code>
                  <span>{c.filePath ?? "conversation"}</span>
                  {typeof c.score === "number" ? <small>{(c.score * 100).toFixed(0)}%</small> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {answer && !running && runId ? (
            <div className="ask-feedback" aria-live="polite">
              {feedbackSent !== null ? (
                <span className="ask-feedback-thanks">
                  {feedbackSent > 0
                    ? "Thanks — the brain reinforced the memories it used."
                    : "Thanks — the brain will trust those memories less next time."}
                </span>
              ) : (
                <>
                  <span className="ask-feedback-label">Was this helpful?</span>
                  <button
                    type="button"
                    className="ask-feedback-btn up"
                    disabled={feedbackBusy}
                    onClick={() => void submitFeedback(1)}
                  >
                    <ThumbsUp size={13} /> Yes
                  </button>
                  <button
                    type="button"
                    className="ask-feedback-btn down"
                    disabled={feedbackBusy}
                    onClick={() => void submitFeedback(-1)}
                  >
                    <ThumbsDown size={13} /> No
                  </button>
                </>
              )}
            </div>
          ) : null}
        </article>
      ) : null}
      {error ? (
        <p className="ai-error">
          {error}
          {ServerDown ? (
            <>
              {" "}
              Start the backend with <code>npm run dev:server</code> (or <code>npm run dev:all</code>).
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
