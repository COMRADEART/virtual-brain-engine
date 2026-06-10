// ESLint flat config — correctness-focused, NOT stylistic. The repo has no
// formatter by design; tsc (strict) already owns the type story. This layer
// exists to catch the bug classes tsc can't: unawaited promises in void
// position, accidental shadowing/var reuse, useless catches, hook misuse.
// Keep it quiet: a rule that would flood the existing codebase with noise
// belongs OFF (or as a targeted override), not auto-fixed across 50k lines.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "artifacts/**",
      "data/**",
      "node_modules/**",
      "server/node_modules/**",
      "server/dist/**",
      "src-tauri/**",
      "computer-brain/**",
      "worker/**",
      "coverage/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-wide tuning.
  {
    rules: {
      // tsc(strict) + the repo's pervasive zod parsing make these noise:
      "@typescript-eslint/no-explicit-any": "off",
      // WARN, not error: ~134 pre-existing unused imports/vars across the
      // codebase. Burn that baseline down opportunistically (it shows in
      // editors + CI logs); the gate fails on ERRORS only.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Empty catch is an established idiom here (failure-isolated seams) —
      // but only with a comment explaining why.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The codebase intentionally uses `while (true)` loops in agents.
      "no-constant-condition": ["error", { checkLoops: false }],
      // `cond ? doA() : doB()` / `x && fn()` statements are an established
      // idiom in the probe/smoke scripts.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
    },
  },

  // Frontend (browser).
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // The classic two hook rules only. The v6 "recommended" set (purity,
      // set-state-in-effect, refs, immutability) is React-Compiler-era advice
      // that flags long-established patterns in this codebase; adopt those
      // deliberately later, not as a lint-gate flag-day.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Server + shared + scripts (node).
  {
    files: ["server/**/*.{ts,mjs}", "shared/**/*.ts", "scripts/**/*.{mjs,ts}", "*.{mjs,ts}"],
    languageOptions: { globals: { ...globals.node } },
  },
);
