// Citation markers — the brain's `[m:<id>]` memory-citation convention, lifted out
// of the 7-step pipeline so BOTH the pipeline's response step AND the deep-research
// engine validate citations the SAME way (one source of truth). PURE — no DB, no
// network — and therefore the deep-research selfcheck's unit target.
//
// A regex factory (not a shared global) avoids the stateful-`lastIndex` footgun:
// every call gets a fresh, independent matcher.

function markerRe(): RegExp {
  return /\[m:([A-Za-z0-9]+)\]/g;
}

// All memory ids referenced by `[m:<id>]` markers, in order of appearance.
export function extractMarkerIds(text: string): string[] {
  return Array.from(text.matchAll(markerRe())).map((m) => m[1]);
}

// Strip any `[m:<id>]` marker whose id is NOT in `knownIds` (the model can
// hallucinate a citation), and — when an "Uncertain:" section is present — note
// the strip there. Verbatim behaviour from the original pipeline implementation,
// so the existing live ask path is unchanged.
export function validateMarkers(answer: string, knownIds: Set<string>): string {
  const markers = extractMarkerIds(answer);
  const unknown = markers.filter((id) => !knownIds.has(id));
  if (unknown.length === 0) {
    return answer;
  }
  let cleaned = answer;
  for (const id of unknown) {
    cleaned = cleaned.split(`[m:${id}]`).join("");
  }
  const note = `Stripped ${unknown.length} unknown memory marker(s) from the model output.`;
  return cleaned.replace(/(Uncertain:\s*)/, `$1${note} `);
}
