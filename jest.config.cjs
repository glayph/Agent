/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  testMatch: [
    "<rootDir>/__tests__/**/*.test.ts",
    "<rootDir>/packages/**/*.test.ts",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/A/",
    "/dist/",
    "/packages/ui/frontend/",
    "/*.d.ts",
  ],
  transformIgnorePatterns: [
    "/node_modules/(?!(openai|@anthropic-ai)/)",
  ],
  modulePathIgnorePatterns: ["<rootDir>/A/", "<rootDir>/dist/"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          esModuleInterop: true,
          skipLibCheck: true,
          isolatedModules: true,
          types: ["node", "jest"],
        },
      },
    ],
  },
  moduleNameMapper: {
    "^@miki/config$":
      "<rootDir>/packages/config/src/index.ts",
    "^@miki/config/security$":
      "<rootDir>/packages/config/src/security.ts",
    "^@miki/installer$":
      "<rootDir>/packages/installer/src/index.ts",
    "^@miki/skills$":
      "<rootDir>/packages/skills/src/index.ts",
    "^@miki/core$":
      "<rootDir>/packages/core/src/index.ts",
    "^@miki/gateway$":
      "<rootDir>/packages/gateway/src/index.ts",
    "^openai$": "<rootDir>/packages/core/src/__mocks__/openai.ts",
    "^@anthropic-ai/sdk$": "<rootDir>/packages/core/src/__mocks__/@anthropic-ai/sdk.ts",
    "^(\\.{1,2}/.*)memory/memory-bridge\\.js$":
      "<rootDir>/packages/core/src/__mocks__/memory-bridge.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
