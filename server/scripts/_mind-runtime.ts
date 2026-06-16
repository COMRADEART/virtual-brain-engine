// One-off runtime reader (NOT a gate step): print the LIVE mind-layer state from
// the real data/brain.sqlite after a /api/ask cycle. Proves the DNA actually
// evolved on a real cycle and the derived emotion + unified self compose from
// live data. Run: npm --prefix server exec tsx scripts/_mind-runtime.ts
import { getCognitiveDna } from "../src/core/cognitiveDna.js";
import { emotionStatus } from "../src/core/emotions.js";
import { gatherSkills } from "../src/core/skills.js";
import { getSelfRepresentation } from "../src/core/selfRepresentation.js";
import { currentStage, STAGE_NAMES } from "../src/core/stages.js";

const dna = getCognitiveDna().status();
const emo = emotionStatus();
const { self } = getSelfRepresentation();
const stage = currentStage();

console.log("── Cognitive DNA ──");
console.log(`  evolutionCount: ${dna.evolutionCount}`);
console.log(`  character: ${dna.character}`);
console.log(`  traits: ${JSON.stringify(dna.traits)}`);
const movedOffNeutral = (Object.values(dna.traits) as number[]).some((v) => Math.abs(v - 0.5) > 1e-6);
console.log(`  moved off neutral: ${movedOffNeutral}`);

console.log("── Emotions (dominant) ──");
console.log(`  ${emo.dominant.name} ${emo.dominant.value.toFixed(2)} | ${JSON.stringify(emo.emotions)}`);

console.log("── Skills ──");
console.log(`  count: ${gatherSkills(50).length}`);

console.log("── Developmental stage ──");
console.log(`  stage ${stage} (${STAGE_NAMES[stage - 1]})  [ladder now ${STAGE_NAMES.length} rungs]`);

console.log("── Unified self ──");
console.log(`  identity: ${self.identity}`);
console.log(`  doing:    ${self.doing}`);
console.log(`  becoming: ${self.becoming}`);

const ok = dna.evolutionCount > 0 && movedOffNeutral && STAGE_NAMES.length === 9;
console.log(`\nRESULT: ${ok ? "PASS — DNA evolved from live cycles; 9-stage ladder live" : "INCONCLUSIVE — no live evolution yet"}`);
