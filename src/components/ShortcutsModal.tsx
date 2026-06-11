import { useState, useEffect, useMemo } from "react";
import { Keyboard, X, Sun, Moon } from "lucide-react";
import { useTheme } from "../engine/useApiCall";
import { SHORTCUT_LABELS, useKeymap, type ShortcutAction } from "../engine/keymap";

// Rebindable single-key shortcuts come from the live keymap (Settings →
// Shortcuts); these chords are fixed.
const FIXED_SHORTCUTS = [
  { key: "Space", action: "Play/Pause simulation" },
  { key: "1-7", action: "Select brain action" },
  { key: "Ctrl+K", action: "Command palette" },
  { key: "F11", action: "Toggle Focus Mode" },
  { key: "?", action: "Toggle this help" },
];

const KEYMAP_ORDER: ShortcutAction[] = [
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

export function ShortcutsModal(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const keymap = useKeymap();

  const shortcuts = useMemo(
    () => [
      ...KEYMAP_ORDER.map((action) => ({
        key: keymap[action] === "," ? "," : keymap[action].toUpperCase(),
        action: SHORTCUT_LABELS[action],
      })),
      ...FIXED_SHORTCUTS,
    ],
    [keymap],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "?" &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        )
      ) {
        setOpen((o) => !o);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  if (!open) {
    return (
      <div className="shortcuts-bar">
        <button
          className="shortcuts-trigger"
          onClick={() => setOpen(true)}
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={14} />
          <span>?</span>
        </button>
        <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
    );
  }

  return (
    <div className="shortcuts-modal-overlay" onClick={() => setOpen(false)}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <Keyboard size={18} /> Shortcuts & Settings
          </h2>
          <button className="unified-btn icon" onClick={() => setOpen(false)}>
            <X size={14} />
          </button>
        </header>

        <section className="shortcuts-section">
          <h3>Appearance</h3>
          <div className="setting-row">
            <span>Theme</span>
            <button className="unified-btn" onClick={toggleTheme}>
              {theme === "dark" ? (
                <>
                  <Sun size={12} /> Light Mode
                </>
              ) : (
                <>
                  <Moon size={12} /> Dark Mode
                </>
              )}
            </button>
          </div>
        </section>

        <section className="shortcuts-section">
          <h3>Keyboard Shortcuts</h3>
          <div className="shortcuts-list">
            {shortcuts.map((s) => (
              <div key={`${s.key}-${s.action}`} className="shortcut-item">
                <kbd>{s.key}</kbd>
                <span>{s.action}</span>
              </div>
            ))}
          </div>
          <p className="settings-note">Rebind keys in Settings (press ,)</p>
        </section>
      </div>
    </div>
  );
}