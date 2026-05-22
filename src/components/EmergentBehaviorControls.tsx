import React from "react";
import type { BrainActionId } from "../engine/types";

interface EmergentBehaviorControlsProps {
  onActionSelect: (actionId: BrainActionId) => void;
  currentAction: BrainActionId;
}

export const EmergentBehaviorControls: React.FC<EmergentBehaviorControlsProps> = (
  { onActionSelect, currentAction }
) => {
  const emergentActions = [
    { id: "attentional-blink", label: "Attentional Blink", description: "Limited neural resources produce ~200ms unresponsiveness" },
    { id: "eureka-moment", label: "Eureka Moment", description: "Sudden gamma burst reflects insight" },
    { id: "fear-conditioning", label: "Fear Conditioning", description: "Amygdalar plasticity creates persistent response" },
    { id: "memory-reconsolidation", label: "Memory Reconsolidation", description: "Strong reactivation enables modification" },
    { id: "decision-hesitation", label: "Decision Hesitation", description: "Prefrontal conflict monitoring" },
    { id: "sensory-gating", label: "Sensory Gating", description: "Thalamic filtering of irrelevant input" },
    { id: "sleep-ripple", label: "Sleep Ripple", description: "Coordinated hippocampal-neocortical replay" }
  ];
  
  return (
    <div className="emergent-behaviors">
      <h3>Emergent Cognitive Phenomena</h3>
      <div className="action-buttons">
        {emergentActions.map((action) => (
          <button
            key={action.id}
            className={currentAction === action.id ? "active" : ""}
            onClick={() => onActionSelect(action.id as BrainActionId)}
            title={action.description}
          >
            {action.label}
          </button>
        ))}
      </div>
      <div className="action-description">
        {emergentActions.find(a => a.id === currentAction)?.description || "Select an action to simulate"}
      </div>
      <style jsx>{`
        .emergent-behaviors {
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(10px);
          color: white;
          padding: 12px;
          border-radius: 8px;
          margin-top: 12px;
          max-width: 320px;
        }
        h3 {
          margin-top: 0;
          font-size: 16px;
          text-align: center;
        }
        .action-buttons {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 6px;
          margin-bottom: 8px;
        }
        button {
          padding: 8px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          color: white;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.2s;
        }
        button:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        button.active {
          background: rgba(76, 175, 222, 0.6);
          border-color: rgba(76, 175, 222, 1);
        }
        .action-description {
          font-size: 12px;
          opacity: 0.8;
          text-align: center;
          min-height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
      `}</style>
    </div>
  );
};