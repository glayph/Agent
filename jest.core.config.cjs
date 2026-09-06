const base = require("./jest.config.cjs");

module.exports = {
  ...base,
  testMatch: ["<rootDir>/packages/core/src/**/*.test.ts"],
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns || []),
    "/packages/core/__tests__/",
  ],
};
