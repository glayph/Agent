const baseConfig = require("./jest.config.cjs");

module.exports = {
  ...baseConfig,
  setupFilesAfterEnv: [
    ...(baseConfig.setupFilesAfterEnv || []),
    "<rootDir>/scripts/jest-release-setup.cjs",
  ],
};
