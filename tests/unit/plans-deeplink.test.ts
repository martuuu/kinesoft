import { describe, it, expect } from "vitest";
import {
  PLAN_PREFILL_MAX_CHARS,
  decodePlanPrefill,
  encodePlanPrefill,
  normalizeProfileTab,
  parseDiagnosisDeepLink,
  parseProfilePlanParams,
  planDeepLinkHref,
  stripPlanIntentParams,
  type PlanEditorPrefill,
} from "@/lib/plans-deeplink";

/** [P3-C] C10: deep-links de Planes, armados y parseados solo en `lib/plans-deeplink.ts`. */

const PREFILL: PlanEditorPrefill = {
  discipline: "KINESIOLOGY",
  serviceId: "svc_1",
  practitionerId: "pr_1",
  locationId: null,
  durationMin: 45,
  startDayKey: "2026-10-06",
  totalSessions: 10,
  schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 540 }, { dow: 4, startMin: 540 }] },
  pricing: { mode: "PACKAGE", totalPriceCents: 12_000_000 },
  fromBookingId: "bk_1",
  countBookingAsSession1: true,
};

function paramsOf(href: string): URLSearchParams {
  return new URL(href, "http://x").searchParams;
}

describe("planDeepLinkHref (formato literal de C10)", () => {
  it("plan en foco", () => {
    expect(planDeepLinkHref({ kind: "program", patientId: "pat1", programId: "prog1" })).toBe(
      "/pacientes/pat1?tab=planes&programa=prog1"
    );
  });

  it("nuevo desde un turno", () => {
    expect(planDeepLinkHref({ kind: "new", patientId: "pat1", fromBookingId: "bk1" })).toBe(
      "/pacientes/pat1?tab=planes&nuevo=1&turno=bk1"
    );
  });

  it("Diagnóstico con y sin params", () => {
    expect(planDeepLinkHref({ kind: "diagnosis", patientId: "pat1", bookingId: "bk1" })).toBe(
      "/diagnostico?patientId=pat1&bookingId=bk1"
    );
    expect(planDeepLinkHref({ kind: "diagnosis" })).toBe("/diagnostico");
  });

  it("ids que no son seguros para URL → null (no se arma un link roto)", () => {
    expect(planDeepLinkHref({ kind: "program", patientId: "pat1", programId: "a&tab=x" })).toBeNull();
    expect(planDeepLinkHref({ kind: "diagnosis", patientId: "../x" })).toBeNull();
  });

  it("prefill: ida y vuelta por la URL (UTF-8 incluido)", () => {
    const href = planDeepLinkHref({ kind: "new", patientId: "pat1", prefill: PREFILL });
    expect(href).toMatch(/^\/pacientes\/pat1\?tab=planes&nuevo=1&prefill=[A-Za-z0-9_-]+$/);
    const { tab, intent } = parseProfilePlanParams(paramsOf(href!));
    expect(tab).toBe("planes");
    expect(intent).toEqual({ kind: "new", fromBookingId: null, prefill: PREFILL, prefillInvalid: false });
  });
});

