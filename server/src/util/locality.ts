// Pure locality computation for /api/health and the LocalityBadge. Factored out
// of the route so it can be unit-tested hermetically (no Express, no DB).
//
// "remote" iff at least one ENABLED connector points off the machine. Voice is
// handled separately: STT now uses the LOCAL faster-whisper worker (the
// cloud-backed Web Speech path was removed), so the only voice signal the server
// reports is whether that local STT worker is available — never a remote egress.

export interface LocalityConnector {
  enabled: boolean;
  isLocal: boolean;
}

export function computeLocality(
  connectors: ReadonlyArray<LocalityConnector>,
): "local" | "remote" {
  return connectors.some((c) => c.enabled && !c.isLocal) ? "remote" : "local";
}
