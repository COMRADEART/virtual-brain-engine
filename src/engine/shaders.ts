import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
export const NEURON_VERT = /* glsl */ `
attribute float membraneNorm;
attribute float neuronType;       // 1=excitatory, -1=inhibitory
attribute float burstStatus;     // 0=normal, 1=bursting
attribute float memoryTrace;     // 0-1 memory engagement
// Phase 4 (improvement plan §1B): per-instance visibility/LOD multiplier.
// Default 1.0 if absent — written by NeuralGraphRenderer.updateAScaleLOD.
attribute float aScale;
varying float vMembraneNorm;
varying float vNeuronType;
varying float vBurstStatus;
varying float vMemoryTrace;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vMembraneNorm = membraneNorm;
  vNeuronType = neuronType;
  vBurstStatus = burstStatus;
  vMemoryTrace = memoryTrace;
  vNormal = normalMatrix * normal;

  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position * aScale, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Neuron fragment shader — Enhanced with:
// - Excitatory/Inhibitory color coding
// - Bursting neuron highlighting
// - Memory trace glow
// - Neuromodulator tints
// - Oscillation coupling
// ─────────────────────────────────────────────────────────────────────────────
export const NEURON_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGlobalActivity;
uniform float uOscillationPhase; // theta phase 0..2π
uniform float uGammaPhase;     // gamma phase 0..2π
uniform float uDopamine;        // 0..1 dopamine level
uniform float uAcetylcholine;   // 0..1 acetylcholine level
uniform float uSerotonin;       // 0..1 serotonin level
uniform float uNorepinephrine;  // 0..1 norepinephrine level
varying float vMembraneNorm;
varying float vNeuronType;      // 1=excitatory, -1=inhibitory
varying float vBurstStatus;    // 0=normal, 1=bursting
varying float vMemoryTrace;     // 0-1 memory engagement
varying vec3 vNormal;
varying vec3 vViewPosition;

// Membrane potential color mapping
vec3 membraneColour(float m) {
  // Four-stop gradient: polarised → resting → active → firing
  vec3 c0 = vec3(0.08, 0.01, 0.38); // deep indigo — V=-75 mV (reset)
  vec3 c1 = vec3(0.05, 0.35, 0.72); // deep blue — V=-70 mV (rest)
  vec3 c2 = vec3(0.00, 0.85, 0.75); // electric cyan — V=-60 mV (threshold)
  vec3 c3 = vec3(1.00, 0.95, 0.20); // yellow-white — V≥-52 mV (firing)

  vec3 col;
  if (m < 0.33) {
    col = mix(c0, c1, m / 0.33);
  } else if (m < 0.66) {
    col = mix(c1, c2, (m - 0.33) / 0.33);
  } else {
    col = mix(c2, c3, (m - 0.66) / 0.34);
  }
  return col;
}

// Neuron type color coding
vec3 getNeuronTypeColor() {
  // Excitatory neurons: warmer colors
  // Inhibitory neurons: cooler colors
  return vNeuronType > 0.0 ? vec3(0.95, 0.4, 0.2) : vec3(0.2, 0.6, 0.95);
}

// Neuromodulator tinting
vec3 getNeuromodulatorTint() {
  // Dopamine: orange-red glow (reward/salience)
  vec3 daTint = vec3(0.2, 0.08, 0.0) * uDopamine;
  
  // Acetylcholine: blue-white glow (attention)
  vec3 achTint = vec3(0.0, 0.1, 0.12) * uAcetylcholine;
  
  // Serotonin: purple aura (mood/regulation)
  vec3 serotoninTint = vec3(0.12, 0.0, 0.18) * uSerotonin;
  
  // Norepinephrine: green sparkle (arousal/alertness)
  vec3 neTint = vec3(0.0, 0.15, 0.05) * uNorepinephrine;
  
  return daTint + achTint + serotoninTint + neTint;
}

void main() {
  float m = vMembraneNorm;
  
  // Base membrane potential color
  vec3 baseCol = membraneColour(m);
  
  // Apply neuron type color modulation
  vec3 neuronTypeCol = getNeuronTypeColor();
  baseCol = mix(baseCol, baseCol * neuronTypeCol, 0.6);
  
  // Fresnel rim glow — cells depolarise near the viewer
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vViewPosition);
  float rim = 1.0 - max(dot(n, v), 0.0);
  rim = pow(rim, 2.2);

  // Theta-gamma coupling visualization
  float thetaBreath = sin(uOscillationPhase) * 0.08 + 1.0;
  float gammaRipple = sin(uGammaPhase * 8.0) * 0.03 * (1.0 + uGlobalActivity * 0.5);
  
  // Bursting neuron effect (very bright)
  float burst = vBurstStatus > 0.5 ? 1.0 : 0.0;
  vec3 burstCol = vec3(1.0, 0.8, 0.2) * burst * 2.5;
  
  // Memory trace glow (hippocampal replay)
  vec3 memoryGlow = vec3(0.8, 0.2, 1.0) * vMemoryTrace * 0.7;
  
  // Apply neuromodulator tints
  vec3 neuromodTint = getNeuromodulatorTint();
  
  // Global activity pulse
  float globalPulse = uGlobalActivity * 0.2 * thetaBreath;
  
  // Combine all effects
  vec3 finalCol = baseCol * (1.0 + rim * 0.5 + globalPulse + gammaRipple) 
                + burstCol 
                + memoryGlow 
                + neuromodTint;
  
  // Enhanced transparency with bursting and memory effects
  float alpha = 0.4 + rim * 0.4 + m * 0.3 + burst * 0.6 + vMemoryTrace * 0.5;
  
  gl_FragColor = vec4(finalCol, clamp(alpha, 0.0, 1.0));
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Pathway vertex shader — per-vertex activity for colour interpolation.
// We also pass world position so the fragment can compute distance-based fade.
// ─────────────────────────────────────────────────────────────────────────────
export const PATHWAY_VERT = /* glsl */ `
attribute float activity;
varying float vActivity;
varying float vPathwayY;

