// One-off: regenerate data/ownmodel/star-brain/Modelfile through the
// production buildModelfile() (FROM + tools-capable ChatML template), exactly
// as the next serveOwnModel() would write it.
import { writeFileSync } from "node:fs";
import { buildModelfile } from "../src/learning/ownModelClient.js";

const gguf = "C:/Users/allam/projects/star/data/ownmodel/star-brain/model.gguf";
const path = "C:/Users/allam/projects/star/data/ownmodel/star-brain/Modelfile";
writeFileSync(path, buildModelfile(gguf), "utf8");
console.log("wrote", path);
