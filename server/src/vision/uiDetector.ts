import type { UIState, UIStateType, VisualRegion } from "../../../shared/vision.js";
import type { UIDetectionResult, DetectedUIRegion, UIElementType } from "./types.js";

const TERMINAL_KEYWORDS = [
  "git",
  "npm",
  "cargo",
  "rustc",
  "node",
  "python",
  "ls",
  "cd",
  "mkdir",
  "rm",
  "curl",
  "wget",
  "ssh",
  "ps",
  "kill",
  "top",
  "htop",
  "sudo",
  "apt",
  "yum",
  "pacman",
  "chmod",
  "gcc",
  "make",
  "cmake",
];

const IDE_KEYWORDS = [
  "VS Code",
  "Visual Studio",
  "IntelliJ",
  "PyCharm",
  "WebStorm",
  "PhpStorm",
  "GoLand",
  "Rider",
  "CLion",
  "Xcode",
  "Eclipse",
  "Sublime",
  "Atom",
  "Brackets",
  "Vim",
  "Neovim",
  "Emacs",
];

const BROWSER_KEYWORDS = [
  "Chrome",
  "Firefox",
  "Safari",
  "Edge",
  "Brave",
  "Opera",
  "Vivaldi",
];

const BUILD_ERROR_PATTERNS = [
  "error:",
  "Error:",
  "ERROR",
  "failed",
  "Failed",
  "FAILED",
  "warning:",
  "Warning:",
  "WARNING",
  "SyntaxError",
  "TypeError",
  "ReferenceError",
  "ImportError",
  "ModuleNotFoundError",
  "Compilation failed",
  "Build failed",
  "Build error",
];

const TEST_FAILURE_PATTERNS = [
  "FAILED",
  "FAIL:",
  "test failed",
  "Test failed",
  "assertion failed",
  "Assertion failed",
  "expected:",
  "but got:",
  "Tests failed",
];

