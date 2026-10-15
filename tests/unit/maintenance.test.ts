import { describe, it, expect } from "vitest";
import {
  maintenanceDecision,
  maintenanceMode,
  maintenanceMessage,
  MAINTENANCE_PATH,
  MAINTENANCE_RETRY_AFTER_SECONDS,
} from "@/lib/maintenance";

// BO5-B · modo mantenimiento. La tabla de excepciones es el contrato: Mercado Pago nunca se bloquea (§5.4: un pago
// siempre se concilia), el monitor sigue viendo /api/health y el cron decide solo.
describe("maintenanceMode — parseo del env", () => {
  it("default off: sin setear, vacío o basura", () => {
    expect(maintenanceMode(undefined)).toBe("off");
    expect(maintenanceMode("")).toBe("off");
    expect(maintenanceMode("  ")).toBe("off");
    expect(maintenanceMode("true")).toBe("off");
    expect(maintenanceMode("1")).toBe("off");
    expect(maintenanceMode("yes")).toBe("off");
  });
  it("on (tolera espacios y mayúsculas, que es lo que se tipea en la consola de Vercel)", () => {
    expect(maintenanceMode("on")).toBe("on");
    expect(maintenanceMode(" ON ")).toBe("on");
    expect(maintenanceMode("On")).toBe("on");
  });
});

describe("maintenanceDecision — off no toca nada", () => {
  it.each(["/", "/dashboard", "/api/agenda/export", "/api/health", "/api/webhooks/mercadopago", "/mantenimiento"])(
    "%s → pass",
    (p) => {
      expect(maintenanceDecision(p, "off")).toBe("pass");
    }
  );
});

describe("maintenanceDecision — on", () => {
  const PASS = [
    // Monitor externo.
    "/api/health",
    "/api/health/",
    // Mercado Pago: nunca se corta (§5.4).
    "/api/webhooks",
    "/api/webhooks/",
    "/api/webhooks/mercadopago",
    "/api/webhooks/mercadopago/extra",
    // El cron decide por su cuenta.
    "/api/cron",
    "/api/cron/expire-trials",
    "/api/cron/a/b",
    // Assets y metadatos.
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/_next/data/build/x.json",
    "/favicon.ico",
    "/robots.txt",
    // La página misma (si no, el rewrite haría bucle).
    MAINTENANCE_PATH,
    `${MAINTENANCE_PATH}/`,
  ];
  it.each(PASS)("%s → pass", (p) => {
    expect(maintenanceDecision(p, "on")).toBe("pass");
  });

  const API = [
    "/api",
    "/api/",
    "/api/agenda/export",
    "/api/pacientes/export",
    "/api/auth/sign-in",
    "/api/auth/google",
    "/api/booking/abc/status",
    "/api/client-errors",
    "/api/realtime/local",
    // Prefijos que se PARECEN a una excepción pero no son ese segmento: no pasan.
    "/api/healthz",
    "/api/health/deep",
    "/api/webhooksx",
    "/api/cronjob",
  ];
  it.each(API)("%s → api", (p) => {
    expect(maintenanceDecision(p, "on")).toBe("api");
  });

  const PAGE = [
    "/",
    "/login",
    "/dashboard",
    "/agenda",
    "/plataforma",
    "/c/movare/booking",
    "/portal",
    "/sitemap.xml",
    "/robots.txt.bak",
    "/favicon.ico/x",
    "/mantenimiento-x",
    "/mantenimiento/otra",
    "/_nextx",
    // Next distingue mayúsculas: /API/... no es una ruta de API, es una página (que no existe) → mantenimiento.
    "/API/health",
  ];
  it.each(PAGE)("%s → page", (p) => {
    expect(maintenanceDecision(p, "on")).toBe("page");
  });
});

describe("maintenanceMessage", () => {
  it("sin mensaje o vacío → null", () => {
    expect(maintenanceMessage(undefined)).toBeNull();
    expect(maintenanceMessage("   ")).toBeNull();
  });
  it("recorta espacios y corta a 280 caracteres", () => {
    expect(maintenanceMessage("  Volvemos a las 22 h.  ")).toBe("Volvemos a las 22 h.");
    expect(maintenanceMessage("x".repeat(500))).toHaveLength(280);
  });
});

it("Retry-After = 600 s", () => {
  expect(MAINTENANCE_RETRY_AFTER_SECONDS).toBe(600);
});
