// Git operations for the action layer. Provides git clone, list-files,
// read-code, write-code, and commit-push capabilities.
//
// All operations run through child_process spawn with sanitized inputs.
// Clones are sandboxed to a temp directory to prevent arbitrary path writes.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { isExcludedPath } from "../ingest/governance.js";

// Sandbox directory for git clones — prevents cloning to arbitrary locations.
const GIT_SANDBOX = join(os.tmpdir(), "star-brain-git");
const MAX_CLONE_SIZE_MB = 500;
const MAX_FILE_READ_BYTES = 256 * 1024;

interface GitResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
}

// Ensure the sandbox directory exists.
async function ensureSandbox(): Promise<string> {
  try {
    await fs.mkdir(GIT_SANDBOX, { recursive: true });
  } catch {
    // already exists
  }
  return GIT_SANDBOX;
}

// Run a git command and return stdout/stderr.
function runGit(args: string[], cwd: string, timeoutMs = 60000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += String(d)));
    proc.stderr?.on("data", (d) => (stderr += String(d)));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
  });
}

// Clone a repository to the sandbox. Returns the local path where it was cloned.
export async function cloneRepo(url: string, branch?: string): Promise<GitResult> {
  const sandbox = await ensureSandbox();

  // Sanitize: only allow https:// or ssh git URLs. Block file:// and local paths.
  if (!/^https?:\/\//.test(url) && !url.startsWith("git@")) {
    return { ok: false, summary: "", error: "only https:// or git@ URLs allowed" };
  }

  // Generate a safe local name from the URL.
  const repoName = url.replace(/\.git$/, "").split("/").pop() ?? "repo";
  const localPath = join(sandbox, repoName);

  // Refuse if the path would be in an excluded location.
  if (isExcludedPath(localPath)) {
    return { ok: false, summary: "", error: "refused: destination is a sensitive location" };
  }

  // Check if already cloned.
  try {
    await fs.access(localPath);
    return { ok: true, summary: `Repository already cloned at ${localPath}`, data: { path: localPath, alreadyExisted: true } };
  } catch {
    // proceed with clone
  }

  const cloneArgs = ["clone", "--depth", "1"];
  if (branch) cloneArgs.push("-b", branch);
  cloneArgs.push(url, repoName);

  const r = await runGit(cloneArgs, sandbox);
  if (r.code !== 0) {
    return { ok: false, summary: "", error: `git clone failed: ${r.stderr || "unknown error"}` };
  }

  return { ok: true, summary: `Cloned ${url} to ${localPath}`, data: { path: localPath, alreadyExisted: false } };
}

// List files in a cloned repository.
export async function listRepoFiles(path: string, maxItems = 500): Promise<GitResult> {
  const resolved = resolve(path);
  if (isExcludedPath(resolved)) {
    return { ok: false, summary: "", error: "refused: path is a sensitive location" };
  }

  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const items = entries.slice(0, maxItems).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other",
    }));
    return { ok: true, summary: `Listed ${items.length} items in ${resolved}`, data: items };
  } catch (err) {
    return { ok: false, summary: "", error: `cannot read directory: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Read a file from a cloned repository.
export async function readRepoFile(path: string): Promise<GitResult> {
  const resolved = resolve(path);
  if (isExcludedPath(resolved)) {
    return { ok: false, summary: "", error: "refused: path is a sensitive location" };
  }

  try {
    const st = await fs.stat(resolved);
    if (!st.isFile()) {
      return { ok: false, summary: "", error: "not a file" };
    }
    if (st.size > MAX_FILE_READ_BYTES) {
      return { ok: false, summary: "", error: `file too large (${st.size} bytes > ${MAX_FILE_READ_BYTES})` };
    }
    const content = await fs.readFile(resolved, "utf8");
    return { ok: true, summary: `Read ${resolved} (${content.length} chars)`, data: { path: resolved, content } };
  } catch (err) {
    return { ok: false, summary: "", error: `cannot read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Write a file to a cloned repository.
export async function writeRepoFile(path: string, content: string): Promise<GitResult> {
  const resolved = resolve(path);
  if (isExcludedPath(resolved)) {
    return { ok: false, summary: "", error: "refused: path is a sensitive location" };
  }

  try {
    await fs.writeFile(resolved, content, "utf8");
    return { ok: true, summary: `Wrote ${content.length} chars to ${resolved}`, data: { path: resolved, bytes: Buffer.byteLength(content, "utf8") } };
  } catch (err) {
    return { ok: false, summary: "", error: `cannot write file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Get the list of modified/staged files in a repository.
export async function getRepoStatus(path: string): Promise<GitResult> {
  const resolved = resolve(path);
  if (isExcludedPath(resolved)) {
    return { ok: false, summary: "", error: "refused: path is a sensitive location" };
  }

  const r = await runGit(["status", "--porcelain"], resolved);
  if (r.code !== 0) {
    return { ok: false, summary: "", error: `git status failed: ${r.stderr}` };
  }

  const files = r.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3).trim(),
    }));

  return { ok: true, summary: `${files.length} changed file(s) in ${resolved}`, data: files };
}

// Commit and optionally push changes in a repository.
export async function commitRepo(path: string, message: string, push = false): Promise<GitResult> {
  const resolved = resolve(path);
  if (isExcludedPath(resolved)) {
    return { ok: false, summary: "", error: "refused: path is a sensitive location" };
  }

  // git add -A
  let r = await runGit(["add", "-A"], resolved);
  if (r.code !== 0) {
    return { ok: false, summary: "", error: `git add failed: ${r.stderr}` };
  }

  // Check if there are changes to commit
  r = await runGit(["status", "--porcelain"], resolved);
  if (!r.stdout.trim()) {
    return { ok: true, summary: "No changes to commit", data: { committed: false, pushed: false } };
  }

  // git commit -m "message"
  r = await runGit(["commit", "-m", message], resolved);
  if (r.code !== 0) {
    return { ok: false, summary: "", error: `git commit failed: ${r.stderr}` };
  }

  let pushed = false;
  if (push) {
    // git push
    r = await runGit(["push"], resolved);
    if (r.code !== 0) {
      return { ok: false, summary: "", error: `git push failed: ${r.stderr}` };
    }
    pushed = true;
  }

  return { ok: true, summary: `Committed${push ? " and pushed" : ""} to ${resolved}`, data: { committed: true, pushed } };
}

// Get list of branches.
export async function listBranches(path: string): Promise<GitResult> {
  const resolved = resolve(path);
  if (isExcludedPath(resolved)) {
    return { ok: false, summary: "", error: "refused: path is a sensitive location" };
  }

  const r = await runGit(["branch", "-a"], resolved);
  if (r.code !== 0) {
    return { ok: false, summary: "", error: `git branch failed: ${r.stderr}` };
  }

  const branches = r.stdout
    .split("\n")
    .map((b) => b.replace(/^\*?\s*/, "").trim())
    .filter(Boolean);

  return { ok: true, summary: `${branches.length} branch(es) in ${resolved}`, data: branches };
}

// Checkout a branch.
export async function checkoutBranch(path: string, branch: string): Promise<GitResult> {
  const resolved = resolve(path);
  if (isExcludedPath(resolved)) {
    return { ok: false, summary: "", error: "refused: path is a sensitive location" };
  }

  const r = await runGit(["checkout", branch], resolved);
  if (r.code !== 0) {
    return { ok: false, summary: "", error: `git checkout failed: ${r.stderr}` };
  }

  return { ok: true, summary: `Checked out ${branch} in ${resolved}`, data: { branch } };
}