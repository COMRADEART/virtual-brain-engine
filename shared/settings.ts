// Shared contract for the runtime application-settings layer ("edit the brain's
// own knobs from the UI"). ZERO runtime deps. The catalog + persistence live
// server-side (server/src/settings/runtimeSettings.ts); the frontend renders the
// catalog and POSTs a patch back.
//
// A setting maps 1:1 onto a property of the server's ServerConfig (and the env
// var that seeds it). Only the curated, runtime-safe subset is editable — keys
// that are read once at boot (intervals, ports, schedules) are still surfaced but
// flagged `requiresRestart`, so the UI tells the user a restart is needed for the
// change to take full effect. Secrets (API keys) are NEVER in the catalog: they
// stay in .env and are read from process.env only.

export type SettingType = "boolean" | "number" | "enum";

export type SettingValue = boolean | number | string;

export interface SettingSpec {
  // Catalog id == the ServerConfig property name it controls.
  key: string;
  label: string;
  description: string;
  // UI grouping (e.g. "Privacy & network", "Speed").
  group: string;
  type: SettingType;
  // The env var that seeds this config value (shown as a hint in the UI).
  envVar: string;
  // enum only — the allowed string values.
  options?: string[];
  // number only — inclusive bounds + slider step.
  min?: number;
  max?: number;
  step?: number;
  // Read once at boot → a runtime change is persisted but only takes full effect
  // after a restart. The UI surfaces a "restart" badge.
  requiresRestart?: boolean;
  // Security/data-sensitive toggle (e.g. opening internet egress, enabling shell
  // actions, irreversible auto-merge). The UI styles it as a warning.
  danger?: boolean;
}

export interface SettingWithValue extends SettingSpec {
  value: SettingValue;
}

export interface SettingsView {
  groups: string[];
  settings: SettingWithValue[];
}

export interface UpdateSettingsResult {
  ok: boolean;
  // Keys that validated and were applied to the live config.
  applied: string[];
  // Applied keys that need a server restart to take full effect.
  restartRequired: string[];
  // Per-key validation errors for rejected keys (unknown id / bad value).
  errors: Record<string, string>;
  // The full view after applying — the UI re-renders from this.
  view: SettingsView;
}
