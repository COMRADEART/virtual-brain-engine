import { useState, useEffect } from "react";
import { Keyboard, X, Sun, Moon } from "lucide-react";
import { useTheme } from "../engine/useApiCall";

const SHORTCUTS = [
  { key: "Space", action: "Play/Pause simulation" },
  { key: "1-7", action: "Select brain action" },
  { key: "O", action: "Overview camera" },
  { key: "I", action: "Inside camera" },
  { key: "R", action: "Reset camera" },
  { key: "X", action: "Toggle shell transparency" },
  { key: "A", action: "Toggle anatomy cloud" },
  { key: "P", action: "Cycle performance preset" },
  { key: "L", action: "Cycle layout (Compact/Focus/Full)" },
  { key: "?", action: "Toggle this help" },
];

export function ShortcutsModal(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();

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
            {SHORTCUTS.map((s) => (
              <div key={s.key} className="shortcut-item">
                <kbd>{s.key}</kbd>
                <span>{s.action}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}