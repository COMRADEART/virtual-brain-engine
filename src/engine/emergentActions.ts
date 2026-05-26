// src/engine/emergentActions.ts
import { REGION_INDEX } from "./brainRegions";
import type { SignalSimulation } from "./signalSimulation";

// Neuroscientific BrainAction implementations demonstrating emergent behavior
// Each action models real neural phenomena with observable cognitive correlates

/**
 * AttentionalBlink: Limited neural resources produce ~200ms unresponsiveness
 * 
 * Neuroscience:
 * - Bottleneck in temporal attention (Raymond et al., 1992)
 * - P300 ERP component suppression (Vogel et al., 1998)
 * - LC-NE system modulates sensory processing (Aston-Jones & Cohen, 2005)
 * 
 * Behavioral correlate: Missing the second of two rapid visual stimuli
 * 
 * Visualization:
 * - Rapid sequential pulsing in occipital cortex
 * - Suppressed parietal activity during blink window
 * - Thalamic gating signals visualized as dark blue pulses
 */
export function initAttentionalBlink(sim: SignalSimulation, stimulusTiming: number = 0): void {
  
  // Simulate LC-NE system activation from brainstem
  const brainstemIdx = REGION_INDEX["brainstem"];
  if (brainstemIdx !== undefined) {
    sim.regionIntensity[brainstemIdx] = 0.9;
  }
  
  // Thalamic sensory gating signals
  sim.flashRegions(["thalamus-l", "thalamus-r"], 0.7);
  
  // Create occipital stimulus processing
  setTimeout(() => {
    sim.flashRegions(["occipital-l", "occipital-r"], 0.85);
  }, stimulusTiming);
  
  // Create parietal suppression during attentional blink window (~200-500ms)
  setTimeout(() => {
    sim.regionIntensity[REGION_INDEX["parietal-l"]!] *= 0.3;
    sim.regionIntensity[REGION_INDEX["parietal-r"]!] *= 0.3;
  }, stimulusTiming + 200);
}

/**
 * EurekaMoment: Sudden gamma burst reflects insight
 * 
 * Neuroscience:
 * - Gamma band synchronization (Jung-Beeman et al., 2004)
 * - Anterior cingulate cortex conflict detection (Kounios & Beeman, 2014)
 * - Hippocampal theta-gamma coupling (Lisman & Jensen, 2013)
 * - Dopaminergic reward signal from VTA (Saggar et al., 2018)
 * 
 * Behavioral correlate: Sudden problem-solving insight ("aha! moment")
 * 
 * Visualization:
 * - Gamma burst visualized as rapid purple pulses
 * - Hippocampal replay with golden pulses
 * - Dopaminergic green flashes in prefrontal cortex
 */
export function initEurekaMoment(sim: SignalSimulation, delay: number = 500): void {
  
  // Simulate gamma burst synchronization after delay
  setTimeout(() => {
    // Prefrontal-temporal synchronization
    sim.flashRegions([
      "prefrontal-l", "prefrontal-r", 
      "frontal-l", "frontal-r", 
      "temporal-l", "temporal-r"
    ], 0.95);
    
    // Hippocampal replay
    sim.flashRegions(["hippocampus-l", "hippocampus-r"], 0.8);
    
    // Dopaminergic reward signal
    const brainstemIdx = REGION_INDEX["brainstem"];
    if (brainstemIdx !== undefined) {
      sim.regionIntensity[brainstemIdx] = 0.85;
    }
  }, delay);
}

/**
 * FearConditioning: Amygdalar plasticity creates persistent response
 * 
 * Neuroscience:
 * - Amygdala lateral nucleus plasticity (LeDoux, 2000)
 * - Thalamic sensory bypass to amygdala (Shi & Davis, 2001)
 * - Hippocampal contextual modulation (Kim & Fanselow, 1992)
 * - Hypothalamic-pituitary-adrenal axis activation (Sapolsky, 2000)
 * 
 * Behavioral correlate: Persistent fear response to neutral stimuli after pairing
 * 
 * Visualization:
 * - Intense red pulsing in amygdala
 * - Rapid white pulses along thalamo-amygdalar pathway
 * - Hippocampal contextual pulsing in blue
 * - Brainstem HPA axis activation
 */
export function initFearConditioning(sim: SignalSimulation, conditionedStimulus: boolean = true): void {
  
  // Simulate thalamo-amygdalar fast pathway
  const thalamusL = REGION_INDEX["thalamus-l"];
  const amygdalaL = REGION_INDEX["amygdala-l"];
  const thalamusR = REGION_INDEX["thalamus-r"];
  const amygdalaR = REGION_INDEX["amygdala-r"];
  
  if (thalamusL !== undefined && amygdalaL !== undefined) {
    sim.regionIntensity[thalamusL] = 0.8;
    sim.regionIntensity[amygdalaL] = conditionedStimulus ? 0.95 : 0.6;
  }
  
  if (thalamusR !== undefined && amygdalaR !== undefined) {
    sim.regionIntensity[thalamusR] = 0.8;
    sim.regionIntensity[amygdalaR] = conditionedStimulus ? 0.95 : 0.6;
  }
  
  // Hippocampal contextual input
  sim.flashRegions(["hippocampus-l", "hippocampus-r"], 0.6);
  
  // Brainstem HPA axis activation
  const brainstemIdx = REGION_INDEX["brainstem"];
  if (brainstemIdx !== undefined) {
    sim.regionIntensity[brainstemIdx] = 0.75;
  }
}

