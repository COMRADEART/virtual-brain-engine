import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Search, LayoutGrid, Focus, Maximize2, Zap, Cpu, Brain,
  Database, Sparkles, Settings2, ChevronRight, Command,
  Network, HeartPulse, BrainCircuit, Activity, GitBranch, MessageSquare
} from "lucide-react";
import type { LayoutMode } from "../../engine/useLayoutMode";

interface Command {
  id: string;
  label: string;
  description?: string;
  category: "layout" | "performance" | "memory" | "actions" | "panels";
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  currentLayout: LayoutMode;
  currentPerfMode: string;
  onLayoutChange: (layout: LayoutMode) => void;
  onCyclePreset: () => void;
  onFocusMode: () => void;
  onCompactMode: () => void;
  onFullMode: () => void;

  // Phase 2 panel controls
  onToggleDigitalTwin: (collapsed?: boolean) => void;
  onOpenUnifiedTab: (tab: "ask" | "search" | "memory" | "graph" | "cortex" | "swarm" | "imagine" | "evolve" | "organism") => void;
  onToggleUnifiedPanel: (collapsed?: boolean) => void;
}

const CATEGORY_LABELS: Record<Command["category"], string> = {
  layout: "Layout",
  performance: "Performance",
  memory: "Memory",
  panels: "Phase 2 Panels",
  actions: "Actions",
};

