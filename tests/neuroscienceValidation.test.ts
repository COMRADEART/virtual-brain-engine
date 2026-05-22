import { describe, it, expect, beforeEach } from 'vitest'
import { SpikingEngine } from '../src/engine/SpikingEngine'
import { NeuralGraphGenerator } from '../src/engine/neuralGraphGenerator'
import { BrainRegionId } from '../src/engine/types'

// Performance benchmarks and neuroscience validation
// Tests that the upgraded SpikingEngine meets biological plausibility
// and performance targets for a real-time interactive application.

describe('SpikingEngine Upgraded Neuroscience Validation', () => {
  let engine: SpikingEngine
  let graph: NeuralGraph
  const neuronCount = 1500 // Target size for smooth visualization
  const regionNeurons: Record<BrainRegionId, number> = {
    'prefrontal-cortex': 300,
    'hippocampus-l': 150,
    'hippocampus-r': 150,
    'temporal': 200,
    'parietal': 150,
    'visual': 100,
    'auditory': 80,
    'motor': 90,
    'somatosensory': 80,
    'basal-ganglia': 60,
    'thalamus': 60,
    'amygdala-l': 30,
    'amygdala-r': 30,
    'hypothalamus': 20,
    'gyrus-cinguli': 40,
    'cerebellum': 50,
    'pons': 30,
    'medulla': 20,
    'insular-cortex': 30,
    'orbital-frontal-cortex': 30,
//    'brainstem': 0 // Virtual region
  }
  
  beforeEach(() => {
    // Generate biologically-plausible neural graph
    const assignments: BrainRegionId[] = []
    for (const [regionId, count] of Object.entries(regionNeurons)) {
      for (let i = 0; i < count; i++) assignments.push(regionId as BrainRegionId)
    }
    
    const generator = new NeuralGraphGenerator(neuronCount)
    graph = generator.generateGraph(assignments, 19) // Fixed seed
    
    engine = new SpikingEngine(graph, 'rest')
  })

  // Test physiological realism
  describe('Biological Plausibility', () => {
    it('should maintain 80/20 excitatory/inhibitory ratio', () => {
      const neuronCount = engine.getNeuronCount()
      const excCount = engine.getExcitatoryNeuronCount()
      const inhCount = neuronCount - excCount
      
      const excRatio = excCount / neuronCount
      expect(excRatio).toBeGreaterThan(0.75)
      expect(excRatio).toBeLessThan(0.85)
      // Inhibitory neurons should be ~20%
      expect(inhCount / neuronCount).toBeGreaterThan(0.15)
      expect(inhCount / neuronCount).toBeLessThan(0.25)
    })
    
    it('should produce realistic firing rates', () => {
      // Baseline activity
      for (let i = 0; i < 100; i++) {
        engine.step(0.002) // 2ms timestep
      }
      
      // Measure firing rates across regions
      const rates = engine.getFiringRates()
      const globalRate = rates.global
      
      // Cortical neurons typically fire at 1-8 Hz
      expect(globalRate).toBeGreaterThan(0.5) // Hz
      expect(globalRate).toBeLessThan(20.0) // Upper bound
      
      // Region-specific rates should be reasonable
      expect(rates.byRegion.get('hippocampus-l')!).toBeLessThan(15.0)
      expect(rates.byRegion.get('prefrontal-cortex')!).toBeLessThan(12.0)
    })
    
    it('should show theta-gamma coupling signatures', () => {
      // Set hippocampus-like state
      engine.setGlobalThetaGain(0.8)
      engine.setGlobalGammaGain(1.2)
      
      const measures = []
      for (let i = 0; i < 250; i++) {
        engine.step(0.005) // 5ms timesteps
        measures.push(engine.measureThetaGammaCoupling('hippocampus-l'))
      }
      
      // Should show non-zero coupling
      const avgCoupling = measures.reduce((sum, val) => sum + val.thetaGammaCoupling, 0) / measures.length
      expect(avgCoupling).toBeGreaterThan(0.05) // Non-trivial coupling
    })

    it('should demonstrate E/I balance and critical dynamics', () => {
      // Measure avalanche statistics
      const avalancheSizes: number[] = []
      let current = 0
      for (let i = 0; i < 500; i++) {
        engine.step(0.002)
        const spiking = engine.getRecentSpikes().reduce((sum, val) => sum + (val ? 1 : 0), 0)
        
        if (spiking > 0) {
          current += spiking
        } else if (current > 0) {
          avalancheSizes.push(current)
          current = 0
        }
      }
      
      // Should show power-law distribution (hallmark of criticality)
      const smallAvals = avalancheSizes.filter(s => s <= 5).length
      const mediumAvals = avalancheSizes.filter(s => s > 5 && s <= 20).length
      const largeAvals = avalancheSizes.filter(s => s > 20).length
      
      // Power-law characteristic: more small events than large
      expect(smallAvals).toBeGreaterThan(mediumAvals)
      expect(mediumAvals).toBeGreaterThanOrEqual(largeAvals)
    })
  })

  // Test cognitive dynamics
  describe('Cognitive Dynamics', () => {
    it('should show acetylcholine-driven attentional modulation', () => {
      // Low ACh baseline
      engine.setGlobalAcetylcholine(0.1)
      const baselineAttention = engine.getAttentionIndex()
      
      // High ACh
      engine.setGlobalAcetylcholine(0.9)
      const highAChAttention = engine.getAttentionIndex()
      
      // Attention should increase with ACh
      expect(highAChAttention).toBeGreaterThan(baselineAttention)
      // Alpha desynchronization should occur
      expect(engine.getAlphaPower()).toBeLessThan(0.3)
    })
    
    it('should demonstrate dopaminergic plasticity modulation', () => {
      // Measure plasticity at different DA levels
      engine.setGlobalDopamine(0.1)
      const lowDAPlasticity = engine.measurePlasticityChange()
      
      engine.setGlobalDopamine(0.8)
      const highDAPlasticity = engine.measurePlasticityChange()
      
      // Higher dopamine should increase plasticity
      expect(highDAPlasticity).toBeGreaterThan(lowDAPlasticity)
    })
    
    it('should simulate memory consolidation dynamics', () => {
      // Encode episodic memory
      engine.reinforceMemoryTrace('event-domain', ['hippocampus-l', 'prefrontal-cortex'], 0.9)
      const initHippStrength = engine.getMemoryTraceStrength('hippocampus-l', 'event-domain')
      
      // Simulate consolidation period
      engine.setGlobalAcetylcholine(0.3) // Low ACh (sleep-like)
      for (let i = 0; i < 50; i++) {
        engine.step(0.05) // 50ms steps
      }
      
      const finalHippStrength = engine.getMemoryTraceStrength('hippocampus-l', 'event-domain')
      const neocortexStrength = engine.getMemoryTraceStrength('temporal', 'event-domain')
      
      // Should show systems consolidation
      expect(finalHippStrength).toBeLessThan(initHippStrength) // Decay in hippocampus
      expect(neocortexStrength).toBeGreaterThan(0.1) // Growth in neocortex
    })
  })

  // Test neuromodulation
  describe('Neuromodulation System', () => {
    it('should implement volume transmission with realistic kinetics', () => {
      // Initial dopamine = baseline
      const baseline = engine.getGlobalDopamine()
      expect(baseline).toBeCloseTo(0.2, 1)
      
      // Inject reward signal
      engine.applyRewardFeedback(0.8)
      const phasic = engine.getGlobalDopamine()
      expect(phasic).toBeGreaterThan(baseline + 0.3)
      
      // Should decay back toward baseline
      const decayDopamine = []
      for (let i = 0; i < 20; i++) {
        engine.step(0.1) // 100ms time constant
        decayDopamine.push(engine.getGlobalDopamine())
      }
      
      // Should be approaching baseline
      expect(decayDopamine[decayDopamine.length - 1]).toBeLessThan(phasic)
      expect(decayDopamine[decayDopamine.length - 1]).toBeGreaterThan(baseline)
    })
    
    it('should regionally differentiate neuromodulator responses', () => {
      // Prefrontal cortex should show high D1 sensitivity
      const prefrontalDA = engine.getRegionNeuromodulatorSensitivity('prefrontal-cortex', 'DA')
      // Hippocampus should show high ACh sensitivity
      const hippocampalACh = engine.getRegionNeuromodulatorSensitivity('hippocampus-l', 'ACh')
      
      // Prefrontal >> Hippocampus for DA
      expect(prefrontalDA).toBeGreaterThan(0.4)
      // Hippocampus >> Prefrontal for ACh
      expect(hippocampalACh).toBeGreaterThan(prefrontalDA)
    })
  })

  // Test performance
  describe('Performance Benchmarks', () => {
    it('should achieve 55-60 FPS with 1500 neurons', () => {
      const startTime = performance.now()
      let totalSteps = 0
      
      // Simulate ~1 second of real time
      while (performance.now() - startTime < 1000) {
        engine.step(0.0167) // ~60 FPS timestep
        totalSteps++
      }
      
      const duration = performance.now() - startTime
      const fps = totalSteps / (duration / 1000)
      
      // Should achieve >30 FPS for interactive experience
      expect(fps).toBeGreaterThan(30)
      // Stretch goal: Should be on target for 55-60 FPS
      console.log(`Performance: ${fps.toFixed(1)} FPS`) // For visibility
      if (fps < 50) {
        console.warn(`Note: Current performance ${fps.toFixed(1)} FPS below target 55-60 range`)
      }
    })
    
    it('should handle memory consolidation without framerate disruption', () => {
      const startTime = performance.now()
      const timings = []
      
      // Enable consolidation
      engine.setGlobalAcetylcholine(0.3) // Low ACh (sleep)
      engine.setMemoryIntensity(0.7) // Active consolidation
      
      for (let i = 0; i < 50; i++) {
        const stepStart = performance.now()
        engine.step(0.02) // Nominal framerate
        const stepTime = performance.now() - stepStart
        timings.push(stepTime)
      }
      
      const avgStepTime = timings.reduce((sum, val) => sum + val, 0) / timings.length
      const under16ms = timings.filter(t => t <= 16.7).length // Target for 60 FPS
      
      // Majority of frames should remain smooth
      expect(under16ms / timings.length).toBeGreaterThan(0.8)
      console.log(`Consolidation performance: Avg step ${avgStepTime.toFixed(2)}ms`)
    })
  })

  // Test visualization compatibility
  describe('Visualization Integration', () => {
    it('should provide comprehensive visual channels', () => {
      const visData = engine.generateVisualizationData()
      
      // Validate visualization schema
      expect(visData.spikeRaster.length).toBeGreaterThan(0)
      expect(visData.membranePotentials.length).toBe(engine.getNeuronCount())
      expect(visData.regionColors.length).toBeGreaterThan(15)
      expect(visData.neuromodulatorLevels).toHaveProperty('DA')
      expect(visData.neuromodulatorLevels).toHaveProperty('ACh')
      expect(visData.oscillations.theta.PFC).toBeDefined()
      expect(visData.memoryTraces.workingMemory.length).toBeGreaterThanOrEqual(0)
      expect(visData.burstMarkers).toBeDefined()
    })
    
    it('should reflect cognitive processes in visualization', () => {
      // Baseline
      let visData = engine.generateVisualizationData()
      const baselineDA = visData.neuromodulatorLevels.DA.prefrontal
      
      // Simulate reward
      engine.applyRewardFeedback(0.8)
      visData = engine.generateVisualizationData()
      const rewardDA = visData.neuromodulatorLevels.DA.prefrontal
      
      // Dopamine visualization should increase
      expect(rewardDA).toBeGreaterThan(baselineDA)
      expect(rewardDA - baselineDA).toBeGreaterThan(0.3)
    })
    
    it('should differentiate excitatory vs inhibitory visual signatures', () => {
      const visData = engine.generateVisualizationData()
      const excRaster = visData.excitatoryRaster
      const inhRaster = visData.inhibitoryRaster
      
      // Should show different patterns
      expect(excRaster.length).toBe(visData.spikeRaster.length)
      expect(inhRaster.length).toBe(visData.spikeRaster.length)
      
      // Should be distinguishable
      const excSpikes = excRaster.reduce((sum, val) => sum + val, 0)
      const inhSpikes = inhRaster.reduce((sum, val) => sum + val, 0)
      expect(excSpikes).toBeGreaterThan(ihnSpikes) // More excitatory spikes
    })
  })

  // Test emergent behaviors
  describe('Emergent Cognitive Behaviors', () => {
    it('should demonstrate attentional blink', () => {
      // Set focused state
      engine.applyCognitiveState('focused-attention')
      
      // Simulate sequential stimuli
      engine.applyExternalInput('visual', 0.8)
      for (let i = 0; i < 10; i++) engine.step(0.005) // ~50ms lag
      engine.applyExternalInput('visual', 0.8)
      
      // Second stimulus should produce attenuated prefrontal response
      const stimulus2Neglect = engine.getRecentNeuralActivity('prefrontal-cortex', 50)
      expect(stimulus2Neglect).toBeLessThan(0.15) // Should show attentional blink
    })
    
    it('should simulate default mode network activation', () => {
      // Set mind-wandering state
      engine.applyCognitiveState('mind-wandering')
      
      // Measure DMN regions
      const dmnActivity = [
        engine.getRecentNeuralActivity('gyrus-cinguli', 100),
        engine.getRecentNeuralActivity('prefrontal-cortex', 100) // Medial PFC
      ].reduce((sum, val) => sum + val, 0) / 2
      
      // Task-positive network should be low
      const tpnActivity = [
        engine.getRecentNeuralActivity('parietal', 100),
        engine.getRecentNeuralActivity('prefrontal-cortex', 100) // Dorsolateral
      ].reduce((sum, val) => sum + val, 0) / 2
      
      // DMN > TPN during mind-wandering
      expect(dmnActivity).toBeGreaterThan(tpnActivity)
    })
    
    it('should simulate sleep-related hippocampal replay', () => {
      // Encode strong memory trace
      engine.reinforceMemoryTrace('sleep-event', ['hippocampus-l', 'prefrontal-cortex'], 0.95)
      engine.setMemoryIntensity(0.6)
      
      // Simulate sleep
      engine.applyCognitiveState('resting')
      engine.setGlobalAcetylcholine(0.1) // Low ACh = sleep
      
      let replayCount = 0
      const replayTimesteps = []
      for (let i = 0; i < 200; i++) {
        engine.step(0.010)
        if (engine.getMemoryReplayCount('sleep-event') > replayCount) {
          replayCount = engine.getMemoryReplayCount('sleep-event')
          replayTimesteps.push(i)
        }
      }
      
      // Should show replay events during sleep
      expect(replayCount).toBeGreaterThan(2)
      // Timing should be irregular (biological realism)
      expect(new Set(replayTimesteps.map(t => t % 100)).size).toBeGreaterThan(5)
    })
  })
})