/**
 * MemoryReconsolidation: Strong reactivation enables modification
 * 
 * Neuroscience:
 * - Synaptic tagging and capture (Frey & Morris, 1997)
 * - NMDA receptor dependence (Nader et al., 2000)
 * - Hippocampal-neocortical dialogue (McClelland et al., 1995)
 * - Protein synthesis requirement (Dudai & Eisenberg, 2004)
 * 
 * Behavioral correlate: Updated memories after reactivation
 * 
 * Visualization:
 * - Golden hippocampal replay pulses
 * - Green neocortical storage pulses
 * - NMDA receptor simulation as blue bursts
 * - Protein synthesis visualization as sustained glow
 */
export function initMemoryReconsolidation(sim: SignalSimulation): void {
  
  // Hippocampal replay
  sim.flashRegions(["hippocampus-l", "hippocampus-r"], 0.85);
  
  // Neocortical storage (delayed)
  setTimeout(() => {
    sim.flashRegions([
      "frontal-l", "frontal-r", 
      "temporal-l", "temporal-r",
      "parietal-l", "parietal-r"
    ], 0.7);
  }, 800);
}

/**
 * DecisionHesitation: Prefrontal conflict monitoring
 * 
 * Neuroscience:
 * - Anterior cingulate cortex conflict detection (Carter et al., 1998)
 * - Basal ganglia competition (Mink, 1996)
 * - Dopaminergic uncertainty signaling (Fiorillo et al., 2003)
 * - Alpha band desynchronization (Pfurtscheller & Lopes da Silva, 1999)
 * 
 * Behavioral correlate: Increased reaction time during conflict
 * 
 * Visualization:
 * - Yellow ACC pulsing in midline frontal areas
 * - Blue/red competing basal ganglia pathways
 * - Dopaminergic green uncertainty pulses
 * - Alpha desynchronization as diffuse network activation
 */
export function initDecisionHesitation(sim: SignalSimulation): void {
  
  // Simulate competing basal ganglia pathways
  sim.flashRegions(["basal-ganglia-l", "basal-ganglia-r"], 0.8);
  
  // Anterior cingulate conflict monitoring
  setTimeout(() => {
    sim.flashRegions(["frontal-l", "frontal-r"], 0.7);
  }, 300);
}

/**
 * SensoryGating: Thalamic filtering of irrelevant input
 * 
 * Neuroscience:
 * - Thalamic reticular nucleus inhibition (McCormick & Bal, 1994)
 * - Cholinergic modulation (Sarter et al., 2005)
 * - Alpha oscillation gating (Jensen & Mazaheri, 2010)
 * - Sensory habituation (Thompson & Spencer, 1966)
 * 
 * Behavioral correlate: Reduced response to repeated irrelevant stimuli
 * 
 * Visualization:
 * - Blue inhibitory pulses in thalamic reticular nucleus
 * - Cholinergic green bursts in basal forebrain
 * - Alpha oscillation as rhythmic pulsing
 * - Habituated pathways shown as reduced intensity
 */
export function initSensoryGating(sim: SignalSimulation, stimulusCount: number = 3): void {
  
  // Simulate thalamic reticular nucleus inhibition
  sim.flashRegions(["thalamus-l", "thalamus-r"], 0.6);
  
  // Top-down frontal control
  setTimeout(() => {
    sim.flashRegions(["frontal-l", "frontal-r"], 0.5);
  }, 200);
  
  // Simulate habituation with successive stimuli
  for (let i = 0; i < stimulusCount; i++) {
    setTimeout(() => {
      const intensity = 0.7 * Math.pow(0.5, i); // Exponential decay
      sim.flashRegions([
        "auditory-l", "auditory-r", 
        "somatosensory-l", "somatosensory-r"
      ], intensity);
    }, 400 + i * 300);
  }
}

/**
 * SleepRipple: Coordinated hippocampal-neocortical replay
 * 
 * Neuroscience:
 * - Sharp wave-ripple complexes (Buzsáki, 1986)
 * - Memory consolidation during sleep (Wilson & McNaughton, 1994)
 * - Neocortical slow oscillations (Steriade et al., 1993)
 * - Sleep spindle coupling (Siapas & Wilson, 1998)
 * 
 * Behavioral correlate: Memory consolidation during sleep
 * 
 * Visualization:
 * - Golden hippocampal ripple pulses
 * - Silver neocortical slow oscillation pulses
 * - Purple spindle bursts
 * - Coordinated timing between regions
 */
export function initSleepRipple(sim: SignalSimulation, rippleCount: number = 5): void {
  
  // Simulate coordinated ripple events
  for (let i = 0; i < rippleCount; i++) {
    setTimeout(() => {
      // Hippocampal sharp wave-ripples
      const hippoL = REGION_INDEX["hippocampus-l"];
      const hippoR = REGION_INDEX["hippocampus-r"];
      if (hippoL !== undefined) sim.regionIntensity[hippoL] = 0.9;
      if (hippoR !== undefined) sim.regionIntensity[hippoR] = 0.9;
      
      // Neocortical slow oscillations
      setTimeout(() => {
        sim.flashRegions([
          "frontal-l", "frontal-r", 
          "temporal-l", "temporal-r"
        ], 0.6);
      }, 100);
      
      // Thalamic spindles
      setTimeout(() => {
        sim.flashRegions(["thalamus-l", "thalamus-r"], 0.7);
      }, 300);
    }, i * 800);
  }
}

/**
 * Utility function to initialize all emergent actions
 */
export function initAllEmergentActions(sim: SignalSimulation): void {
  // Set default action to show emergent behavior possibilities
  sim.setAction("attentional-blink");
  initAttentionalBlink(sim);
}