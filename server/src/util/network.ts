// Loopback + RFC1918 allowlist. Used by the LOCAL_ONLY guard in the connector
// registry and by /api/connectors validation so we can refuse non-local
// baseUrls before they ever round-trip to the model.

// The only remote hosts allowed to bypass the LOCAL_ONLY gate: two free-tier,
// OpenAI-compatible model providers. Matching is EXACT-host (see
// isAllowedRemoteHost) so a look-alike like "generativelanguage.googleapis.com.evil.com"
// is rejected — only these precise hostnames pass.
const BUILTIN_REMOTE_PROVIDER_HOSTS = new Set<string>([
  "integrate.api.nvidia.com", // NVIDIA NIM
  "generativelanguage.googleapis.com", // Google Gemini (OpenAI-compatible endpoint)
]);

// Memoize the parsed env extension. Read lazily (not at module load) so the
// value is correct regardless of whether config.ts has populated process.env
// from .env yet at import time.
let cachedEnvHosts: { raw: string | undefined; set: Set<string> } | null = null;

function extraRemoteHosts(): Set<string> {
  const raw = process.env.REMOTE_PROVIDER_ALLOWLIST;
  if (cachedEnvHosts && cachedEnvHosts.raw === raw) {
    return cachedEnvHosts.set;
  }
  const set = new Set<string>();
  if (raw) {
    for (const part of raw.split(",")) {
      const host = part.trim().toLowerCase();
      if (host) {
        set.add(host);
      }
    }
  }
  cachedEnvHosts = { raw, set };
  return set;
}

// True only when `input` is a well-formed URL whose host EXACTLY matches one of
// the allowlisted remote provider hosts (built-in NVIDIA/Gemini plus any added
// via REMOTE_PROVIDER_ALLOWLIST). Used alongside isLocalUrl by the connector
// route/registry guards so the curated providers can be reached while every
// other non-local URL stays blocked under LOCAL_ONLY=true.
export function isAllowedRemoteHost(input: string | undefined | null): boolean {
  if (!input) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return BUILTIN_REMOTE_PROVIDER_HOSTS.has(host) || extraRemoteHosts().has(host);
}

export function isLocalUrl(input: string | undefined | null): boolean {
  if (!input) {
    // Connectors without a baseUrl (stubs) cannot leak traffic.
    return true;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  return isLocalHostname(url.hostname);
}

// EGRESS GATE — the single decision behind every outbound path that is NOT a
// curated LLM connector (web search, web fetch/ingest, GitHub discovery, MCP
// transport, MCP marketplace). Returns whether `url` may be reached under
// `localOnly`: under LOCAL_ONLY=true only loopback/RFC1918/unique-local targets
// pass (via isLocalUrl). There is NO remote-host bypass here — unlike
// isAllowedRemoteHost, which applies ONLY to connectors. Each caller keeps its
// OWN response: its own reason string, return-result-vs-throw, redirect policy,
// and host-pin (github/mcp-marketplace pin to their API host before this runs).
// This helper only answers "may I egress?" so the gate lives in one place and a
// new outbound path cannot accidentally forget it.
export function assertEgressAllowed(
  url: string | undefined | null,
  localOnly: boolean,
): { ok: true } | { ok: false; reason: string } {
  if (localOnly && !isLocalUrl(url)) {
    return {
      ok: false,
      reason:
        "blocked: egress is off while LOCAL_ONLY=true (set LOCAL_ONLY=false to allow remote targets)",
    };
  }
  return { ok: true };
}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  // IPv4 literal — match 127/8, 10/8, 192.168/16, 172.16/12.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127 || a === 10) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    return false;
  }
  // IPv6 link-local fe80::/10 and unique-local fc00::/7 — ONLY for actual IPv6
  // literals. A URL-parsed IPv6 host always contains a colon; a DNS name never
  // does. Without the `includes(":")` guard the bare `fc`/`fd` prefix matches
  // wrongly classified remote domains (fdroid.org, fc-cdn.example.com, …) as
  // local, letting them slip past the LOCAL_ONLY egress gate.
  if (host.includes(":")) {
    if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
      return true;
    }
  }
  return false;
}
