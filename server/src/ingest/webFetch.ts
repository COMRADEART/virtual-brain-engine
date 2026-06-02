// "Learn from the internet" — the fetch + readable-text extraction half of the
// web ingest source. PURE of persistence (no DB): it fetches a URL, validates
// it, extracts text, and hands chunks back to ingest/index.ts, which runs them
// through the SAME governance (redact → dedup → importance → audit) as every
// other source.
//
// EGRESS GUARANTEE. This is the only ingest source that leaves the machine, so
// it sits behind the SAME gate as the remote-LLM connectors: when the server is
// LOCAL_ONLY (the default), only loopback/RFC1918 targets are reachable —
// `isLocalUrl()` rejects every internet host, so no internet request is issued
// and "zero outbound traffic by default" holds. Redirects are NOT an escape
// hatch: under LOCAL_ONLY the fetch uses `redirect:"manual"` and refuses any
// 30x, so a gate-passing local target cannot bounce the request off-box (the
// gate validates the initial URL; manual-redirect closes the follow-up hop).
// Internet learning requires the user to have already set LOCAL_ONLY=false (the
// same opt-out that enables remote models), at which point the LocalityBadge
// already reads amber.
//
// `fetchImpl` is injectable so the selfcheck can exercise every branch with
// canned responses and ZERO real network.
//
// KNOWN LIMITATION (SSRF inverse). The LOCAL_ONLY gate blocks *internet* egress,
// but its mirror image is that under LOCAL_ONLY=true the fetcher CAN reach
// loopback/LAN hosts (a router admin page, this server's own API, any RFC1918
// box), and under LOCAL_ONLY=false it can reach anything — including link-local
// cloud-metadata (169.254.169.254). For this app's threat model — a single-user,
// local-first desktop where the user supplies and confirms the URL, and we only
// read HTML text into memory and send no credentials — the impact is low and
// accepted. If this ever runs on a shared/cloud host, add an explicit
// deny-list for link-local/metadata ranges before trusting it there.

import { CONFIG } from "../config.js";
import { isLocalUrl } from "../util/network.js";

export interface WebFetchOptions {
  // Injected in tests; defaults to the global fetch in production.
  fetchImpl?: typeof fetch;
  // Defaults to CONFIG.localOnly. When true, only local targets are reachable.
  localOnly?: boolean;
  // Download cap (bytes). A page over this is refused, not truncated.
  maxBytes?: number;
  // Extracted-text cap (chars) BEFORE chunking — a backstop on pathological pages.
  maxChars?: number;
  // Per-request timeout.
  timeoutMs?: number;
}

export type WebFetchResult =
  | { ok: true; title: string | null; text: string; finalUrl: string }
  | { ok: false; reason: string };

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];

// --- HTML → text ------------------------------------------------------------

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => NAMED_ENTITIES[e] ?? _)
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => {
      const code = parseInt(h, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : _;
    });
}

// Best-effort, dependency-free extraction. Good enough to "read a page"; it is
// NOT a full DOM parser (that would be a heavy dep we deliberately avoid). The
// <title> is pulled from the raw HTML first so removing markup can't lose it.
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).replace(/\s+/g, " ").trim().slice(0, 200) || null : null;

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Turn block-level boundaries into newlines so paragraph structure survives
  // for the chunker; everything else collapses to spaces.
  body = body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre)\s*>/gi, "\n");
  body = decodeEntities(stripTags(body));
  body = body
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: body };
}

// --- Chunking ---------------------------------------------------------------

// Split readable text into retrieval-sized chunks on paragraph boundaries,
// hard-wrapping any single paragraph longer than 2× target. Bounded by
// maxChunks so one giant page can't flood memory with thousands of rows.
export function chunkText(text: string, opts: { targetChars?: number; maxChunks?: number } = {}): string[] {
  const target = Math.max(200, opts.targetChars ?? 1000);
  const maxChunks = Math.max(1, opts.maxChunks ?? 50);

  const units: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.replace(/\s+/g, " ").trim();
    if (!p) continue;
    if (p.length <= target * 2) {
      units.push(p);
    } else {
      for (let i = 0; i < p.length; i += target) units.push(p.slice(i, i + target));
    }
  }

  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    if (!cur) cur = u;
    else if (cur.length + 1 + u.length <= target) cur += "\n" + u;
    else {
      chunks.push(cur);
      cur = u;
    }
    if (chunks.length >= maxChunks) break;
  }
  if (cur && chunks.length < maxChunks) chunks.push(cur);
  return chunks.slice(0, maxChunks);
}

// --- Capped body read -------------------------------------------------------

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            return null;
          }
          chunks.push(Buffer.from(value));
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  // Fallback (e.g. a test fake with no stream body): read fully, then cap.
  const text = await res.text();
  return Buffer.byteLength(text, "utf8") > maxBytes ? null : text;
}

// --- Fetch ------------------------------------------------------------------

export async function fetchUrlText(rawUrl: string, opts: WebFetchOptions = {}): Promise<WebFetchResult> {
  const localOnly = opts.localOnly ?? CONFIG.localOnly;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme: ${url.protocol}` };
  }

  // EGRESS GATE — see file header. Blocked targets never reach `doFetch`.
  if (localOnly && !isLocalUrl(rawUrl)) {
    return {
      ok: false,
      reason: "blocked: web learning is off while LOCAL_ONLY=true (set LOCAL_ONLY=false to allow internet fetches)",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await doFetch(rawUrl, {
      signal: controller.signal,
      // Under LOCAL_ONLY we MUST NOT auto-follow redirects. The gate above
      // validated only `rawUrl`; `redirect:"follow"` would transparently
      // re-issue the request to a 30x `Location` — which can be a REMOTE host,
      // egressing under LOCAL_ONLY=true. "manual" makes fetch SURFACE the 3xx
      // (status 0 / type "opaqueredirect", or a visible 3xx) without contacting
      // the target, so we refuse it below before a byte leaves the machine.
      redirect: localOnly ? "manual" : "follow",
      headers: {
        "user-agent": "STAR-Brain/0.1 (+local personal memory)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, reason: `timed out after ${timeoutMs}ms` };
    return { ok: false, reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  clearTimeout(timer);

  // Off-box redirect refusal (LOCAL_ONLY). The redirect target was NOT contacted
  // (redirect:"manual"); refusing is correct rather than chasing the hop.
  // CONSEQUENCE: under LOCAL_ONLY=true this refuses ALL 30x, including a same-box
  // local→local redirect (e.g. a local service that 301s http→https). In practice
  // callers reach a 200 directly; if a local fetch ever "breaks" under LOCAL_ONLY,
  // this is why — set LOCAL_ONLY=false or point at the post-redirect URL.
  if (localOnly && (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))) {
    return { ok: false, reason: "blocked: off-box redirect refused under LOCAL_ONLY" };
  }

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const typeAllowed = contentType === "" || ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t));
  if (!typeAllowed) return { ok: false, reason: `unsupported content-type: ${contentType}` };

  const raw = await readCapped(res, maxBytes);
  if (raw === null) return { ok: false, reason: `body exceeds ${maxBytes} bytes` };

  const looksHtml = contentType.includes("html") || /^\s*<(?:!doctype|html|head|body)\b/i.test(raw);
  const extracted = looksHtml ? htmlToText(raw) : { title: null, text: raw };
  const text = extracted.text.slice(0, maxChars).trim();
  if (text.length === 0) return { ok: false, reason: "no extractable text" };

  return { ok: true, title: extracted.title, text, finalUrl: res.url || rawUrl };
}
