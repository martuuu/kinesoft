/**
 * A3c-S-signup — lógica pura del guard de la app, del stepper y del slug.
 */
import { describe, it, expect } from "vitest";
import {
  decideAppGate,
  deriveResumeStep,
  isValidSlug,
  pickFreeSlug,
  resolveStep,
  slugify,
  type AppGateInput,
  type OnboardingProgress,
} from "@/lib/onboarding-logic";

const gate = (p: Partial<AppGateInput>) =>
  decideAppGate({ hasSession: false, hasActor: false, role: null, onboardingCompleted: false, nextPath: null, ...p });

describe("decideAppGate", () => {
  it("sin sesión → /login, con next si hay path", () => {
    expect(gate({})).toBe("/login");
    expect(gate({ nextPath: "/agenda?d=2026-10-01" })).toBe("/login?next=%2Fagenda%3Fd%3D2026-10-01");
    // /dashboard es el default del login: no hace falta ensuciar la URL.
    expect(gate({ nextPath: "/dashboard" })).toBe("/login");
  });

  it("sesión verificada sin membresía → /onboarding (no /login: era un loop)", () => {
    expect(gate({ hasSession: true })).toBe("/onboarding");
  });

  it("OWNER con el alta sin terminar → /onboarding", () => {
    expect(gate({ hasSession: true, hasActor: true, role: "OWNER", onboardingCompleted: false })).toBe("/onboarding");
  });

  it("un miembro no-OWNER entra aunque el dueño no haya terminado el alta", () => {
    for (const role of ["ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]) {
      expect(gate({ hasSession: true, hasActor: true, role, onboardingCompleted: false })).toBeNull();
    }
  });

  it("alta completa → renderiza la app", () => {
    expect(gate({ hasSession: true, hasActor: true, role: "OWNER", onboardingCompleted: true })).toBeNull();
  });
});

const prog = (p: Partial<OnboardingProgress>): OnboardingProgress => ({
  hasTenant: true,
  servicesCount: 0,
  insurersCount: 0,
  invitationsCount: 0,
  ...p,
});

describe("deriveResumeStep / resolveStep", () => {
  it("retoma según lo cargado", () => {
    expect(deriveResumeStep(prog({ hasTenant: false }))).toBe(2);
    expect(deriveResumeStep(prog({}))).toBe(3);
    expect(deriveResumeStep(prog({ servicesCount: 2 }))).toBe(5);
    expect(deriveResumeStep(prog({ servicesCount: 2, insurersCount: 1 }))).toBe(6);
    expect(deriveResumeStep(prog({ servicesCount: 2, invitationsCount: 1 }))).toBe(7);
  });

  it("sin tenant solo existe el paso 2", () => {
    for (const s of ["3", "5", "7"]) expect(resolveStep(s, prog({ hasTenant: false }))).toBe(2);
  });

  it("sin servicios no se pasa del 4", () => {
    expect(resolveStep("7", prog({}))).toBe(4);
    expect(resolveStep("4", prog({}))).toBe(4);
    expect(resolveStep("2", prog({}))).toBe(2);
  });

  it("step inválido o fuera de rango → el paso derivado", () => {
    for (const s of [undefined, null, "", "abc", "1", "8", "2.5"]) {
      expect(resolveStep(s, prog({ servicesCount: 1 }))).toBe(5);
    }
  });

  it("con servicios se puede volver a cualquier paso", () => {
    for (const n of [2, 3, 4, 5, 6, 7]) expect(resolveStep(String(n), prog({ servicesCount: 1 }))).toBe(n);
  });
});

describe("slug", () => {
  it("slugify normaliza acentos, espacios y símbolos", () => {
    expect(slugify("Centro Kinésico Movare")).toBe("centro-kinesico-movare");
    expect(slugify("  Ñandú & Cía.  ")).toBe("nandu-cia");
  });

  it("slugify nunca devuelve algo inválido ni reservado", () => {
    for (const n of ["!!", "🙂", "ab", "Agenda", "login", "x".repeat(80)]) {
      const s = slugify(n);
      expect(isValidSlug(s), `${n} → ${s}`).toBe(true);
    }
  });

  it("pickFreeSlug agrega sufijo y respeta el largo máximo", () => {
    expect(pickFreeSlug("movare", [])).toBe("movare");
    expect(pickFreeSlug("movare", ["movare"])).toBe("movare-2");
    expect(pickFreeSlug("movare", ["movare", "movare-2", "movare-3"])).toBe("movare-4");
    const long = "a".repeat(40);
    const s = pickFreeSlug(long, [long]);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(isValidSlug(s)).toBe(true);
  });
});
