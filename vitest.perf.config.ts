import { defineConfig } from "vitest/config";
import { resolve } from "path";

// A1.2 — suite de medición de performance (Docker local, nunca prod).
// Mismo harness que la integración (mocks de cookie/red/cache), un solo
// proceso serial y timeouts largos: el fixture de volumen tarda en armarse.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/perf/**/*.perf.test.ts"],
    setupFiles: ["tests/helpers/integration-setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "."),
      "server-only": resolve(process.cwd(), "tests/helpers/server-only-stub.ts"),
    },
  },
});
