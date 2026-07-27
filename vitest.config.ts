import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Capa 1 (unit de lógica pura) del estándar de testing — ver docs/TESTING.md.
// Sin DB ni red: solo módulos puros (datetime-ar, format). Las capas 2-4
// (componente, integración con tenant efímero, e2e) llegan en la Ola 2.1.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    // Mirror the tsconfig "@/*" path alias so tests import like the app does.
    alias: { "@": resolve(process.cwd(), ".") },
  },
});
