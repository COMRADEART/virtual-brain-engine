import { Lock, Globe } from "lucide-react";

interface LocalityBadgeProps {
  locality: "local" | "remote" | "unknown";
  remoteUrls?: string[];
}

// Shows the user, at a glance, whether any enabled connector points off the
// machine. Green = every enabled connector has a loopback/RFC1918 baseUrl;
// amber = at least one points outside. The amber state lists the offending
// baseUrls so the user can see exactly where tokens would go.
export function LocalityBadge({ locality, remoteUrls = [] }: LocalityBadgeProps): JSX.Element {
  if (locality === "remote") {
    const list = remoteUrls.length > 0 ? remoteUrls.join(", ") : "remote endpoint";
    return (
      <div className="locality-badge remote" title={`Tokens may leave the machine: ${list}`}>
        <Globe size={12} />
        <span>Remote model in use</span>
      </div>
    );
  }
  if (locality === "local") {
    return (
      <div className="locality-badge local" title="All enabled connectors use loopback or private-network URLs.">
        <Lock size={12} />
        <span>Purely local</span>
      </div>
    );
  }
  return (
    <div className="locality-badge unknown" title="Locality not yet determined">
      <Lock size={12} />
      <span>Locality unknown</span>
    </div>
  );
}
