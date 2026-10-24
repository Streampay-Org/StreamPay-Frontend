import * as nextPluginNs from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tsEslint from "@typescript-eslint/eslint-plugin";
import nextParser from "eslint-config-next/parser.js";
import tsParser from "@typescript-eslint/parser";

// Namespace import works whether the runtime exposes the CJS exports as the
// default export (Node) or only as named exports (Bun).
const nextPlugin = nextPluginNs.flatConfig ? nextPluginNs : nextPluginNs.default;

/**
 * Paths where the new rule sets are enforced as errors. Everywhere else
 * (including stream-specific code) the same rules are downgraded to warnings.
 */
const ERROR_SCOPE = [
  "app/{activity,contacts,templates,settings,onboarding,help,docs,dashboard}/**/*.{ts,tsx,js,jsx}",
  "app/components/**/*.{ts,tsx,js,jsx}",
  "app/lib/**/*.{ts,tsx,js,jsx}",
  "lib/**/*.{ts,tsx,js,jsx}",
  "src/**/*.{ts,tsx,js,jsx}",
  "middleware.ts",
];

// Stream-specific components stay at warn even though they live in app/components.
const STREAM_EXCLUDES = [
  "app/components/**/*[Ss]tream*",
  "app/components/**/streams/**",
  "app/streams/**",
  "app/api/streams/**",
  "app/api/v2/**",
];

/** Rules that need no type information. */
const rulesAt = (level) => ({
  "react-hooks/rules-of-hooks": level,
  "react-hooks/exhaustive-deps": level,
  ...Object.fromEntries(
    Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([name, value]) => [
      name,
      level === "error" ? value : "warn",
    ]),
  ),
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-unused-vars": level,
});

const config = [
  {
    ignores: [
      ".next/**",
      ".dist/**",
      "node_modules/**",
      "coverage/**",
      "eslint.config.mjs",
      "jest.config.js",
      "next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: nextParser,
      parserOptions: {
        requireConfigFile: false,
        sourceType: "module",
        allowImportExportEverywhere: true,
        babelOptions: {
          presets: ["next/babel"],
          caller: {
            supportsTopLevelAwait: true,
          },
        },
      },
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
        // Type information is required by no-floating-promises.
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  nextPlugin.flatConfig.coreWebVitals,
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
    plugins: {
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
      "@typescript-eslint": tsEslint,
    },
    rules: rulesAt("warn"),
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
    },
  },
  {
    files: ERROR_SCOPE,
    ignores: STREAM_EXCLUDES,
    rules: rulesAt("error"),
  },
  {
    files: ERROR_SCOPE.filter((f) => /\{ts,tsx/.test(f) || f.endsWith(".ts")),
    ignores: STREAM_EXCLUDES,
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
];

export default config;
