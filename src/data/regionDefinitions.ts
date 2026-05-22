import type {
  BrainActionDefinition,
  BrainRegionDefinition,
  BrainRegionId,
  Hemisphere,
} from "../engine/types";

type RegionTemplate = Omit<BrainRegionDefinition, "id" | "hemisphere" | "center"> & {
  baseId: string;
  xOffset: number;
  yOffset: number;
  zOffset: number;
  hemisphere?: Hemisphere;
};

// Helper: emit one or two regions from a single template.
// For lateral templates we mirror the center on x. Midline templates emit a single
// region with the supplied offsets.
function expand(template: RegionTemplate): BrainRegionDefinition[] {
  const { baseId, xOffset, yOffset, zOffset, hemisphere, ...common } = template;

  if (hemisphere === "midline") {
    return [
      {
        ...common,
        id: baseId as BrainRegionId,
        hemisphere: "midline",
        center: [xOffset, yOffset, zOffset],
      },
    ];
  }

  return [
    {
      ...common,
      id: `${baseId}-l` as BrainRegionId,
      hemisphere: "left",
      center: [-Math.abs(xOffset), yOffset, zOffset],
      name: `Left ${common.name.toLowerCase()}`,
      shortName: `L ${common.shortName}`,
    },
    {
      ...common,
      id: `${baseId}-r` as BrainRegionId,
      hemisphere: "right",
      center: [Math.abs(xOffset), yOffset, zOffset],
      name: `Right ${common.name.toLowerCase()}`,
      shortName: `R ${common.shortName}`,
    },
  ];
}

const TEMPLATES: RegionTemplate[] = [
  {
    baseId: "prefrontal",
    name: "Prefrontal cortex",
    shortName: "Prefrontal",
    function: "Planning, decision making, working memory, and goal selection.",
    color: "#5df2ff",
    radius: [0.46, 0.36, 0.34],
    baseNeuronCount: 92,
    lobe: "frontal",
    xOffset: 0.55,
    yOffset: 0.32,
    zOffset: 0.95,
  },
  {
    baseId: "frontal",
    name: "Frontal association cortex",
    shortName: "Frontal",
    function: "Higher-order cognition, attention control, and executive function.",
    color: "#69e0ff",
    radius: [0.42, 0.36, 0.32],
    baseNeuronCount: 86,
    lobe: "frontal",
    xOffset: 0.6,
    yOffset: 0.42,
    zOffset: 0.42,
  },
  {
    baseId: "motor",
    name: "Motor cortex",
    shortName: "Motor",
    function: "Voluntary movement planning and motor command output.",
    color: "#79ff9f",
    radius: [0.38, 0.28, 0.18],
    baseNeuronCount: 80,
    lobe: "frontal",
    xOffset: 0.7,
    yOffset: 0.62,
    zOffset: 0.08,
  },
  {
    baseId: "somatosensory",
    name: "Somatosensory cortex",
    shortName: "Somato",
    function: "Touch, proprioception, and body-surface sensation.",
    color: "#a0ffb6",
    radius: [0.38, 0.28, 0.18],
    baseNeuronCount: 78,
    lobe: "parietal",
    xOffset: 0.72,
    yOffset: 0.6,
    zOffset: -0.12,
  },
  {
    baseId: "parietal",
    name: "Parietal cortex",
    shortName: "Parietal",
    function: "Spatial awareness, sensory integration, and attention.",
    color: "#b3f361",
    radius: [0.44, 0.32, 0.32],
    baseNeuronCount: 90,
    lobe: "parietal",
    xOffset: 0.66,
    yOffset: 0.48,
    zOffset: -0.46,
  },
  {
    baseId: "temporal",
    name: "Temporal cortex",
    shortName: "Temporal",
    function: "Object recognition, semantics, and language comprehension.",
    color: "#ffb86b",
    radius: [0.3, 0.3, 0.48],
    baseNeuronCount: 92,
    lobe: "temporal",
    xOffset: 0.82,
    yOffset: -0.22,
    zOffset: -0.08,
  },
  {
    baseId: "auditory",
    name: "Auditory cortex",
    shortName: "Auditory",
    function: "Sound processing, speech cues, rhythm, and source localization.",
    color: "#ffcf5a",
    radius: [0.2, 0.18, 0.28],
    baseNeuronCount: 64,
    lobe: "temporal",
    xOffset: 0.76,
    yOffset: 0.04,
    zOffset: -0.05,
  },
  {
    baseId: "occipital",
    name: "Occipital cortex",
    shortName: "Visual",
    function: "Visual feature extraction, object detection, and spatial vision.",
    color: "#57a6ff",
    radius: [0.4, 0.34, 0.34],
    baseNeuronCount: 90,
    lobe: "occipital",
    xOffset: 0.42,
    yOffset: 0.08,
    zOffset: -1.02,
  },
  {
    baseId: "hippocampus",
    name: "Hippocampus",
    shortName: "Memory",
    function: "Memory encoding, recall, context binding, and navigation.",
    color: "#ff8be6",
    radius: [0.2, 0.14, 0.3],
    baseNeuronCount: 60,
    lobe: "subcortical",
    xOffset: 0.36,
    yOffset: -0.34,
    zOffset: -0.2,
  },
  {
    baseId: "amygdala",
    name: "Amygdala",
    shortName: "Emotion",
    function: "Threat detection, salience, emotion, and autonomic alerts.",
    color: "#ff6b6b",
    radius: [0.16, 0.16, 0.16],
    baseNeuronCount: 50,
    lobe: "subcortical",
    xOffset: 0.3,
    yOffset: -0.3,
    zOffset: 0.16,
  },
  {
    baseId: "thalamus",
    name: "Thalamus",
    shortName: "Thalamus",
    function: "Sensory relay station, gating signals to cortex.",
    color: "#ffe28a",
    radius: [0.14, 0.14, 0.18],
    baseNeuronCount: 56,
    lobe: "subcortical",
    xOffset: 0.18,
    yOffset: -0.04,
    zOffset: -0.06,
  },
  {
    baseId: "basal-ganglia",
    name: "Basal ganglia",
    shortName: "Basal",
    function: "Action selection, habit, and motor sequencing.",
    color: "#c794ff",
    radius: [0.18, 0.18, 0.22],
    baseNeuronCount: 60,
    lobe: "subcortical",
    xOffset: 0.34,
    yOffset: 0.02,
    zOffset: 0.06,
  },
  {
    baseId: "cerebellum",
    name: "Cerebellum",
    shortName: "Cerebellum",
    function: "Coordination, timing, posture, balance, and motor correction.",
    color: "#c4ff61",
    radius: [1.05, 0.38, 0.5],
    baseNeuronCount: 150,
    lobe: "cerebellum",
    hemisphere: "midline",
    xOffset: 0,
    yOffset: -0.8,
    zOffset: -0.85,
  },
  {
    baseId: "brainstem",
    name: "Brainstem",
    shortName: "Brainstem",
    function: "Breathing, heart-rate modulation, arousal, and body signal routing.",
    color: "#ff9d4d",
    radius: [0.22, 0.52, 0.22],
    baseNeuronCount: 80,
    lobe: "brainstem",
    hemisphere: "midline",
    xOffset: 0,
    yOffset: -1.05,
    zOffset: -0.2,
  },
];

