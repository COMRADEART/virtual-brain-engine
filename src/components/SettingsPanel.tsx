import { useEffect, useState } from "react";
import {
  Keyboard,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Settings2,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { useThemeMode, type ThemeMode } from "../engine/useApiCall";
import {
  ACCENT_PRESETS,
  useUiPrefs,
  type UiDensity,
  type UiGlass,
  type UiMotion,
} from "../engine/uiPrefs";
import {
  SHORTCUT_LABELS,
  useKeymapEditor,
  type ShortcutAction,
} from "../engine/keymap";
import { resetOnboarding } from "./OnboardingHints";
import { BrainSettingsSection } from "./settings/BrainSettingsSection";
import { FileIngestSection } from "./settings/FileIngestSection";
import { toastError, toastInfo, toastSuccess } from "../engine/toastBus";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

const THEME_MODES: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
  { id: "dark", label: "Dark", icon: Moon },
  { id: "light", label: "Light", icon: Sun },
  { id: "auto", label: "Auto", icon: Monitor },
];

const DENSITIES: Array<{ id: UiDensity; label: string }> = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

const TEXT_SIZES: Array<{ scale: number; label: string }> = [
  { scale: 0.92, label: "S" },
  { scale: 1, label: "M" },
  { scale: 1.08, label: "L" },
];

const GLASS_LEVELS: Array<{ id: UiGlass; label: string }> = [
  { id: "clear", label: "Clear" },
  { id: "standard", label: "Standard" },
  { id: "frosted", label: "Frosted" },
];

const MOTION_LEVELS: Array<{ id: UiMotion; label: string }> = [
  { id: "full", label: "Full" },
  { id: "reduced", label: "Reduced" },
];

// Neuron-field (GPU point cloud) size presets. 1M is the headline default; the
// renderer caps this down automatically on software/weak GPUs (BrainScene).
const NEURON_FIELD_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Off" },
  { value: 250_000, label: "250k" },
  { value: 1_000_000, label: "1M" },
  { value: 2_000_000, label: "2M" },
];

const SHORTCUT_ORDER: ShortcutAction[] = [
  "overview",
  "inside",
  "resetCamera",
  "toggleShell",
  "toggleAnatomy",
  "cyclePreset",
  "cycleLayout",
  "toggleEmergent",
  "screenshot",
  "openSettings",
];