describe("prefill: zod + tope de 2 kB", () => {
  it("encode/decode simétricos", () => {
    const enc = encodePlanPrefill(PREFILL)!;
    expect(enc.length).toBeLessThanOrEqual(PLAN_PREFILL_MAX_CHARS);
    expect(decodePlanPrefill(enc)).toEqual(PREFILL);
  });

  it("> 2 kB → null sin decodificar; el prefill más grande posible entra holgado", () => {
    expect(decodePlanPrefill("A".repeat(PLAN_PREFILL_MAX_CHARS + 1))).toBeNull();
    const id = "x".repeat(64);
    const max: PlanEditorPrefill = {
      ...PREFILL,
      serviceId: id,
      practitionerId: id,
      locationId: id,
      templateId: id,
      fromBookingId: id,
      schedule: { v: 1, frequency: "weekly", everyNWeeks: 2, slots: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow: dow as 0, startMin: 1439 })) },
    };
    const enc = encodePlanPrefill(max);
    expect(enc).not.toBeNull();
    expect(enc!.length).toBeLessThan(PLAN_PREFILL_MAX_CHARS);
    expect(decodePlanPrefill(enc)).toEqual(max);
  });

  it("basura → null (base64 inválido, JSON roto, zod)", () => {
    expect(decodePlanPrefill("")).toBeNull();
    expect(decodePlanPrefill("%%%")).toBeNull();
    expect(decodePlanPrefill(btoa("{no json"))).toBeNull();
    const bad = btoa(JSON.stringify({ totalSessions: 999 })).replace(/=+$/, "");
    expect(decodePlanPrefill(bad)).toBeNull();
    const badSchedule = btoa(JSON.stringify({ schedule: { v: 1, frequency: "monthly", slots: [] } })).replace(/=+$/, "");
    expect(decodePlanPrefill(badSchedule)).toBeNull();
  });

  it("[P3-Z] `authorization` no viaja en el prefill: el código de la OS es texto libre (C10, §2.6)", () => {
    // Antes `PlanEditorPrefillSchema` aceptaba la autorización (código ≤ 64
    // caracteres libres) y un link la dejaba en la URL: historial, logs, Referer.
    const withAuth = {
      totalSessions: 8,
      authorization: { code: "OSDE 123456", authorizedSessions: 10, startsOnDayKey: "2026-10-01" },
    };
    const raw = btoa(JSON.stringify(withAuth)).replace(/=+$/, "");
    const decoded = decodePlanPrefill(raw);
    expect(decoded).toEqual({ totalSessions: 8 });
    expect(decoded && "authorization" in decoded).toBe(false);
    // Y al armar el link tampoco sale (se descarta antes de codificar).
    const enc = encodePlanPrefill(withAuth as unknown as PlanEditorPrefill)!;
    expect(atob(enc.replace(/-/g, "+").replace(/_/g, "/"))).not.toMatch(/OSDE|authorization/);
  });

  it("claves desconocidas y texto libre se descartan (sin PHI en la URL)", () => {
    const raw = btoa(JSON.stringify({ totalSessions: 8, title: "Lumbalgia", notes: "dolor", foo: 1 })).replace(/=+$/, "");
    expect(decodePlanPrefill(raw)).toEqual({ totalSessions: 8 });
  });

  it("encode rechaza un prefill inválido en vez de armar algo que el parser tira", () => {
    expect(encodePlanPrefill({ ...PREFILL, totalSessions: 0 })).toBeNull();
  });
});

describe("parseProfilePlanParams", () => {
  it("alias 'plan' → 'planes'", () => {
    expect(normalizeProfileTab("plan")).toBe("planes");
    expect(normalizeProfileTab("turnos")).toBe("turnos");
    expect(normalizeProfileTab(null)).toBeNull();
    expect(parseProfilePlanParams({ tab: "plan", programa: "prog1" })).toEqual({
      tab: "planes",
      intent: { kind: "program", programId: "prog1" },
    });
  });

  it("acepta el searchParams de una página (record, con arrays)", () => {
    expect(parseProfilePlanParams({ tab: ["planes", "x"], nuevo: "1", turno: ["bk1"] })).toEqual({
      tab: "planes",
      intent: { kind: "new", fromBookingId: "bk1", prefill: null, prefillInvalid: false },
    });
  });

  it("sin tab=planes no hay intención; programa gana sobre nuevo", () => {
    expect(parseProfilePlanParams({ tab: "turnos", programa: "prog1" }).intent).toEqual({ kind: "none" });
    expect(parseProfilePlanParams({ programa: "prog1" }).intent).toEqual({ kind: "none" });
    expect(parseProfilePlanParams({ tab: "planes" }).intent).toEqual({ kind: "none" });
    expect(parseProfilePlanParams({ tab: "planes", nuevo: "1", programa: "prog1" }).intent).toEqual({
      kind: "program",
      programId: "prog1",
    });
  });

  it("prefill roto → editor vacío con prefillInvalid; turno inválido → null", () => {
    expect(parseProfilePlanParams({ tab: "planes", nuevo: "1", prefill: "%%%", turno: "a b" }).intent).toEqual({
      kind: "new",
      fromBookingId: null,
      prefill: null,
      prefillInvalid: true,
    });
  });
});

describe("parseDiagnosisDeepLink / stripPlanIntentParams", () => {
  it("ids válidos o null", () => {
    expect(parseDiagnosisDeepLink(new URLSearchParams("patientId=pat1&bookingId=bk1"))).toEqual({
      patientId: "pat1",
      bookingId: "bk1",
    });
    expect(parseDiagnosisDeepLink({ patientId: "<script>" })).toEqual({ patientId: null, bookingId: null });
  });

  it("limpia la intención y conserva tab y el resto", () => {
    expect(stripPlanIntentParams("/pacientes/p1?tab=planes&nuevo=1&turno=b&prefill=abc&x=1")).toBe(
      "/pacientes/p1?tab=planes&x=1"
    );
    expect(stripPlanIntentParams("https://app.kinesoft.ar/pacientes/p1?tab=planes&programa=x#top")).toBe(
      "https://app.kinesoft.ar/pacientes/p1?tab=planes#top"
    );
  });
});
