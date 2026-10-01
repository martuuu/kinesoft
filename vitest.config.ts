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
  },
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" path alias so tests import like the app does.
      "@": resolve(process.cwd(), "."),
      "server-only": resolve(process.cwd(), "tests/helpers/server-only-stub.ts"),
    },
  },
});
