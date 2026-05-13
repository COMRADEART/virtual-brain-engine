import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(3, 6, 9, 0.95)",
            color: "#e5fbff",
            fontFamily: "Bahnschrift, Aptos, Segoe UI, sans-serif",
            gap: "16px",
            padding: "24px",
          }}
        >
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "50%",
              border: "2px solid rgba(255, 107, 107, 0.6)",
              background: "rgba(255, 107, 107, 0.1)",
              display: "grid",
              placeItems: "center",
              color: "#ff6b6b",
              fontSize: "24px",
            }}
          >
            !
          </div>
          <div style={{ textAlign: "center" }}>
            <p
              style={{
                margin: "0 0 8px",
                fontSize: "1.1rem",
                color: "#f4fdff",
              }}
            >
              Something went wrong
            </p>
            <p
              style={{
                margin: 0,
                fontSize: "0.82rem",
                color: "#86a8ad",
                maxWidth: "400px",
              }}
            >
              {this.state.error?.message ?? "An unexpected error occurred"}
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 16px",
              border: "1px solid rgba(93, 242, 255, 0.5)",
              borderRadius: "4px",
              background: "rgba(93, 242, 255, 0.15)",
              color: "#e5fbff",
              cursor: "pointer",
              fontSize: "0.82rem",
            }}
          >
            Reload page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}