export function SettingsPanel({ open, onClose }: SettingsPanelProps): JSX.Element | null {
  const [themeMode, setThemeMode] = useThemeMode();
  const { prefs, update, reset } = useUiPrefs();
  const { keymap, rebind, reset: resetKeys } = useKeymapEditor();
  // Action currently waiting for a key press, if any.
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);

  // Capture the next keydown while rebinding. Escape cancels.
  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const error = rebind(capturing, e.key);
        if (error) {
          toastError(error);
        } else {
          toastSuccess(`${SHORTCUT_LABELS[capturing]} → ${e.key === "," ? "," : e.key.toUpperCase()}`);
        }
        setCapturing(null);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturing, rebind]);

  useEffect(() => {
    if (!open) setCapturing(null);
  }, [open]);

  // Escape closes the modal (the capture handler above intercepts Escape
  // first while a rebind is pending, so it cancels the rebind instead).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="shortcuts-modal-overlay" onClick={onClose}>
      <div
        className="shortcuts-modal settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <header>
          <h2>
            <Settings2 size={18} /> Settings
          </h2>
          <button className="unified-btn icon" onClick={onClose} aria-label="Close settings">
            <X size={14} />
          </button>
        </header>

        <section className="shortcuts-section">
          <h3>
            <Palette size={13} /> Appearance
          </h3>

          <div className="setting-row">
            <span>Theme</span>
            <div className="settings-segmented" role="radiogroup" aria-label="Theme">
              {THEME_MODES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={themeMode === id ? "active" : ""}
                  role="radio"
                  aria-checked={themeMode === id}
                  onClick={() => setThemeMode(id)}
                >
                  <Icon size={12} /> {label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span>Accent</span>
            <div className="accent-swatches" role="radiogroup" aria-label="Accent color">
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`accent-swatch ${prefs.accentId === preset.id ? "active" : ""}`}
                  style={{ background: preset.dark.accent }}
                  title={preset.label}
                  role="radio"
                  aria-checked={prefs.accentId === preset.id}
                  aria-label={preset.label}
                  onClick={() => update({ accentId: preset.id })}
                />
              ))}
              <label
                className={`accent-swatch accent-custom ${prefs.accentId === "custom" ? "active" : ""}`}
                style={{ background: prefs.accentId === "custom" ? prefs.customAccent : undefined }}
                title="Custom color"
              >
                <input
                  type="color"
                  value={prefs.customAccent}
                  aria-label="Custom accent color"
                  onChange={(e) => update({ accentId: "custom", customAccent: e.target.value })}
                />
                {prefs.accentId !== "custom" && <span aria-hidden="true">+</span>}
              </label>
            </div>
          </div>

          <div className="setting-row">
            <span>Density</span>
            <div className="settings-segmented" role="radiogroup" aria-label="UI density">
              {DENSITIES.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={prefs.density === id ? "active" : ""}
                  role="radio"
                  aria-checked={prefs.density === id}
                  onClick={() => update({ density: id })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span>Text size</span>
            <div className="settings-segmented" role="radiogroup" aria-label="Text size">
              {TEXT_SIZES.map(({ scale, label }) => (
                <button
                  key={label}
                  type="button"
                  className={prefs.uiScale === scale ? "active" : ""}
                  role="radio"
                  aria-checked={prefs.uiScale === scale}
                  onClick={() => update({ uiScale: scale })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span>Panel glass</span>
            <div className="settings-segmented" role="radiogroup" aria-label="Panel glass">
              {GLASS_LEVELS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={prefs.glass === id ? "active" : ""}
                  role="radio"
                  aria-checked={prefs.glass === id}
                  onClick={() => update({ glass: id })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span>Motion</span>
            <div className="settings-segmented" role="radiogroup" aria-label="Motion">
              {MOTION_LEVELS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={prefs.motion === id ? "active" : ""}
                  role="radio"
                  aria-checked={prefs.motion === id}
                  onClick={() => update({ motion: id })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="shortcuts-section">
          <h3>
            <Sparkles size={13} /> Scene
          </h3>
          <div className="setting-row">
            <span>
              Glow intensity
              <small className="setting-hint">visible on presets with bloom (Cinematic)</small>
            </span>
            <div className="settings-slider">
              <input
                type="range"
                min={0}
                max={1.2}
                step={0.05}
                value={prefs.bloomStrength}
                aria-label="Glow intensity"
                onChange={(e) => update({ bloomStrength: Number(e.target.value) })}
              />
              <span className="settings-slider-value">{prefs.bloomStrength.toFixed(2)}</span>
            </div>
          </div>

          <div className="setting-row">
            <span>
              Neurons
              <small className="setting-hint">GPU point-cloud size — auto-capped on weak GPUs</small>
            </span>
            <div className="settings-segmented" role="radiogroup" aria-label="Neuron field size">
              {NEURON_FIELD_OPTIONS.map(({ value, label }) => (
                <button
                  key={label}
                  type="button"
                  className={prefs.neuronFieldCount === value ? "active" : ""}
                  role="radio"
                  aria-checked={prefs.neuronFieldCount === value}
                  onClick={() => update({ neuronFieldCount: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <FileIngestSection />

        <BrainSettingsSection />

        <section className="shortcuts-section">
          <h3>
            <Keyboard size={13} /> Shortcuts
            <button type="button" className="settings-link" onClick={() => resetKeys()}>
              Reset keys
            </button>
          </h3>
          <div className="shortcuts-list">
            {SHORTCUT_ORDER.map((action) => (
              <div key={action} className="shortcut-item">
                <button
                  type="button"
                  className={`kbd-rebind ${capturing === action ? "capturing" : ""}`}
                  onClick={() => setCapturing(capturing === action ? null : action)}
                  aria-label={`Rebind: ${SHORTCUT_LABELS[action]}`}
                >
                  {capturing === action ? "press a key…" : keymap[action] === "," ? "," : keymap[action].toUpperCase()}
                </button>
                <span>{SHORTCUT_LABELS[action]}</span>
              </div>
            ))}
          </div>
          <p className="settings-note">
            Space, 1–7, ?, F11 and Ctrl+K are fixed. Click a key to rebind; Esc cancels.
          </p>
        </section>

        <section className="shortcuts-section settings-footer-row">
          <button
            type="button"
            className="unified-btn"
            onClick={() => {
              resetOnboarding();
              toastInfo("Welcome tips will show again");
              onClose();
            }}
          >
            Show welcome tips
          </button>
          <button
            type="button"
            className="unified-btn danger"
            onClick={() => {
              reset();
              resetKeys();
              toastSuccess("Preferences reset to defaults");
            }}
          >
            <RotateCcw size={12} /> Reset all preferences
          </button>
        </section>
      </div>
    </div>
  );
}
