// "Edit the brain's own knobs" — renders the server settings catalog
// (GET /api/settings) as live controls and POSTs validated patches back. Boolean
// and enum changes commit immediately; number sliders are debounced so dragging
// doesn't spam the server. Boot-time knobs show a "restart" badge; security-
// sensitive ones (internet egress, shell actions) show a warning.

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { apiClient } from "../../engine/apiClient";
import type { SettingValue, SettingWithValue, SettingsView } from "../../../shared/settings";
import { toastError, toastInfo, toastSuccess } from "../../engine/toastBus";

function formatNumber(spec: SettingWithValue): string {
  const n = Number(spec.value);
  return spec.step !== undefined && spec.step < 1 ? n.toFixed(2) : String(n);
}

function Toggle({ on, disabled, onClick }: { on: boolean; disabled: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`toggle-switch ${on ? "on" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function SettingControl({
  spec,
  disabled,
  onChange,
}: {
  spec: SettingWithValue;
  disabled: boolean;
  onChange: (value: SettingValue) => void;
}): JSX.Element {
  return (
    <div className={`setting-row ${spec.danger ? "danger" : ""}`}>
      <span>
        <span className="setting-label-row">
          {spec.label}
          {spec.danger && <AlertTriangle size={11} className="setting-danger-icon" aria-hidden="true" />}
          {spec.requiresRestart && <span className="setting-badge" title="Takes effect after a server restart">restart</span>}
        </span>
        <small className="setting-hint">{spec.description}</small>
      </span>

      {spec.type === "boolean" && (
        <Toggle on={spec.value === true} disabled={disabled} onClick={() => onChange(!(spec.value === true))} />
      )}

      {spec.type === "enum" && (
        <div className="settings-segmented" role="radiogroup" aria-label={spec.label}>
          {spec.options?.map((opt) => (
            <button
              key={opt}
              type="button"
              role="radio"
              aria-checked={spec.value === opt}
              className={spec.value === opt ? "active" : ""}
              disabled={disabled}
              onClick={() => onChange(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {spec.type === "number" && (
        <div className="settings-slider">
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={Number(spec.value)}
            aria-label={spec.label}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span className="settings-slider-value">{formatNumber(spec)}</span>
        </div>
      )}
    </div>
  );
}

export function BrainSettingsSection(): JSX.Element {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Debounce buffer for slider drags: collect patches, flush after a pause.
  const pending = useRef<Record<string, SettingValue>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    apiClient
      .getSettings()
      .then((v) => alive && setView(v))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Optimistic local update so controls feel instant before the server replies.
  function setLocal(key: string, value: SettingValue): void {
    setView((v) => (v ? { ...v, settings: v.settings.map((s) => (s.key === key ? { ...s, value } : s)) } : v));
  }

  async function commit(patch: Record<string, SettingValue>): Promise<void> {
    setBusy(true);
    try {
      const res = await apiClient.updateSettings(patch);
      setView(res.view);
      const badKeys = Object.keys(res.errors);
      if (badKeys.length) toastError(`Couldn't update: ${badKeys.join(", ")}`);
      else if (res.restartRequired.length) toastInfo("Saved — restart the server to fully apply");
      // Surface the single biggest security flip explicitly.
      if (patch.localOnly === false) toastInfo("Internet access enabled (remote egress now allowed)");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Update failed");
      // Re-sync from the server so the UI doesn't show an un-saved value.
      apiClient.getSettings().then(setView).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function onChange(spec: SettingWithValue, value: SettingValue): void {
    setLocal(spec.key, value);
    if (spec.type === "number") {
      pending.current[spec.key] = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const patch = pending.current;
        pending.current = {};
        if (Object.keys(patch).length) void commit(patch);
      }, 350);
    } else {
      void commit({ [spec.key]: value });
    }
  }

  async function resetAll(): Promise<void> {
    setBusy(true);
    try {
      const r = await apiClient.resetSettings();
      setView(r.view);
      toastSuccess("Brain settings reset to defaults");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="shortcuts-section brain-settings">
      <h3>
        <SlidersHorizontal size={13} /> Brain
        {view && (
          <button type="button" className="settings-link" onClick={resetAll} disabled={busy}>
            Reset
          </button>
        )}
      </h3>

      {error && <p className="settings-note">Couldn't load settings: {error}</p>}
      {!view && !error && <p className="settings-note">Loading…</p>}

      {view &&
        view.groups.map((group) => (
          <div key={group} className="brain-settings-group">
            <h4>{group}</h4>
            {view.settings
              .filter((s) => s.group === group)
              .map((s) => (
                <SettingControl key={s.key} spec={s} disabled={busy} onChange={(v) => onChange(s, v)} />
              ))}
          </div>
        ))}

      {view && (
        <p className="settings-note">
          These change how the brain thinks, retrieves, and connects. Saved on the server; “restart” items apply on next launch.
        </p>
      )}
    </section>
  );
}
