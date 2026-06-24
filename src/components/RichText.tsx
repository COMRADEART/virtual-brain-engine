import { useMemo } from "react";

interface CitationRendererProps {
  text: string;
  knownIds: Set<string>;
  onClickCitation: (memoryId: string) => void;
}

// Render text with [m:<id>] markers as clickable citation chips. Unknown ids
// render as dim chips so the reader still sees them but they don't pretend to be
// valid. Shared by AskPanel and the Deep Research panel (one citation renderer).
export function RichText({ text, knownIds, onClickCitation }: CitationRendererProps): JSX.Element {
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
