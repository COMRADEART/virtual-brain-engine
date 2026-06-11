// One-off: measure the TRAIN_ENGLISH_MOSTLY filter's effect on the real corpus.
import { openDb } from "../src/db/sqlite.js";
import { exportMemoryCorpus } from "../src/db/repositories/memory.js";

openDb();
const all = exportMemoryCorpus();
const en = exportMemoryCorpus({ englishOnly: true });
console.log("full corpus:    ", all.documents, "docs,", all.chars, "chars");
console.log("english-mostly: ", en.documents, "docs,", en.chars, "chars");
console.log(
  "filtered out:   ",
  all.documents - en.documents,
  "docs,",
  all.chars - en.chars,
  "chars",
);