export function detectUIRegions(
  screenshotData: string,
  width: number,
  height: number,
  windowTitle?: string | null
): UIDetectionResult {
  const regions: DetectedUIRegion[] = [];

  const titleLower = (windowTitle || "").toLowerCase();

  if (titleLower.includes("terminal") || titleLower.includes("cmd") || titleLower.includes("powershell")) {
    regions.push({
      type: "terminal",
      x: 0,
      y: 0,
      width,
      height,
      label: "Terminal",
      confidence: 0.95,
      app: extractAppName(windowTitle),
    });

    return {
      regions,
      overallState: "terminal",
      confidence: 0.95,
    };
  }

  for (const ide of IDE_KEYWORDS) {
    if (titleLower.includes(ide.toLowerCase())) {
      regions.push({
        type: "editor",
        x: 0,
        y: 0,
        width: Math.floor(width * 0.7),
        height,
        label: "Code Editor",
        confidence: 0.9,
        app: ide,
      });

      regions.push({
        type: "sidebar",
        x: Math.floor(width * 0.7),
        y: 0,
        width: Math.floor(width * 0.15),
        height,
        label: "File Explorer",
        confidence: 0.8,
        app: ide,
      });

      regions.push({
        type: "panel",
        x: Math.floor(width * 0.85),
        y: 0,
        width: Math.floor(width * 0.15),
        height,
        label: "Sidebar",
        confidence: 0.8,
        app: ide,
      });

      return {
        regions,
        overallState: "coding",
        confidence: 0.9,
      };
    }
  }

  for (const browser of BROWSER_KEYWORDS) {
    if (titleLower.includes(browser.toLowerCase())) {
      regions.push({
        type: "window",
        x: 0,
        y: 0,
        width,
        height: Math.floor(height * 0.9),
        label: "Browser Content",
        confidence: 0.9,
        app: browser,
      });

      regions.push({
        type: "toolbar",
        x: 0,
        y: Math.floor(height * 0.9),
        width,
        height: Math.floor(height * 0.1),
        label: "Browser Toolbar",
        confidence: 0.85,
        app: browser,
      });

      return {
        regions,
        overallState: "browser",
        confidence: 0.9,
      };
    }
  }

  for (const errorPat of BUILD_ERROR_PATTERNS) {
    if (titleLower.includes(errorPat.toLowerCase())) {
      regions.push({
        type: "dialog",
        x: Math.floor(width * 0.2),
        y: Math.floor(height * 0.2),
        width: Math.floor(width * 0.6),
        height: Math.floor(height * 0.6),
        label: "Error Dialog",
        confidence: 0.85,
        app: extractAppName(windowTitle),
      });

      return {
        regions,
        overallState: "build_error",
        confidence: 0.85,
      };
    }
  }

  for (const testPat of TEST_FAILURE_PATTERNS) {
    if (titleLower.includes(testPat.toLowerCase())) {
      regions.push({
        type: "dialog",
        x: Math.floor(width * 0.2),
        y: Math.floor(height * 0.2),
        width: Math.floor(width * 0.6),
        height: Math.floor(height * 0.6),
        label: "Test Failure",
        confidence: 0.85,
        app: extractAppName(windowTitle),
      });

      return {
        regions,
        overallState: "test_failure",
        confidence: 0.85,
      };
    }
  }

  if (titleLower.includes("settings") || titleLower.includes("preferences")) {
    regions.push({
      type: "dialog",
      x: 0,
      y: 0,
      width,
      height,
      label: "Settings",
      confidence: 0.9,
      app: extractAppName(windowTitle),
    });

    return {
      regions,
      overallState: "settings",
      confidence: 0.9,
    };
  }

  if (titleLower.includes("debug") || titleLower.includes("breakpoint")) {
    return {
      regions,
      overallState: "debugging",
      confidence: 0.8,
    };
  }

  if (titleLower.length === 0 || titleLower === "unknown") {
    regions.push({
      type: "unknown",
      x: 0,
      y: 0,
      width,
      height,
      label: "Unknown Window",
      confidence: 0.5,
    });

    return {
      regions,
      overallState: "unknown",
      confidence: 0.5,
    };
  }

  regions.push({
    type: "window",
    x: 0,
    y: 0,
    width,
    height,
    label: windowTitle || "Application",
    confidence: 0.7,
    app: extractAppName(windowTitle),
  });

  return {
    regions,
    overallState: "idle",
    confidence: 0.6,
  };
}

function extractAppName(windowTitle: string | null | undefined): string | undefined {
  if (!windowTitle) return undefined;

  for (const ide of IDE_KEYWORDS) {
    if (windowTitle.toLowerCase().includes(ide.toLowerCase())) {
      return ide;
    }
  }

  for (const browser of BROWSER_KEYWORDS) {
    if (windowTitle.toLowerCase().includes(browser.toLowerCase())) {
      return browser;
    }
  }

  const parts = windowTitle.split(/[-–|]/);
  if (parts.length > 0) {
    return parts[0].trim();
  }

  return undefined;
}

