// NOTE: next/jest uses the @next/swc native binary which is incompatible with
// Node >=23 in this environment. We configure babel-jest directly so the suite
// runs on any Node version without the broken SWC native module.

/** @type {import('jest').Config} */
const config = {
  // Component tests (.test.tsx) run in jsdom; everything else runs in node.
  // The `projects` array encodes this split so no per-file docblock is needed.
  projects: [
    {
      displayName: "node",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts", "**/*.spec.ts"],
      setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
      transform: {
        "^.+\\.tsx?$": [
          "babel-jest",
          {
            plugins: [
              // Strip TypeScript type annotations (including `import type`)
              // before the modules-commonjs transform sees them.
              ["@babel/plugin-transform-typescript", { allExtensions: true, onlyRemoveTypeImports: false }],
              "@babel/plugin-transform-modules-commonjs",
              ["@babel/plugin-transform-react-jsx", { runtime: "automatic" }],
            ],
          },
        ],
      },
      moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/$1",
        "\\.(css|scss|sass)$": "<rootDir>/__mocks__/styleMock.js",
      },
    },
    {
      displayName: "jsdom",
      testEnvironment: "jest-environment-jsdom",
      testEnvironmentOptions: { pretendToBeVisual: true },
      testMatch: ["**/*.test.tsx", "**/*.spec.tsx"],
      setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
      transform: {
        "^.+\\.tsx?$": [
          "babel-jest",
          {
            plugins: [
              ["@babel/plugin-transform-typescript", { allExtensions: true, isTSX: true, onlyRemoveTypeImports: false }],
              "@babel/plugin-transform-modules-commonjs",
              ["@babel/plugin-transform-react-jsx", { runtime: "automatic" }],
              "styled-jsx/babel-test",
            ],
          },
        ],
      },
      moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/$1",
        "\\.(css|scss|sass)$": "<rootDir>/__mocks__/styleMock.js",
      },
    },
  ],
  collectCoverageFrom: [
    "app/**/*.{ts,tsx}",
    "lib/**/*.{ts,tsx}",
    "!**/*.d.ts",
    "!**/*.test.{ts,tsx}",
  ],
};

module.exports = config;
