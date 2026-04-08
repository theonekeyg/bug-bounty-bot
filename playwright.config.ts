import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  reporter: [["list"], ["html", { outputFolder: "tests/report", open: "never" }]],
  use: {
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "electron",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
