import { useState } from "react";
import { Activity, Brain, Cpu, Database, MessageCircleQuestion, Search, X } from "lucide-react";
import { AskPanel } from "./AskPanel";
import { SearchPanel } from "./SearchPanel";
import { MemoryDashboard } from "./MemoryDashboard";
import { RuntimePicker } from "./RuntimePicker";
import { SystemStatusPanel } from "./SystemStatusPanel";

type Tab = "ask" | "search" | "memory" | "runtime" | "status";

const TABS: Array<{ id: Tab; label: string; icon: typeof Brain }> = [
  { id: "ask", label: "Ask", icon: MessageCircleQuestion },
  { id: "search", label: "Search", icon: Search },
  { id: "memory", label: "Memory", icon: Database },
  { id: "runtime", label: "Runtime", icon: Cpu },
  { id: "status", label: "Status", icon: Activity },
];

export function BrainOSPanel(): JSX.Element {
  const [tab, setTab] = useState<Tab>("ask");
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < 1100,
  );

  if (collapsed) {
    return (
      <button
        className="brain-os-pill"
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Open Brain OS"
      >
        <Brain size={16} />
        <span>Brain OS</span>
      </button>
    );
  }

  return (
    <aside className="brain-os-panel" aria-label="Brain OS">
      <header className="brain-os-head">
        <div className="brain-os-title">
          <Brain size={16} />
          <span>Brain OS</span>
        </div>
        <button
          className="ai-icon-button"
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Minimise Brain OS"
        >
          <X size={14} />
        </button>
      </header>
      <nav className="brain-os-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            role="tab"
            aria-selected={tab === id}
            type="button"
            onClick={() => setTab(id)}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </nav>
      <div className="brain-os-body">
        {tab === "ask" ? <AskPanel /> : null}
        {tab === "search" ? <SearchPanel /> : null}
        {tab === "memory" ? <MemoryDashboard /> : null}
        {tab === "runtime" ? <RuntimePicker /> : null}
        {tab === "status" ? <SystemStatusPanel /> : null}
      </div>
    </aside>
  );
}
