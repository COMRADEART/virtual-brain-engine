# Neuroscience Integration Tests

This test suite validates the emergent properties and integration of the advanced brain simulation components.

## Test Overview
These tests verify that the upgraded system produces biologically plausible behaviors rather than testing individual modules in isolation. They simulate cognitive processes and measure whether the system behaves as neuroscience would predict.

## Test Scenarios

### 1. Attentional Blink Phenomenon
- **Neuroscience**: When humans rapidly process visual stimuli, a second target appearing 200-500ms after the first is often missed
- **Test**: Simulate sequential visual inputs and measure prefrontal response

### 2. Dopaminergic Reward Prediction
- **Neuroscience**: Dopamine neurons fire to unexpected rewards and cues predicting reward
- **Test**: Simulate reward feedback and measure VTA/NAc dopamine release

### 3. Memory Consolidation
- **Neuroscience**: Sleep facilitates memory transfer from hippocampus to neocortex
- **Test**: Simulate awake encoding + sleep consolidation and measure memory persistence

### 4. Theta-Gamma Coupling
- **Neuroscience**: Hippocampal theta (4-8Hz) couples with gamma (30-100Hz) during memory encoding
- **Test**: Measure cross-frequency coupling during memory-intensive tasks

### 5. Default Mode Network Activation
- **Neuroscience**: DMN activates during mind-wandering, deactivates during focused tasks
- **Test**: Simulate task switch and measure medial prefrontal/parietal activity

---