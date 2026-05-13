// Connector descriptors live in the `connectors` SQLite table and are mirrored
// to the frontend over /api/connectors. Implementations live server-side.

export type ConnectorKind =
  | "ollama"
  | "openai-compatible"
  | "huggingface"
  | "python-script"
  | "agent";

export type ConnectorState = "idle" | "busy" | "ok" | "unreachable" | "error";

export interface ConnectorDescriptor {
  id: string; // stable slug, e.g. "ollama-default"
  name: string;
  kind: ConnectorKind;
  baseUrl?: string;
  model?: string;
  embeddingModel?: string;
  enabled: boolean;
  isDefault?: boolean;
  state: ConnectorState;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
  // Computed at read time on the server. True when baseUrl is loopback or
  // RFC1918, or when the connector has no baseUrl (e.g. stubs). Surfaced so the
  // UI can render a "Purely local" / "Remote model in use" badge.
  isLocal: boolean;
}

export interface SendOptions {
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  // JSON-only response, validated server-side.
  format?: "text" | "json";
}

export interface ConnectorTestResult {
  ok: boolean;
  message?: string;
  models?: string[];
}
