import { useEffect, useState } from "react";
import { subscribeBrainBus } from "../engine/brainBus";
import { LOGICAL_REGION_LABELS, LOGICAL_REGION_MAP } from "../engine/logicalRegions";
import type { LogicalRegionId } from "../../shared/pipeline";

interface ActiveRegion {
  id: LogicalRegionId;
  expiresAt: number;
}

const FLASH_LIFETIME_MS = 2200;

// Floating chip stack near the brain that shows which logical cortices are
// currently active. Each flash entry self-expires so the indicator quiets down
// between pipeline steps.
export function LogicalRegionIndicator(): JSX.Element | null {
  const [active, setActive] = useState<ActiveRegion[]>([]);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type !== "pipeline" || message.status !== "start") {
        return;
      }
      const expiresAt = Date.now() + FLASH_LIFETIME_MS;
      setActive((current) => {
        const map = new Map<LogicalRegionId, ActiveRegion>();
        for (const entry of current) {
          map.set(entry.id, entry);
        }
        for (const region of message.logicalRegions) {
          map.set(region, { id: region, expiresAt });
        }
        return Array.from(map.values());
      });
    });
  }, []);

  useEffect(() => {
    if (active.length === 0) {
      return;
    }
    const id = window.setInterval(() => {
      const now = Date.now();
      setActive((current) => {
        const next = current.filter((entry) => entry.expiresAt > now);
        return next.length === current.length ? current : next;
      });
    }, 400);
    return () => window.clearInterval(id);
  }, [active.length]);

  if (active.length === 0) {
    return null;
  }

  return (
    <aside className="logical-region-indicator" aria-label="Active cortices">
      <small>Active cortex</small>
      <ul>
        {active.map((entry) => {
          const anatomical = LOGICAL_REGION_MAP[entry.id] ?? [];
          return (
            <li key={entry.id} className={`cortex-chip cortex-${entry.id}`}>
              <strong>{LOGICAL_REGION_LABELS[entry.id]}</strong>
              <span>{anatomical.length} region{anatomical.length === 1 ? "" : "s"}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
