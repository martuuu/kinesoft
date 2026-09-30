import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Capa 3 — integración contra Postgres real (Docker :5433 en local, service
// container en CI). Corre las server actions REALES (lib/*.ts) con getActor
// real; solo se mockean cookie/headers, la red de Supabase y el runtime de
// cache de Next (tests/helpers/integration-setup.ts).
//
// Dos modos (package.json):
//   · test:integration        → DATABASE_URL = kinesoft_app (RLS aplicada)
//   · test:integration:owner  → DATABASE_URL = owner BYPASSRLS (= prod hoy)
// Serial en un solo proceso: todos los tests comparten la misma base.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/helpers/integration-setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": resolve(process.cwd(), "."),
      "server-only": resolve(process.cwd(), "tests/helpers/server-only-stub.ts"),
    },
  },
});
