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
    "^@hiro/config$":
      "<rootDir>/packages/config/src/index.ts",
    "^@hiro/config/security$":
      "<rootDir>/packages/config/src/security.ts",
    "^@hiro/installer$":
      "<rootDir>/packages/installer/src/index.ts",
    "^@hiro/skills$":
      "<rootDir>/packages/skills/src/index.ts",
    "^@hiro/core$":
      "<rootDir>/packages/core/src/index.ts",
    "^@hiro/gateway$":
      "<rootDir>/packages/gateway/src/index.ts",
    "^openai$": "<rootDir>/packages/core/src/__mocks__/openai.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
