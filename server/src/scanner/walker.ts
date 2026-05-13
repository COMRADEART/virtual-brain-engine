import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "target",
  "venv",
  ".venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".pytest_cache",
  ".mypy_cache",
  ".idea",
  ".vscode",
  "coverage",
  ".parcel-cache",
]);

const WHITELIST_EXT = new Set([
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".env.example",
  ".sql",
  ".sh",
  ".ps1",
]);

export interface WalkOptions {
  maxBytes: number;
  maxFiles: number;
}

export interface WalkedFile {
  path: string;
  size: number;
  projectName: string;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

// `root` and `path` are absolute; project = top-level folder under root.
function projectNameFor(root: string, path: string): string {
  const rel = path.slice(root.length).replace(/^[/\\]+/, "");
  const first = rel.split(/[/\\]/)[0];
  return first || "(root)";
}

export async function* walk(root: string, opts: WalkOptions): AsyncGenerator<WalkedFile> {
  const absoluteRoot = resolve(root);
  let yielded = 0;
  const queue: string[] = [absoluteRoot];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (IGNORE_DIRS.has(name)) {
        continue;
      }
      const full = join(dir, name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!info.isFile()) {
        continue;
      }
      // Whitelist by extension; everything else is silently skipped.
      const ext = extOf(name);
      if (!WHITELIST_EXT.has(ext)) {
        continue;
      }
      if (info.size > opts.maxBytes || info.size === 0) {
        continue;
      }
      yield {
        path: full,
        size: info.size,
        projectName: projectNameFor(absoluteRoot, full),
      };
      yielded += 1;
      if (yielded >= opts.maxFiles) {
        return;
      }
    }
  }
}

export function isLikelyBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

export function pathSep(): string {
  return sep;
}