void main() {
  vActivity = activity;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vPathwayY = mvPos.y;
  gl_Position = projectionMatrix * mvPos;
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Pathway fragment shader — activity-modulated colour + thickness
// impression via alpha profile, with exponential distance fade.
// ─────────────────────────────────────────────────────────────────────────────
export const PATHWAY_FRAG = /* glsl */ `
uniform float uTime;
uniform float uBaseOpacity;
varying float vActivity;
varying float vPathwayY;

vec3 pathwayColour(float act, float y) {
  // Activity shifts hue from deep-blue (low) toward hot-white (high)
  vec3 low = vec3(0.15, 0.45, 0.8);
  vec3 mid = vec3(0.0,  0.9,  0.75);
  vec3 hi  = vec3(1.0,  1.0,  0.25);

  vec3 col;
  if (act < 0.5) {
    col = mix(low, mid, act * 2.0);
  } else {
    col = mix(mid, hi, (act - 0.5) * 2.0);
  }

  // Subtle y-axis shimmer (simulates travelling wave along axon)
  float shimmer = sin(y * 12.0 - uTime * 3.5) * 0.08 * act;
  return col + shimmer;
}

void main() {
  float act = vActivity;
  float alpha = uBaseOpacity * (0.08 + act * 0.92);
  // Thinner-looking than the original line but brighter per-pixel
  gl_FragColor = vec4(pathwayColour(act, vPathwayY), alpha);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Pulse trail vertex/fragment — faint afterimage following each pulse.
// ─────────────────────────────────────────────────────────────────────────────
export const TRAIL_VERT = /* glsl */ `
attribute float progress;
attribute float intensity;
attribute float pulseType; // 0=regular, 1=memory, 2=inhibitory
varying float vProgress;
varying float vIntensity;
varying float vPulseType;

void main() {
  vProgress = progress;
  vIntensity = intensity;
  vPulseType = pulseType;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const TRAIL_FRAG = /* glsl */ `
varying float vProgress;
varying float vIntensity;
varying float vPulseType;

void main() {
  // Fade: bright at head (t≈1), invisible at tail (t≈0)
  float fade = pow(vProgress, 0.6) * vIntensity;
  
  // Color based on pulse type
  vec3 col;
  if (vPulseType < 0.5) {
    // Regular excitatory pulse - blue-white
    col = vec3(0.5, 0.95, 1.0);
  } else if (vPulseType < 1.5) {
    // Memory replay trail - purple
    col = vec3(0.9, 0.4, 1.0);
  } else {
    // Inhibitory pulse - red
    col = vec3(1.0, 0.3, 0.2);
  }
  
  col *= fade;
  gl_FragColor = vec4(col, fade * 0.65);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Region volume breathing — oscillation-driven pulsation on region shells.
// Uses the same sphere-geometry approach as NeuralGraph's region volumes.
// ─────────────────────────────────────────────────────────────────────────────
export const REGION_BREATHE_VERT = /* glsl */ `
uniform float uTime;
uniform float uThetaPhase;
uniform float uGammaPhase;
uniform float uThetaGain;
uniform float uGammaGain;
uniform float uRegionRadius;

varying vec3 vNormal;
varying vec2 vUv;

void main() {
  vNormal = normalMatrix * normal;
  vUv = uv;

  // Layered oscillation: large slow theta breath + smaller fast gamma ripple
  float breath =
    sin(uThetaPhase) * uThetaGain * 0.035 +
    sin(uGammaPhase * 2.0) * uGammaGain * 0.012;

  vec3 pos = position * (1.0 + breath);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

export const REGION_BREATHE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uThetaPhase;
uniform float uGammaPhase;
uniform float uThetaGain;
uniform float uGammaGain;
uniform float uIntensity;
uniform vec3  uRegionColor;

varying vec3 vNormal;
varying vec2 vUv;

void main() {
  // Fresnel for X-ray look
  vec3 n = normalize(vNormal);
  float fresnel = pow(1.0 - abs(dot(n, vec3(0.0, 0.0, 1.0))), 2.5);

  // Colour shifts with theta: cooler at trough, warmer at peak
  float thetaShift = sin(uThetaPhase) * 0.5 + 0.5;
  vec3 cool = uRegionColor * 0.4;
  vec3 warm = uRegionColor + vec3(0.15, 0.1, -0.05);
  vec3 base = mix(cool, warm, thetaShift);

  // Gamma adds micro-shimmer
  float shimmer = sin(uGammaPhase * 8.0) * 0.05 * uGammaGain;

  float alpha = fresnel * (0.12 + uIntensity * 0.35) * uThetaGain;
  gl_FragColor = vec4(base * (1.0 + shimmer) * (1.0 + fresnel * 0.5), clamp(alpha, 0.0, 0.8));
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Neurotransmitter particle burst.
// Each particle is a billboarded quad. Fragment computes radial soft sprite.
// ─────────────────────────────────────────────────────────────────────────────
export const NT_VERT = /* glsl */ `
attribute float size;
attribute float life;    // 0..1  — 1=just born, 0=dead
attribute float type;    // 0=glutamate, 1=GABA, 2=dopamine, 3=acetylcholine
attribute vec3  velocity;

uniform float uTime;
uniform float uPixelsPerUnit;

varying float vLife;
varying float vType;
varying float vFresnel;

void main() {
  vLife = life;
  vType = type;

  // Drift upward with slight spread
  vec3 pos = position + velocity * (1.0 - life) * 0.4;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float dist = length(mvPos.xyz);
  gl_Position = projectionMatrix * mvPos;

  // Size decays as particle ages, attenuated by distance
  float sz = size * life * uPixelsPerUnit / max(dist * 0.5, 1.0);
  gl_PointSize = max(sz, 1.0);
}
`;

export const NT_FRAG = /* glsl */ `
varying float vLife;
varying float vType;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;

  // Soft radial falloff
  float sprite = 1.0 - smoothstep(0.15, 0.5, d);

  // Neurotransmitter colour by type
  vec3 colGaba   = vec3(0.65, 0.20, 1.00); // purple — GABA
  vec3 colDA     = vec3(1.00, 0.55, 0.10); // amber  — dopamine
  vec3 colACh    = vec3(0.05, 0.85, 0.45); // teal   — acetylcholine
  vec3 colGlut   = vec3(0.90, 0.95, 0.30); // lime   — glutamate (default)

  vec3 col;
  if      (vType < 0.5) col = colGlut;
  else if (vType < 1.5) col = colGaba;
  else if (vType < 2.5) col = colDA;
  else                  col = colACh;

  float alpha = sprite * vLife * 0.85;
  gl_FragColor = vec4(col * (1.0 + sprite * 0.4), alpha);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: EEG / LFP waveform — rendered as a line-strip plane in 3D.
// Reads a sample buffer attribute encoding the waveform.
// ─────────────────────────────────────────────────────────────────────────────
export const EEG_VERT = /* glsl */ `
attribute float sample;
uniform float uWidth;
uniform float uAmplitude;

varying float vSample;
varying float vX;

void main() {
  vSample = sample;
  vX = position.x / uWidth * 2.0 - 1.0;

  vec3 pos = position;
  pos.y = sample * uAmplitude;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

export const EEG_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform vec3  uColour;

varying float vSample;
varying float vX;

void main() {
  // Centre line more opaque; edges fade
  float edgeFade = 1.0 - abs(vX);
  float lineGlow = 0.5 + abs(vSample) * 1.5;

  vec3 col = uColour * lineGlow;
  float alpha = uAlpha * edgeFade * 0.8;

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Neuromodulator global tint — full-screen post-process colour grade.
// Injects color biases for dopamine, acetylcholine, serotonin, and norepinephrine.
// ─────────────────────────────────────────────────────────────────────────────
export const NEUROMOD_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uDopamine: { value: 0.3 },
    uAcetylcholine: { value: 0.4 },
    uSerotonin: { value: 0.2 },
    uNorepinephrine: { value: 0.1 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uDopamine;
    uniform float uAcetylcholine;
    uniform float uSerotonin;
    uniform float uNorepinephrine;
    uniform float uTime;
    varying vec2 vUv;

    // GLSL has no function hoisting — rand() MUST be defined before main() uses
    // it. It used to live after main(), which fails to compile; because this is a
    // full-screen post-process pass in the composer chain, an invalid program
    // blacked out the entire spiking-engine render (verify:canvas: activePixels 0,
    // "useProgram: program not valid"). Keep this above main().
    float rand(vec2 co) {
      return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float luminance = dot(col.rgb, vec3(0.299, 0.587, 0.114));

      // Dopamine: orange-red glow (reward, motivation, salience)
    // Creates a warm, engaging visual cue in prefrontal cortex
    vec3 daTint = vec3(0.22, 0.07, 0.0) * uDopamine;
    
    // Acetylcholine: blue-white glow (attention, learning)
    // Sharpens focus with a cool, clear tint in sensory and temporal regions
    vec3 achTint = vec3(0.0, 0.14, 0.2) * uAcetylcholine;
    
    // Serotonin: purple aura (mood regulation, memory consolidation)
    // Creates a calming, cohesive visual field especially in hippocampus
    vec3 serotoninTint = vec3(0.16, 0.02, 0.16) * uSerotonin;
    
    // Norepinephrine: green sparkle (arousal, alertness)
    // Sharp, dynamic visualization particularly in thalamus and brainstem
    vec3 neTint = vec3(0.05, 0.15, 0.08) * uNorepinephrine;
      
      // Subtle time-based shimmer to make the tint feel alive
      float shimmer = sin(uTime * 0.4 + vUv.x * 10.0) * 0.01;
      vec3 tint = daTint + achTint + serotoninTint + neTint + shimmer;
      
      // Apply regionally-based neuromodulator effects
      // Frontal cortex: more dopamine sensitivity
      float frontalMask = smoothstep(0.2, 0.6, vUv.y);
      // Temporal lobe: more acetylcholine
      float temporalMask = smoothstep(0.4, 0.8, abs(vUv.x - 0.5));
      // Hippocampal area: more serotonin
      float hippoMask = smoothstep(0.3, 0.7, distance(vUv, vec2(0.3, 0.5)));
      
      // Blend based on screen-space location
      vec3 regionalTint = 
        daTint * frontalMask * 1.5 +
        achTint * temporalMask * 1.5 +
        serotoninTint * hippoMask * 1.5;
      
      // Final color calculation
      vec3 result = col.rgb + tint * luminance * 0.5 + regionalTint * 0.5;
      
      // Sparkle effect for norepinephrine
      float neSparkle = pow(uNorepinephrine, 2.0) * 0.3;
      float sparkle = smoothstep(0.95, 1.0, rand(vUv + uTime)) * neSparkle;
      result += vec3(sparkle);

      gl_FragColor = vec4(result, col.a);
    }
  `,
};

// ─────────────────────────────────────────────────────────────────────────────
// GLSL: Film-grain / subtle chromatic aberration post-pass for cinematic depth.
// ─────────────────────────────────────────────────────────────────────────────
export const FILM_GRAIN_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uIntensity: { value: 0.018 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uIntensity;
    uniform vec2  uResolution;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;

      // Subtle chromatic aberration: R shifted slightly right, B left
      float ca = uIntensity * 0.3;
      vec4 rSample = texture2D(tDiffuse, uv + vec2(ca,  0.0));
      vec4 gSample = texture2D(tDiffuse, uv);
      vec4 bSample = texture2D(tDiffuse, uv - vec2(ca,  0.0));

      vec4 col = vec4(rSample.r, gSample.g, bSample.b, gSample.a);

      // Grain — per-pixel random seeded by UV + time
      float grain = rand(uv + fract(uTime * 0.07)) * 2.0 - 1.0;
      col.rgb += grain * uIntensity;

      gl_FragColor = col;
    }
  `,
};

