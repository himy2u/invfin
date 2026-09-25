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
  // 5s (the default) is shorter than a cold Next dev compile of a route these tests are the first to
  // visit, so whichever spec happened to hit an uncompiled page first would fail on a timeout that
  // had nothing to do with what it was asserting, producing a rotating, confusing flake. These also
  // talk to a hosted Supabase over the network rather than a local one, so every round trip carries
  // real latency. Raising the assertion timeout removes both without weakening a single assertion.
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:3000",
  },
});
