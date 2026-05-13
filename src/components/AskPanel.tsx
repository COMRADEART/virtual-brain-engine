import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Brain, HelpCircle, Loader2, Send, Sparkles, Square } from "lucide-react";
import { apiClient, ApiError } from "../engine/apiClient";
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

interface CitationRendererProps {
  text: string;
  knownIds: Set<string>;
  onClickCitation: (memoryId: string) => void;
}

// Render text with [m:<id>] markers as clickable chips. Unknown ids appear as
// dim chips so the reader still sees them but they don't pretend to be valid.
function RichText({ text, knownIds, onClickCitation }: CitationRendererProps): JSX.Element {
  const parts = useMemo(() => {
    const out: Array<{ kind: "text" | "cite"; value: string }> = [];
    const re = /\[m:([A-Za-z0-9]+)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) {
        out.push({ kind: "text", value: text.slice(last, m.index) });
      }
      out.push({ kind: "cite", value: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      out.push({ kind: "text", value: text.slice(last) });
    }
    return out;
  }, [text]);

  return (
    <>
      {parts.map((part, idx) =>
        part.kind === "text" ? (
          <span key={idx}>{part.value}</span>
        ) : (
          <button
            key={idx}
            type="button"
            className={`citation-chip ${knownIds.has(part.value) ? "known" : "unknown"}`}
            onClick={() => onClickCitation(part.value)}
            title={knownIds.has(part.value) ? "Jump to citation" : "Marker not in retrieved memory"}
          >
            m:{part.value.slice(-6)}
          </button>
        ),
      )}
    </>
  );
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
  const abortRef = useRef<AbortController | null>(null);
  const citationsRef = useRef<HTMLUListElement | null>(null);

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
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError(null);
      setAnswer("");
      setPending("");
      setCitations([]);
      setHighlightedCitation(null);

      let streamed = "";
      try {
        for await (const event of apiClient.ask(
          { prompt: sourceText, conversationId: conversationId ?? undefined },
          controller.signal,
        )) {
          if (event.conversationId && event.conversationId !== conversationId) {
            setConversationId(event.conversationId);
            onConversationChange?.(event.conversationId);
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
          if (event.status === "error") {
            setError(event.detail ?? "Pipeline error");
          }
        }
        if (!answer && streamed) {
          setAnswer(streamed);
        }
      } catch (err) {
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
