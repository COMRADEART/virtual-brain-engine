import { Cpu, Network, RadioTower } from "lucide-react";
import { BRAIN_ACTIONS, REGION_DEFINITIONS } from "../data/regionDefinitions";
import type { BrainActionId, BrainMetrics, BrainRegionId } from "../engine/types";

interface InfoPanelProps {
  metrics: BrainMetrics;
  selectedActionId: BrainActionId;
  selectedRegionId: BrainRegionId | null;
}

export function InfoPanel({
  metrics,
  selectedActionId,
  selectedRegionId,
}: InfoPanelProps): JSX.Element {
  const selectedRegion =
    REGION_DEFINITIONS.find((region) => region.id === selectedRegionId) ?? REGION_DEFINITIONS[0];
  const selectedAction = BRAIN_ACTIONS.find((action) => action.id === selectedActionId) ?? BRAIN_ACTIONS[0];
  const activeRegionNames = selectedAction.activeRegions
    .map((regionId) => REGION_DEFINITIONS.find((region) => region.id === regionId)?.shortName)
    .filter(Boolean)
    .join(" + ");

  return (
    <aside className="info-panel" aria-label="Brain region information">
      <div className="telemetry-strip">
        <div>
          <Cpu size={16} />
          <span>{metrics.neurons.toLocaleString()}</span>
          <small>neurons</small>
        </div>
        <div>
          <Network size={16} />
          <span>{metrics.pathways.toLocaleString()}</span>
          <small>paths</small>
        </div>
        <div>
          <RadioTower size={16} />
          <span>{metrics.regions}</span>
          <small>regions</small>
        </div>
      </div>

      <section className="readout">
        <p className="eyebrow">Selected region</p>
        <h2 style={{ color: selectedRegion.color }}>{selectedRegion.name}</h2>
        <p>{selectedRegion.function}</p>
      </section>

      <section className="readout action-readout">
        <p className="eyebrow">Active pattern</p>
        <h3>{selectedAction.label}</h3>
        <p>{selectedAction.description}</p>
        <div className="active-route">{activeRegionNames}</div>
      </section>
    </aside>
  );
}
