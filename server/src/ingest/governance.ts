// Privacy governance for memory ingestion. Pure (no DB, no network) so it's
// trivially testable and reusable. Three independent controls; consent +
// excludes are the PRIMARY guarantees, redaction is the BACKSTOP.

// --- Redaction --------------------------------------------------------------
// Scoped DELIBERATELY to credentials/keys/tokens. We do NOT redact emails,
// names, addresses, etc.: in a personal memory brain that PII is the legitimate
// payload, and over-redaction silently guts the feature. A regex scrubber will
// always miss novel secret shapes — so this is a backstop behind consent +
// excludes, never the primary defence.
const SECRET_PATTERNS: RegExp[] = [
  // PEM private key blocks.
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  // OpenAI-style keys (incl. sk-proj-…).
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
  // key/secret/token/password = <value> (incl. URL query params like
  // ?access_token=…). The value must be a single non-space run of >= 6 chars,
  // which keeps prose like "the secret: it was fun" from matching.
  /\b(?:api[_-]?key|access[_-]?token|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?[^\s"'&]{6,}/gi,
];

const REDACTION = "[redacted]";

export interface RedactionResult {
  text: string;
  count: number;
}

// Scrubs secrets from a single field. Returns the cleaned text and how many
// matches were replaced. Safe to run on any persisted field (content, title,
// sourcePath) — call it on ALL of them, not just content.
export function redactSecrets(input: string): RedactionResult {
  let count = 0;
  let text = input;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      count += 1;
      return REDACTION;
    });
  }
  return { text, count };
}

// --- Exclude paths ----------------------------------------------------------
// Obviously-sensitive locations whose contents should never be captured,
// regardless of redaction. Matched case-insensitively against the item's
// provenance path. (User-configurable rules are a deferred follow-up; these are
// the safe hardcoded defaults.)
const EXCLUDE_PATTERNS: RegExp[] = [
  /\.env(\.|$|\b)/i,
  /\bid_rsa\b/i,
  /[\\/]\.ssh[\\/]/i,
  /[\\/]\.aws[\\/]/i,
  /[\\/]\.gnupg[\\/]/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\bcredentials?\b/i,
  /\bsecrets?\b/i,
  /\b\.npmrc\b/i,
  /\bwallet\b/i,
  /[\\/](?:KeePass|1Password|Bitwarden)[\\/]/i,
];

export function isExcludedPath(path: string | undefined | null): boolean {
  if (!path) {
    return false;
  }
  return EXCLUDE_PATTERNS.some((p) => p.test(path));
}
