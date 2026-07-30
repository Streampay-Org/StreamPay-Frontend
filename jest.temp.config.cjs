module.exports = {
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  transform: {
    "^.+\\.(ts|tsx)$": require.resolve("ts-jest"),
  },
  testMatch: [
    "**/app/lib/stream-validation.test.ts",
    "**/tests/streamsShape.test.ts",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    "^next/navigation$": "<rootDir>/__mocks__/next/navigation.js",
    "^next/router$": "<rootDir>/__mocks__/next/router.js",
  },
};
