// Throwaway diagnostic: time the spiking engine construction + steps in Node,
// isolating the simulation from the browser/visual-effects layer.
import { generateNeuralGraph, getEstimatedNeuronCount } from "../src/engine/neuralGraphGenerator";
import { AdvancedBrainCore } from "../src/engine/AdvancedBrainCore";

const density = Number(process.argv[2] ?? 0.7);
console.log("density:", density, "estimated N:", getEstimatedNeuronCount(density));

let t = performance.now();
const graph = generateNeuralGraph({ density });
console.log(`graph built in ${(performance.now() - t).toFixed(1)}ms; nodes=${graph.nodes.length} pathways=${graph.pathways.length}`);

t = performance.now();
const sim = new AdvancedBrainCore(graph, "attentional-blink");
console.log(`engine constructed in ${(performance.now() - t).toFixed(1)}ms`);

const STEPS = 300;
t = performance.now();
for (let i = 0; i < STEPS; i++) sim.step(1 / 60, i / 60);
const dt = performance.now() - t;
console.log(`${STEPS} steps in ${dt.toFixed(1)}ms = ${(dt / STEPS).toFixed(3)}ms/step`);
console.log("DONE");
