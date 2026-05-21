import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import App from "./App";

// The Tauri "pet" window opens index.html?window=pet. Lazy-load the companion
// so its module graph is NEVER evaluated on the normal app path (a static
// import here regresses the Three.js canvas) — and so the pet ships as its own
// chunk.
const PetWindow = lazy(() =>
  import("./components/pet/PetWindow").then((m) => ({ default: m.PetWindow })),
);
const isPet = new URLSearchParams(window.location.search).get("window") === "pet";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isPet ? (
        <Suspense fallback={null}>
          <PetWindow />
        </Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
