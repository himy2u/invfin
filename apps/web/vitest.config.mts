import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // Extend, don't replace, Vitest's defaults — a bare "node_modules/**" here previously
    // clobbered the default "**/node_modules/**" and let Vitest crawl into
    // .next/dev/node_modules/** (Next 16's Turbopack dev cache vendors its own copies of deps,
    // including packages that ship their own test files, e.g. pino's ESM test suite).
    exclude: ["**/e2e/**", "**/node_modules/**", "**/.next/**"],
  },
});
