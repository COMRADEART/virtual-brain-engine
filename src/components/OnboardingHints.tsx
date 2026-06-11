import { useEffect, useState } from "react";
import { Brain, Command, Keyboard, MousePointerClick, Settings2, X } from "lucide-react";
import { useLocalStorage } from "../engine/useApiCall";

const DISMISS_KEY = "brain-onboarding-dismissed";

const TIPS = [
  { icon: Command, text: "Press Ctrl+K for the command palette — every panel and mode is in there." },
  { icon: Keyboard, text: "Press ? for shortcuts, L to cycle layouts, Space to pause the simulation." },
  { icon: MousePointerClick, text: "Click any brain region in the 3D scene to inspect it." },
  { icon: Settings2, text: "Press , (comma) to open Settings — accent color, density, glass, shortcuts." },
] as const;

/**
 * First-run welcome card. Shows once after a short delay; dismissing persists.
 * Settings → "Show welcome tips" clears the flag to bring it back.
 */
export function OnboardingHints(): JSX.Element | null {
  const [dismissed, setDismissed] = useLocalStorage<boolean>(DISMISS_KEY, false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (dismissed) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(timer);
  }, [dismissed]);

  // Settings → "Show welcome tips" fires this so the card returns immediately,
  // not on the next reload.
  useEffect(() => {
    const handler = (): void => setDismissed(false);
    window.addEventListener("brain-onboarding-reset", handler);
    return () => window.removeEventListener("brain-onboarding-reset", handler);
  }, [setDismissed]);

  if (dismissed || !visible) return null;

  return (
    <div className="onboarding-card" role="dialog" aria-label="Welcome tips">
      <header className="onboarding-head">
        <span className="onboarding-title">
          <Brain size={15} />
          Welcome to the Brain
        </span>
        <button
          type="button"
          className="toast-close"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss welcome tips"
        >
          <X size={13} />
        </button>
      </header>
      <ul className="onboarding-tips">
        {TIPS.map((tip, i) => {
          const Icon = tip.icon;
          return (
            <li key={i}>
              <Icon size={13} aria-hidden="true" />
              <span>{tip.text}</span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="onboarding-dismiss" onClick={() => setDismissed(true)}>
        Got it
      </button>
    </div>
  );
}

/** Re-enable the welcome card (used by the Settings panel). */
export function resetOnboarding(): void {
  try {
    window.localStorage.removeItem(DISMISS_KEY);
  } catch {}
  window.dispatchEvent(new Event("brain-onboarding-reset"));
}
