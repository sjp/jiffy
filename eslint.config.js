// Flat ESLint config. Pairs with Prettier (which owns formatting) — ESLint here
// is for correctness/code-quality rules only, so we don't enable any stylistic
// rules that would fight the formatter.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-firefox/", "dist-chrome/"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Honour the `_`-prefix convention for intentionally unused bindings (e.g.
  // mock constructor params that exist only to match a signature).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Extension source runs in the browser with the WebExtension `browser.*` API.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },

  // Build/test tooling runs in Node.
  {
    files: ["**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
