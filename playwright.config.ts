import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_STATE_DIR } from "./tests/e2e/support/e2e-constants.mjs";

/**
 * OPS-6 (plan §21.3.7) · capa 4 de .docs/TESTING.md: E2E en Chromium contra `next build && next start` + el Docker
 * local. Se corre con `npm run test:e2e` (carga `.env.local`: la DB es la del Docker, nunca la del `.env`).
 *
 * - El server (`tests/e2e/support/start-server.mjs`) corre en TZ=UTC como Vercel; el browser en hora de Argentina:
 *   es la combinación donde se esconden los bugs de fecha (AGENTS.md §3).
 * - Datos: `tests/e2e/global-setup.ts` arma un tenant efímero con `tests/helpers/tenant-factory.ts` (NUNCA seeds) y
 *   `global-teardown.ts` lo borra.
 * - Auth: un GoTrue falso dentro del mismo proceso del server; el proyecto `setup` se loguea por el form real de
 *   /login y guarda la sesión para el resto.
 * - Serial (`workers: 1`): todos los specs comparten el tenant y la agenda del mismo profesional; en paralelo un
 *   turno de un spec le cambia la grilla al otro.
 */
const CI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./tests/e2e/.results",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "tests/e2e/.report" }]] : [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1366, height: 768 },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "chromium",
      testMatch: /\.spec\.ts$/,
      dependencies: ["setup"],
      use: { storageState: `${E2E_STATE_DIR}/owner.json` },
    },
    {
      // FC-E (T4): los flujos que cambian abajo de 640 px (composer = barra + Drawer, portal mobile-first) corren
      // también a 390. Solo los tests marcados `@390` en el título; el resto ya lo cubre `chromium`.
      name: "mobile-390",
      testMatch: /\.spec\.ts$/,
      grep: /@390/,
      dependencies: ["setup"],
      use: { storageState: `${E2E_STATE_DIR}/owner.json`, viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
  webServer: {
    command: "node tests/e2e/support/start-server.mjs",
    url: `${E2E_BASE_URL}/login`,
    // build + start: el build solo tarda varios minutos en CI.
    timeout: 15 * 60_000,
    reuseExistingServer: !CI,
    // El build imprime cientos de líneas; los errores (build o server) salen por stderr.
    stdout: "ignore",
    stderr: "pipe",
  },
});
