import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Database,
  Layers,
  LogIn,
  MessageSquareQuote,
  Network,
  Save,
} from "lucide-react";
import { subscribeBrainBus } from "../engine/brainBus";
import { LOGICAL_REGION_LABELS } from "../engine/logicalRegions";
import type { PipelineEvent, PipelineStepId } from "../../shared/pipeline";
import { PIPELINE_STEP_ORDER } from "../../shared/pipeline";

const STEP_META: Record<PipelineStepId, { label: string; icon: typeof Layers }> = {
  input: { label: "Input", icon: LogIn },
  memory: { label: "Memory", icon: Database },
  reasoning: { label: "Reason", icon: Network },
  project: { label: "Project", icon: Layers },
  error: { label: "Verify", icon: AlertTriangle },
  response: { label: "Respond", icon: MessageSquareQuote },
  learning: { label: "Learn", icon: Save },
};

interface StepState {
  status: "idle" | "active" | "complete" | "error";
  detail?: string;
  regions: string[];
}

const INITIAL: Record<PipelineStepId, StepState> = PIPELINE_STEP_ORDER.reduce(
  (acc, step) => {
    acc[step] = { status: "idle", regions: [] };
    return acc;
  },
  {} as Record<PipelineStepId, StepState>,
);

export function PipelineOverlay(): JSX.Element | null {
  const [steps, setSteps] = useState<Record<PipelineStepId, StepState>>(INITIAL);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [tokenCount, setTokenCount] = useState(0);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return subscribeBrainBus((message) => {
      if (message.type !== "pipeline") {
        return;
      }
      const event = message as PipelineEvent & { type: "pipeline" };
      setActiveRunId(event.runId);
      setSteps((current) => {
        const next = { ...current };
        const region = event.logicalRegions.map((id) => LOGICAL_REGION_LABELS[id] ?? id);
        if (event.status === "start") {
          next[event.step] = { status: "active", detail: event.detail, regions: region };
        } else if (event.status === "complete") {
          next[event.step] = { status: "complete", detail: event.detail, regions: region };
        } else if (event.status === "error") {
          next[event.step] = { status: "error", detail: event.detail, regions: region };
        }
        return next;
      });

      if (event.step === "response" && event.status === "progress" && event.tokensDelta) {
        setTokenCount((count) => count + event.tokensDelta!.length);
      }
      if (event.step === "input" && event.status === "start") {
        setTokenCount(0);
      }

      if (event.step === "learning" && event.status === "complete") {
        if (resetTimer.current !== null) {
          window.clearTimeout(resetTimer.current);
        }
        resetTimer.current = window.setTimeout(() => {
          setSteps(INITIAL);
          setActiveRunId(null);
          setTokenCount(0);
          resetTimer.current = null;
        }, 5000);
      }
    });
  }, []);

  const anyActive = Object.values(steps).some((s) => s.status !== "idle");
  if (!anyActive) {
    return null;
  }

  // Compute the "front" of the pipeline (rightmost non-idle step) so we can
  // render an animated cursor on the connecting line.
  const lastActiveIndex = PIPELINE_STEP_ORDER.reduce(
    (acc, step, idx) => (steps[step].status !== "idle" ? idx : acc),
    -1,
  );
  const cursorPct = lastActiveIndex < 0 ? 0 : (lastActiveIndex / (PIPELINE_STEP_ORDER.length - 1)) * 100;

  const activeStep = PIPELINE_STEP_ORDER.find((step) => steps[step].status === "active");
  const activeRegions = activeStep ? steps[activeStep].regions : [];
  const activeDetail = activeStep ? steps[activeStep].detail : undefined;

  return (
    <aside className="pipeline-overlay" aria-label="Pipeline progress">
      <header className="pipeline-overlay-head">
        <Activity size={14} />
        <span>Pipeline</span>
        {activeStep ? <small className="pipeline-active-label">{STEP_META[activeStep].label}…</small> : null}
        <small className="pipeline-meta">
          {tokenCount > 0 ? `${tokenCount} chars · ` : ""}
          {activeRunId ? `run ${activeRunId.slice(-6)}` : ""}
        </small>
      </header>
      <div className="pipeline-timeline" role="list">
        <div className="pipeline-track" aria-hidden="true">
          <div className="pipeline-track-fill" style={{ width: `${cursorPct}%` }} />
        </div>
        {PIPELINE_STEP_ORDER.map((stepId) => {
          const state = steps[stepId];
          const { label, icon: Icon } = STEP_META[stepId];
          return (
            <div key={stepId} className={`pipeline-node ${state.status}`} role="listitem">
              <div className="pipeline-node-icon">
                <Icon size={14} />
              </div>
              <div className="pipeline-node-label">{label}</div>
            </div>
          );
        })}
      </div>
      {activeRegions.length > 0 || activeDetail ? (
        <div className="pipeline-active-info">
          {activeRegions.length > 0 ? (
            <div className="pipeline-region-chips">
              {activeRegions.map((region) => (
                <span key={region} className="pipeline-region-chip">
                  {region}
                </span>
              ))}
            </div>
          ) : null}
          {activeDetail ? <p className="pipeline-detail">{activeDetail}</p> : null}
        </div>
      ) : null}
    </aside>
  );
}
