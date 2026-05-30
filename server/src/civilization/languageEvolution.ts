import type { LanguageEvolution } from "../../../shared/civilization.js";

/**
 * Synthetic Language Evolution (architecture component #14).
 *
 * Tracks how brains compress their shared communication over time: agreed symbols
 * for concepts, abbreviations for frequent phrases, and shorthands for recurring
 * reasoning steps. Frequently-used proposals get "adopted" once they cross a usage
 * threshold; `compress`/`expand` apply the adopted dialect to message text and the
 * compression ratio is the headline efficiency metric. Pure in-memory.
 */

export interface LanguageEvolutionConfig {
  /** Times a proposed token must be used before it's promoted to adopted. */
  adoptionThreshold: number;
  civilizationId: string;
}

const DEFAULT_CONFIG: LanguageEvolutionConfig = {
  adoptionThreshold: 3,
  civilizationId: "local",
};

type Lexicon = "symbol" | "abbreviation" | "shorthand";

interface LexEntry {
  full: string;
  token: string;
  uses: number;
  adopted: boolean;
}

export class LanguageEvolutionSystem {
  private readonly config: LanguageEvolutionConfig;
  private readonly symbols = new Map<string, LexEntry>();
  private readonly abbreviations = new Map<string, LexEntry>();
  private readonly shorthands = new Map<string, LexEntry>();
  private lastUpdatedAt = new Date().toISOString();

  constructor(config: Partial<LanguageEvolutionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  propose(lexicon: Lexicon, full: string, token: string): void {
    const map = this.mapFor(lexicon);
    const existing = map.get(full);
    if (existing) {
      existing.uses++;
      if (!existing.adopted && existing.uses >= this.config.adoptionThreshold) {
        existing.adopted = true;
      }
    } else {
      map.set(full, { full, token, uses: 1, adopted: this.config.adoptionThreshold <= 1 });
    }
    this.lastUpdatedAt = new Date().toISOString();
  }

  /** Convenience wrappers matching the architecture vocabulary. */
  proposeSymbol(concept: string, symbol: string): void {
    this.propose("symbol", concept, symbol);
  }
  proposeAbbreviation(phrase: string, abbrev: string): void {
    this.propose("abbreviation", phrase, abbrev);
  }
  proposeShorthand(reasoning: string, shorthand: string): void {
    this.propose("shorthand", reasoning, shorthand);
  }

  isAdopted(lexicon: Lexicon, full: string): boolean {
    return this.mapFor(lexicon).get(full)?.adopted ?? false;
  }

  /** Apply the adopted dialect to text (longest phrases first to avoid partial hits). */
  compress(text: string): string {
    let out = text;
    for (const entry of this.adoptedEntries()) {
      out = out.split(entry.full).join(entry.token);
    }
    return out;
  }

  expand(text: string): string {
    let out = text;
    for (const entry of this.adoptedEntries()) {
      out = out.split(entry.token).join(entry.full);
    }
    return out;
  }

  /** Mean character-length reduction the adopted dialect would achieve on `text`. */
  compressionRatio(text: string): number {
    if (text.length === 0) return 0;
    const compressed = this.compress(text);
    return 1 - compressed.length / text.length;
  }

  /** Serializable snapshot (the shared type uses Maps, which don't JSON cleanly). */
  getStateSerializable(): {
    civilizationId: string;
    sharedSymbols: Record<string, string>;
    abbreviations: Record<string, string>;
    reasoningShorthands: Record<string, string>;
    adoptedCount: number;
    proposedCount: number;
    lastUpdatedAt: string;
  } {
    return {
      civilizationId: this.config.civilizationId,
      sharedSymbols: this.adoptedRecord(this.symbols),
      abbreviations: this.adoptedRecord(this.abbreviations),
      reasoningShorthands: this.adoptedRecord(this.shorthands),
      adoptedCount: this.adoptedEntries().length,
      proposedCount: this.symbols.size + this.abbreviations.size + this.shorthands.size,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  /** The shared `LanguageEvolution` shape (Map-based) for in-process consumers. */
  getState(): LanguageEvolution {
    return {
      civilizationId: this.config.civilizationId,
      sharedSymbols: this.adoptedMap(this.symbols),
      abbreviations: this.adoptedMap(this.abbreviations),
      reasoningShorthands: this.adoptedMap(this.shorthands),
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  private adoptedEntries(): LexEntry[] {
    const all = [...this.symbols.values(), ...this.abbreviations.values(), ...this.shorthands.values()];
    return all.filter((e) => e.adopted).sort((a, b) => b.full.length - a.full.length);
  }

  private adoptedRecord(map: Map<string, LexEntry>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of map.values()) if (e.adopted) out[e.full] = e.token;
    return out;
  }

  private adoptedMap(map: Map<string, LexEntry>): Map<string, string> {
    const out = new Map<string, string>();
    for (const e of map.values()) if (e.adopted) out.set(e.full, e.token);
    return out;
  }

  private mapFor(lexicon: Lexicon): Map<string, LexEntry> {
    return lexicon === "symbol" ? this.symbols : lexicon === "abbreviation" ? this.abbreviations : this.shorthands;
  }
}

let singleton: LanguageEvolutionSystem | null = null;

export function createLanguageEvolution(config?: Partial<LanguageEvolutionConfig>): LanguageEvolutionSystem {
  if (!singleton) {
    singleton = new LanguageEvolutionSystem(config);
  }
  return singleton;
}

export function getLanguageEvolution(): LanguageEvolutionSystem | null {
  return singleton;
}
