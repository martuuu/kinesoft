import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Capa 1 (unit de lógica pura) — ver .docs/TESTING.md. Sin DB ni red.
// La capa 3 (integración contra Postgres) tiene su propia config:
// vitest.integration.config.ts (`npm run test:integration`).
export default defineConfig({
  // Los render tests (`tests/unit/render/*.test.tsx`) montan componentes con
  // `renderToStaticMarkup` en entorno node (sin jsdom): alcanza con el runtime
  // automático de JSX, igual que el `jsx: "preserve"` + SWC de Next.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    // CF3 (hallazgo de SD-U): Prisma Client carga `.env` cuando el proceso no trae `DATABASE_URL`, y `.env` puede
    // apuntar a PRODUCCIÓN (AGENTS §4). La capa 1 no usa DB: un unit que llegue por error a una query tiene que
    // fallar contra un puerto muerto local, nunca conectarse a lo que diga `.env`.
    env: {
      DATABASE_URL: "postgresql://unit-tests-no-db@127.0.0.1:1/unit_tests_no_db",
      DIRECT_URL: "postgresql://unit-tests-no-db@127.0.0.1:1/unit_tests_no_db",
      DATABASE_URL_SERVICE: "postgresql://unit-tests-no-db@127.0.0.1:1/unit_tests_no_db",
    },
  },
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" path alias so tests import like the app does.
      "@": resolve(process.cwd(), "."),
      "server-only": resolve(process.cwd(), "tests/helpers/server-only-stub.ts"),
    },
  },
});
