// Pure mood-mapping logic for the desktop-pet companion. Extracted from
// PetWindow so it can be exhaustively checked without a DOM (see
// scripts/pet-selfcheck.ts). Type-only imports keep this module
// runtime-dependency-free, so a plain tsx script can import it directly.
import type { AgentRuntimeState } from "../../../shared/pipeline";
import type { PersonalityState, Phase2Mood } from "../../../shared/phase2";

export type Mood = Phase2Mood | "thinking" | "acting" | "error";

// Every mood the pet can display, kept exhaustive so the selfcheck can assert
// the colour/label maps below are total over the union. If a mood is added to
// Phase2Mood or the runtime states, this list (and the maps) must grow with it.
export const MOODS: Mood[] = [
  "idle",
  "focused",
  "curious",
  "excited",
  "analyzing",
  "assisting",
  "thinking",
  "acting",
  "error",
];

export const MOOD_COLOR: Record<Mood, string> = {
  idle: "#5df2ff",
  focused: "#83ffb0",
  curious: "#ffcf5a",
  excited: "#ff8a5d",
  analyzing: "#7aa7ff",
  assisting: "#ff7ab6",
  thinking: "#a985ff",
  acting: "#00ff88",
  error: "#ff4757",
};

export const MOOD_LABEL: Record<Mood, string> = {
  idle: "watching",
  focused: "focused",
  curious: "curious",
  excited: "active",
  analyzing: "analyzing",
  assisting: "assisting",
  thinking: "thinking...",
  acting: "working...",
  error: "attention",
};

// Live agent state (thinking/acting/error) overrides the slower personality
// mood so the pet reacts immediately to pipeline activity; otherwise it falls
// back to the personality engine's current mood, then to "idle".
export function moodFor(
  state: AgentRuntimeState | null,
  personality: PersonalityState | null,
): Mood {
  switch (state) {
    case "thinking":
      return "thinking";
    case "acting":
      return "acting";
    case "error":
      return "error";
    default:
      return personality?.mood ?? "idle";
  }
}
