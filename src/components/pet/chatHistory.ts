// Pet chat history — pure reducers so the expanded panel can keep a scrollable
// multi-turn transcript instead of overwriting a single Exchange on every turn.
// Kept dependency-free + pure so they unit-test without a DOM.

export interface Exchange {
  question: string;
  answer: string;
}

/** Cap on retained turns — bounds memory for a long-running pet window. */
export const MAX_EXCHANGES = 20;

/** Append a new exchange, trimming the oldest beyond the cap. Returns a new array. */
export function appendExchange(
  list: ReadonlyArray<Exchange>,
  next: Exchange,
  cap: number = MAX_EXCHANGES,
): Exchange[] {
  const out = [...list, next];
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/**
 * Update the answer of the most-recent exchange (the one currently streaming).
 * No-op (returns the same array) when the list is empty. Returns a new array.
 */
export function updateLastAnswer(list: ReadonlyArray<Exchange>, answer: string): Exchange[] {
  if (list.length === 0) return [...list];
  const out = [...list];
  out[out.length - 1] = { ...out[out.length - 1], answer };
  return out;
}