export function detectUIStateFromRegions(
  regions: DetectedUIRegion[],
  windowTitle?: string | null
): UIState {
  const titleLower = (windowTitle || "").toLowerCase();

  const hasTerminal = regions.some((r) => r.type === "terminal");
  if (hasTerminal) {
    return {
      type: "terminal",
      confidence: 0.9,
      detail: "Terminal session active",
      regions: regions.filter((r) => r.type === "terminal") as unknown as VisualRegion[],
      suggestedAction: null,
    };
  }

  const hasEditor = regions.some((r) => r.type === "editor");
  const hasSidebar = regions.some((r) => r.type === "sidebar");
  if (hasEditor && hasSidebar) {
    return {
      type: "coding",
      confidence: 0.85,
      detail: "IDE with file explorer",
      regions: regions as unknown as VisualRegion[],
      suggestedAction: null,
    };
  }

  const hasBrowser = regions.some((r) => r.type === "browser");
  if (hasBrowser) {
    return {
      type: "browser",
      confidence: 0.9,
      detail: "Web browser active",
      regions: regions as unknown as VisualRegion[],
      suggestedAction: null,
    };
  }

  const hasDialog = regions.some((r) => r.type === "dialog");
  if (hasDialog) {
    if (titleLower.includes("error") || titleLower.includes("failed")) {
      return {
        type: "error_dialog",
        confidence: 0.85,
        detail: "Error dialog detected",
        regions: regions.filter((r) => r.type === "dialog") as unknown as VisualRegion[],
        suggestedAction: "Analyze error and suggest fix",
      };
    }

    return {
      type: "settings",
      confidence: 0.8,
      detail: "Settings or dialog window",
      regions: regions.filter((r) => r.type === "dialog") as unknown as VisualRegion[],
      suggestedAction: null,
    };
  }

  const hasSettings = regions.some((r) => r.type === "settings");
  if (hasSettings) {
    return {
      type: "settings",
      confidence: 0.85,
      detail: "Settings panel open",
      regions: regions.filter((r) => r.type === "settings") as unknown as VisualRegion[],
      suggestedAction: null,
    };
  }

  return {
    type: "idle",
    confidence: 0.5,
    detail: "Generic application window",
    regions: regions as unknown as VisualRegion[],
    suggestedAction: null,
  };
}

export function analyzeTextForPatterns(text: string): {
  isTerminal: boolean;
  isBuildError: boolean;
  isTestFailure: boolean;
  isCode: boolean;
  matchedPatterns: string[];
} {
  const textLower = text.toLowerCase();
  const matchedPatterns: string[] = [];

  for (const kw of TERMINAL_KEYWORDS) {
    if (textLower.includes(kw)) {
      matchedPatterns.push(kw);
    }
  }

  const isTerminal = TERMINAL_KEYWORDS.some((kw) => textLower.includes(kw));
  const isBuildError = BUILD_ERROR_PATTERNS.some((pat) => text.includes(pat));
  const isTestFailure = TEST_FAILURE_PATTERNS.some((pat) => text.includes(pat));

  const codePatterns = [
    "function",
    "const ",
    "let ",
    "var ",
    "import ",
    "export ",
    "class ",
    "struct ",
    "enum ",
    "interface ",
    "public ",
    "private ",
    "async ",
    "await ",
    "=>",
    "->",
    "::",
  ];
  const isCode = codePatterns.some((pat) => text.includes(pat));

  return {
    isTerminal,
    isBuildError,
    isTestFailure,
    isCode,
    matchedPatterns,
  };
}

export function inferWindowTypeFromTitle(title: string | null): {
  type: UIElementType;
  app: string | null;
  confidence: number;
} {
  if (!title) {
    return { type: "unknown", app: null, confidence: 0.3 };
  }

  const titleLower = title.toLowerCase();

  if (
    titleLower.includes("terminal") ||
    titleLower.includes("cmd") ||
    titleLower.includes("powershell") ||
    titleLower.includes("bash") ||
    titleLower.includes("zsh")
  ) {
    return { type: "terminal", app: "Terminal", confidence: 0.95 };
  }

  for (const ide of IDE_KEYWORDS) {
    if (titleLower.includes(ide.toLowerCase())) {
      return { type: "editor", app: ide, confidence: 0.95 };
    }
  }

  for (const browser of BROWSER_KEYWORDS) {
    if (titleLower.includes(browser.toLowerCase())) {
      return { type: "window", app: browser, confidence: 0.9 };
    }
  }

  if (
    titleLower.includes("settings") ||
    titleLower.includes("preferences") ||
    titleLower.includes("configuration")
  ) {
    return { type: "dialog", app: extractAppName(title) ?? null, confidence: 0.85 };
  }

  if (titleLower.includes("error") || titleLower.includes("failed")) {
    return { type: "dialog", app: extractAppName(title) ?? null, confidence: 0.8 };
  }

  if (titleLower.includes("explorer") || titleLower.includes("finder")) {
    return { type: "window", app: "File Explorer", confidence: 0.85 };
  }

  return { type: "window", app: extractAppName(title) ?? null, confidence: 0.6 };
}