// Loopback + RFC1918 allowlist. Used by the LOCAL_ONLY guard in the connector
// registry and by /api/connectors validation so we can refuse non-local
// baseUrls before they ever round-trip to the model.

export function isLocalUrl(input: string | undefined | null): boolean {
  if (!input) {
    // Connectors without a baseUrl (stubs) cannot leak traffic.
    return true;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  return isLocalHostname(url.hostname);
}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  // IPv4 literal — match 127/8, 10/8, 192.168/16, 172.16/12.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127 || a === 10) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    return false;
  }
  // IPv6 link-local fe80::/10 and unique-local fc00::/7.
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  return false;
}
