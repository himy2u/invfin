import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // These tests share live local infra (Supabase, the agent service, its Mailpit) rather than
  // isolated fixtures — parallel workers caused real flakiness (an agent --reload mid-request from
  // an unrelated file write, tests racing the same dev servers). Serial execution trades speed for
  // reliability, which matters more here since these are also our verification of real behavior.
  workers: 1,
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: "http://localhost:3000",
  },
});
