// Shared contract for GitHub project discovery ("learn from popular repos"). The
// brain discovers high-star repositories for a topic and ingests their READMEs as
// citeable knowledge. ZERO runtime deps — pure types — so both the Vite client
// and the Node server import it without a build step. The server enforces the
// LOCAL_ONLY egress gate + host pinning; these are just the wire shapes.

// One discovered repository (the fields we keep from the GitHub search response).
export interface GitHubRepo {
  // "owner/name" — the canonical identifier.
  fullName: string;
  owner: string;
  name: string;
  // The repo's html_url (https://github.com/owner/name).
  url: string;
  description: string;
  stars: number;
  // Primary language, or null when GitHub reports none.
  language: string | null;
  topics: string[];
}

// Result of a discovery (search-only) call.
export type GitHubDiscoverOutcome =
  | { ok: true; repos: GitHubRepo[] }
  | { ok: false; reason: string };

// What POST /api/github/learn returns to the client. The fusable README hit
// bodies stay server-side; the client gets the discovered repos + learn counts.
export interface GitHubLearnView {
  ok: boolean;
  query: string;
  repos: GitHubRepo[];
  // How many repos actually had a README learned into memory.
  reposLearned: number;
  // New / already-known memory chunks across all learned READMEs.
  ingested: number;
  deduped: number;
  reason?: string;
}

// Default minimum stars ("more than 1k"). The server clamps via GITHUB_MIN_STARS.
export const GITHUB_DEFAULT_MIN_STARS = 1000;
