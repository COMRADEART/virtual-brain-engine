// SummaryAgent — turns observed activity into long-term memory.
//
// Reactive: buffers `activity-observed` bursts per project.
// Proactive (runtime cycle): think() decides if there is anything to roll up;
// act() asks the active connector for a concise "recent work" summary, writes
// it as a MemoryPoint (reusing the existing memory repo + sqlite-vec), and
// emits `summary-created`. Degrades gracefully — if no connector is reachable
// it skips the cycle instead of failing.

import { createHash } from "node:crypto";
import type { Agent, AgentContext } from "./Agent.js";
import { Connector } from "../connectors/Connector.js";
import {
  getDefaultConnectorInstance,
  listConnectorInstances,
} from "../connectors/registry.js";
import { upsertMemoryPoint } from "../db/repositories/memory.js";
import { CONFIG } from "../config.js";

const MAX_PROJECTS_PER_CYCLE = 3; // bound LLM calls per runtime tick
const MAX_FILES_IN_PROMPT = 30;
const SUMMARY_MAX_TOKENS = 200;

function sha1(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

// Mirrors getActiveEmbedder() in memory/consolidationEngine.ts: prefer the
// default connector, else any healthy local Ollama that can embed.
function getEmbedder(): Connector | null {
  const active = getDefaultConnectorInstance();
  if (active?.embed) return active;
  return (
    listConnectorInstances().find(
      (c) =>
        c.descriptor.kind === "ollama" &&
        c.descriptor.enabled &&
        c.descriptor.state === "ok" &&
        Boolean(c.embed),
    ) ?? null
  );
}

export class SummaryAgent implements Agent {
  private ctx: AgentContext | null = null;
  private pending = new Map<string, Set<string>>(); // project -> files
  private hasWork = false;

  name(): string {
    return "summary";
  }

  capabilities(): string[] {
    return ["session-compression", "memory-write", "recent-work"];
  }

  init(ctx: AgentContext): void {
    this.ctx = ctx;
  }

  handleEvent(event: Parameters<Agent["handleEvent"]>[0]): void {
    if (event.kind !== "activity-observed") return;
    let set = this.pending.get(event.projectName);
    if (!set) {
      set = new Set<string>();
      this.pending.set(event.projectName, set);
    }
    for (const f of event.files) set.add(f);
  }

  think(): void {
    this.hasWork = this.pending.size > 0;
  }

  async act(): Promise<void> {
    if (!this.hasWork || !this.ctx) return;

    const connector = getDefaultConnectorInstance();
    if (!connector) {
      this.ctx.setStatus("idle", "no connector; summary skipped");
      return;
    }

    const projects = [...this.pending.entries()].slice(0, MAX_PROJECTS_PER_CYCLE);
    const embedder = getEmbedder();

    for (const [project, fileSet] of projects) {
      this.pending.delete(project);
      const files = [...fileSet];
      const shown = files.slice(0, MAX_FILES_IN_PROMPT);

      const prompt = `These files changed in project "${project}":
${shown.map((f) => `- ${f}`).join("\n")}${files.length > shown.length ? `\n…and ${files.length - shown.length} more` : ""}

Write a 2-3 sentence summary of what work this likely represents. Focus on the apparent task, not a file listing.`;

      let summary: string;
      try {
        summary = (
          await connector.send(prompt, {
            system:
              "You summarize a developer's recent work from changed files. Output ONLY the summary, no preamble.",
            format: "text",
            temperature: 0.2,
            maxTokens: SUMMARY_MAX_TOKENS,
          })
        ).trim();
      } catch (err) {
        this.ctx.log(
          `summary generation failed for "${project}": ${err instanceof Error ? err.message : String(err)}`,
        );
        continue; // graceful: leave other projects, don't throw out of act()
      }
      if (!summary) continue;

      // Embed when possible so the summary is vector-searchable; skip silently
      // (memory still stored) on mismatch/failure.
      let embedding: number[] | undefined;
      if (embedder?.embed) {
        try {
          const vec = await embedder.embed(summary);
          if (vec.length === CONFIG.embeddingDim) embedding = vec;
        } catch {
          /* store without vector */
        }
      }

      const title = `Work summary — ${project} — ${new Date().toISOString().slice(0, 10)}`;
      const memory = upsertMemoryPoint({
        sourceType: "manual",
        projectName: project === "(unknown)" ? null : project,
        title,
        content: summary,
        contentHash: sha1(`work-summary|${project}|${summary}`),
        embedding,
        importance: 0.55,
        metadata: {
          kind: "work-summary",
          generatedBy: "summary-agent",
          fileCount: files.length,
          files: shown,
        },
      });

      this.ctx.bus.emit({
        kind: "summary-created",
        memoryId: memory.id,
        projectName: memory.projectName ?? null,
        summary,
        at: new Date().toISOString(),
      });
      this.ctx.log(`summarized "${project}" (${files.length} file(s)) -> ${memory.id}`);
    }

    this.hasWork = this.pending.size > 0;
  }

  shutdown(): void {
    this.pending.clear();
  }
}