export const REGION_DEFINITIONS: BrainRegionDefinition[] = TEMPLATES.flatMap(expand);

// Color mappings for emergent actions based on neuroscience visualization conventions
const ACTION_COLORS: Record<string, string> = {
  "attentional-blink": "#a0d8f3", // Light blue for occipital activity with attentional suppression
  "eureka-moment": "#e7b3ff", // Purple for gamma bursts
  "fear-conditioning": "#ff6b6b", // Red for amygdala activation
  "memory-reconsolidation": "#ffd700", // Gold for hippocampal replay
  "decision-hesitation": "#ffff99", // Yellow for prefrontal conflict
  "sensory-gating": "#6bcaff", // Blue for thalamic filtering
  "sleep-ripple": "#ffffff", // White for sharp-wave ripples
};

export const BRAIN_ACTIONS: BrainActionDefinition[] = [
  {
    id: "lift-hand",
    label: "Lift hand",
    description: "Right-hand motor plan: contralateral prefrontal → motor → basal ganglia, with cerebellar correction via brainstem.",
    activeRegions: [
      "prefrontal-l",
      "motor-l",
      "somatosensory-l",
      "basal-ganglia-l",
      "cerebellum",
      "brainstem",
    ],
    impulseRate: 42,
  },
  {
    id: "see-object",
    label: "See object",
    description: "Bilateral visual stream: thalamus relays to occipital cortex, forward through parietal to prefrontal.",
    activeRegions: [
      "occipital-l",
      "occipital-r",
      "thalamus-l",
      "thalamus-r",
      "parietal-l",
      "parietal-r",
      "prefrontal-l",
    ],
    impulseRate: 38,
  },
  {
    id: "hear-sound",
    label: "Hear sound",
    description: "Auditory pathway: thalamus → primary auditory cortex → temporal lobes, with hippocampal memory binding.",
    activeRegions: [
      "auditory-l",
      "auditory-r",
      "thalamus-l",
      "thalamus-r",
      "temporal-l",
      "hippocampus-l",
      "hippocampus-r",
    ],
    impulseRate: 34,
  },
  {
    id: "remember-event",
    label: "Remember event",
    description: "Episodic recall: bilateral hippocampus → temporal cortex → prefrontal reconstruction.",
    activeRegions: [
      "hippocampus-l",
      "hippocampus-r",
      "prefrontal-l",
      "prefrontal-r",
      "temporal-l",
      "temporal-r",
    ],
    impulseRate: 36,
  },
  {
    id: "fear-response",
    label: "Fear response",
    description: "Limbic alarm: bilateral amygdala drives brainstem with right-prefrontal salience.",
    activeRegions: [
      "amygdala-l",
      "amygdala-r",
      "hippocampus-l",
      "hippocampus-r",
      "brainstem",
      "prefrontal-r",
    ],
    impulseRate: 48,
  },
  {
    id: "speak",
    label: "Speak",
    description: "Left-dominant language production: Broca → motor; Wernicke comprehension loop via temporal cortex. Activity skews left, with callosal spread to the right.",
    activeRegions: [
      "prefrontal-l",
      "motor-l",
      "auditory-l",
      "temporal-l",
      "cerebellum",
    ],
    impulseRate: 40,
  },
  {
    id: "read-text",
    label: "Read text",
    description: "Visual word recognition: bilateral occipital → left temporal (visual word form) → parietal → prefrontal.",
    activeRegions: [
      "occipital-l",
      "occipital-r",
      "temporal-l",
      "parietal-l",
      "prefrontal-l",
    ],
    impulseRate: 36,
  },
  // Emergent behavior actions
  {
    id: "attentional-blink",
    label: "Attentional Blink",
    description: "Temporal attention bottleneck: rapid sequential stimuli create ~200ms unresponsiveness in parietal cortex.",
    activeRegions: ["occipital-l", "occipital-r", "parietal-l", "parietal-r", "thalamus-l", "thalamus-r", "brainstem"],
    impulseRate: 8.5
  },
  {
    id: "eureka-moment",
    label: "Eureka Moment",
    description: "Insight gamma burst: sudden prefrontal-temporal synchronization reflects problem-solving insight.",
    activeRegions: ["prefrontal-l", "prefrontal-r", "frontal-l", "frontal-r", "hippocampus-l", "hippocampus-r", "temporal-l", "temporal-r", "brainstem"],
    impulseRate: 12.0
  },
  {
    id: "fear-conditioning",
    label: "Fear Conditioning",
    description: "Amygdalar plasticity: neutral stimuli acquire persistent fear responses through associative learning.",
    activeRegions: ["amygdala-l", "amygdala-r", "thalamus-l", "thalamus-r", "hippocampus-l", "hippocampus-r", "frontal-l", "frontal-r", "brainstem"],
    impulseRate: 9.2
  },
  {
    id: "memory-reconsolidation",
    label: "Memory Reconsolidation",
    description: "Memory updating: strong reactivation enables modification of existing memories during recall.",
    activeRegions: ["hippocampus-l", "hippocampus-r", "frontal-l", "frontal-r", "temporal-l", "temporal-r", "parietal-l", "parietal-r"],
    impulseRate: 6.8
  },
  {
    id: "decision-hesitation",
    label: "Decision Hesitation",
    description: "Conflict monitoring: prefrontal-basal ganglia competition creates decision uncertainty.",
    activeRegions: ["prefrontal-l", "prefrontal-r", "basal-ganglia-l", "basal-ganglia-r", "frontal-l", "frontal-r", "parietal-l", "parietal-r"],
    impulseRate: 5.2
  },
  {
    id: "sensory-gating",
    label: "Sensory Gating",
    description: "Thalamic filtering: irrelevant sensory input is inhibited at the thalamic level.",
    activeRegions: ["thalamus-l", "thalamus-r", "frontal-l", "frontal-r", "auditory-l", "auditory-r", "somatosensory-l", "somatosensory-r"],
    impulseRate: 7.5
  },
  {
    id: "sleep-ripple",
    label: "Sleep Ripple",
    description: "Hippocampal-neocortical replay: coordinated sharp-wave ripples mediate memory consolidation during sleep.",
    activeRegions: ["hippocampus-l", "hippocampus-r", "frontal-l", "frontal-r", "temporal-l", "temporal-r", "thalamus-l", "thalamus-r"],
    impulseRate: 4.8
  }
];

export function getActionColor(actionId: BrainActionId): string {
  return ACTION_COLORS[actionId] || "#cccccc"; // Default gray if no specific color
}