export function CommandPalette({
  isOpen, onClose, currentLayout, currentPerfMode,
  onLayoutChange, onCyclePreset, onFocusMode, onCompactMode, onFullMode,
  onToggleDigitalTwin, onOpenUnifiedTab, onToggleUnifiedPanel,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => [
    {
      id: "focus-mode",
      label: "Focus Mode",
      description: "Distraction-free chat with minimal brain preview",
      category: "layout",
      icon: <Focus size={16} />,
      shortcut: "F11",
      action: () => { onFocusMode(); onClose(); },
    },
    {
      id: "compact-mode",
      label: "Compact Mode",
      description: "Minimal UI with small 3D brain",
      category: "layout",
      icon: <LayoutGrid size={16} />,
      shortcut: "L",
      action: () => { onCompactMode(); onClose(); },
    },
    {
      id: "full-mode",
      label: "Full Mode",
      description: "All panels visible - scientific control surface",
      category: "layout",
      icon: <Maximize2 size={16} />,
      shortcut: "L×2",
      action: () => { onFullMode(); onClose(); },
    },
    {
      id: "cycle-preset",
      label: "Performance Preset",
      description: `Current: ${currentPerfMode}`,
      category: "performance",
      icon: <Zap size={16} />,
      shortcut: "P",
      action: () => { onCyclePreset(); onClose(); },
    },
    {
      id: "toggle-twin",
      label: "Toggle Digital Twin Panel",
      description: "Show or hide the system resource & anomaly dashboard",
      category: "panels",
      icon: <Activity size={16} />,
      action: () => { onToggleDigitalTwin(); onClose(); },
    },
    {
      id: "toggle-unified",
      label: "Toggle Unified Panel",
      description: "Show or hide the main Brain OS panel",
      category: "panels",
      icon: <Brain size={16} />,
      action: () => { onToggleUnifiedPanel(); onClose(); },
    },
    {
      id: "focus-cortex",
      label: "Phase 2 Cortex Panel",
      description: "Activate the cognitive/reasoning cortex panel",
      category: "panels",
      icon: <BrainCircuit size={16} />,
      action: () => { onOpenUnifiedTab("cortex"); onClose(); },
    },
    {
      id: "focus-swarm",
      label: "Swarm Subsystem Panel",
      description: "Examine multi-agent swarm state and coordination",
      category: "panels",
      icon: <Network size={16} />,
      action: () => { onOpenUnifiedTab("swarm"); onClose(); },
    },
    {
      id: "focus-imagine",
      label: "Imagination Subsystem Panel",
      description: "Monitor agentic sandbox simulation and generation",
      category: "panels",
      icon: <Sparkles size={16} />,
      action: () => { onOpenUnifiedTab("imagine"); onClose(); },
    },
    {
      id: "focus-evolve",
      label: "Evolution Subsystem Panel",
      description: "Inspect multi-agent neural network generation and selection",
      category: "panels",
      icon: <Zap size={16} />,
      action: () => { onOpenUnifiedTab("evolve"); onClose(); },
    },
    {
      id: "focus-organism",
      label: "Organism Subsystem Panel",
      description: "View homeostatic balance and biological twin metrics",
      category: "panels",
      icon: <HeartPulse size={16} />,
      action: () => { onOpenUnifiedTab("organism"); onClose(); },
    },
    {
      id: "focus-ask",
      label: "Ask Brain Panel",
      description: "Query the cognitive pipeline using natural language",
      category: "panels",
      icon: <MessageSquare size={16} />,
      action: () => { onOpenUnifiedTab("ask"); onClose(); },
    },
    {
      id: "focus-search",
      label: "Search Memory Panel",
      description: "Search vector memory database directly",
      category: "panels",
      icon: <Search size={16} />,
      action: () => { onOpenUnifiedTab("search"); onClose(); },
    },
    {
      id: "focus-graph",
      label: "Memory Graph Panel",
      description: "Inspect semantic memory relations",
      category: "panels",
      icon: <GitBranch size={16} />,
      action: () => { onOpenUnifiedTab("graph"); onClose(); },
    },
  ], [
    currentLayout, currentPerfMode, onCompactMode, onFullMode, onFocusMode, onCyclePreset, onClose,
    onToggleDigitalTwin, onOpenUnifiedTab, onToggleUnifiedPanel
  ]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q)
    );
  }, [commands, query]);

  const grouped = useMemo(() => {
    const groups: Record<string, Command[]> = {};
    filtered.forEach(cmd => {
      if (!groups[cmd.category]) groups[cmd.category] = [];
      groups[cmd.category].push(cmd);
    });
    return groups;
  }, [filtered]);

  const flatFiltered = useMemo(() => filtered, [filtered]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const executeSelected = useCallback(() => {
    if (flatFiltered[selectedIndex]) {
      flatFiltered[selectedIndex].action();
    }
  }, [flatFiltered, selectedIndex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, flatFiltered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        executeSelected();
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }, [flatFiltered.length, selectedIndex, executeSelected, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  let globalIndex = -1;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div
        className="command-palette"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="command-palette-search">
          <Search size={16} className="search-icon" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a command..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search commands"
          />
          <kbd className="esc-hint">esc</kbd>
        </div>

        <div className="command-palette-list" ref={listRef}>
          {Object.entries(grouped).map(([category, cmds]) => (
            <div key={category} className="command-group">
              <div className="command-group-label">
                {CATEGORY_LABELS[category as Command["category"]]}
              </div>
              {cmds.map(cmd => {
                globalIndex++;
                const isSelected = globalIndex === selectedIndex;
                return (
                  <button
                    key={cmd.id}
                    className={`command-item ${isSelected ? "selected" : ""}`}
                    onClick={() => cmd.action()}
                    onMouseEnter={() => setSelectedIndex(globalIndex)}
                  >
                    <span className="command-icon">{cmd.icon}</span>
                    <span className="command-content">
                      <span className="command-label">{cmd.label}</span>
                      {cmd.description && (
                        <span className="command-desc">{cmd.description}</span>
                      )}
                    </span>
                    {cmd.shortcut && (
                      <kbd className="command-shortcut">{cmd.shortcut}</kbd>
                    )}
                    <ChevronRight size={14} className="command-arrow" />
                  </button>
                );
              })}
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="command-empty">
              No commands found for "{query}"
            </div>
          )}
        </div>

        <div className="command-palette-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

export function useCommandPalette(initialLayout: LayoutMode, initialPerf: string) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsOpen(v => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return { isOpen, setIsOpen };
}