/**
 * PL-2a · `/verificar-acceso` sin bucle (app/verificar-acceso/verify-access-logic.ts, puro). El gate de la app
 * (`decideAppGate`) manda acá con `?next=`; esta pantalla solo vuelve a `next` cuando la 2FA ya no está pendiente,
 * y `next` nunca puede ser ella misma ni el login.
 */
import { describe, it, expect } from "vitest";
import {
  verifyAccessDecision,
  verifyAccessFallback,
  verifyAccessHref,
  verifyAccessNext,
} from "@/app/verificar-acceso/verify-access-logic";
import { decideAppGate } from "@/lib/onboarding-logic";
import { safeNext } from "@/lib/safe-next";
import type { TwoFactorState } from "@/lib/two-factor-logic";

describe("[PL-2a] /verificar-acceso", () => {
  it("next: propio y saneado; las pantallas del bucle caen al destino por defecto", () => {
    expect(verifyAccessNext(safeNext("/agenda?d=1", ""), "/dashboard")).toBe("/agenda?d=1");
    for (const bad of ["", "/verificar-acceso", "/verificar-acceso?next=/agenda", "/login?next=/x", "/api/auth/sign-out"]) {
      expect(verifyAccessNext(safeNext(bad, ""), "/dashboard")).toBe("/dashboard");
    }
    for (const evil of ["https://evil.com", "//evil.com", "/\\evil.com"]) {
      expect(verifyAccessNext(safeNext(evil, ""), "/dashboard")).toBe("/dashboard");
    }
  });

  it("destino por defecto: superadmin sin consultorio → /plataforma", () => {
    expect(verifyAccessFallback({ isPlatformAdmin: true, hasUsableMembership: false })).toBe("/plataforma");
    expect(verifyAccessFallback({ isPlatformAdmin: true, hasUsableMembership: true })).toBe("/dashboard");
    expect(verifyAccessFallback({ isPlatformAdmin: false, hasUsableMembership: false })).toBe("/dashboard");
  });

  it("decisión por estado", () => {
    const base = { hasSession: true, disabled: false, next: "/agenda" };
    expect(verifyAccessDecision({ ...base, state: "required" })).toEqual({ kind: "render" });
    expect(verifyAccessDecision({ ...base, state: "satisfied" })).toEqual({ kind: "redirect", to: "/agenda" });
    expect(verifyAccessDecision({ ...base, state: "not_enabled" })).toEqual({ kind: "redirect", to: "/agenda" });
    expect(verifyAccessDecision({ ...base, disabled: true, state: "required" })).toEqual({ kind: "redirect", to: "/cuenta-desactivada" });
    expect(verifyAccessDecision({ ...base, hasSession: false, state: null })).toEqual({
      kind: "redirect",
      to: `/login?next=${encodeURIComponent(verifyAccessHref("/agenda"))}`,
    });
  });

  it("sin bucle: gate de la app → /verificar-acceso → (2FA pasada) next, que el gate deja pasar", () => {
    const states: TwoFactorState[] = ["required", "satisfied", "not_enabled"];
    for (const state of states) {
      const gate = decideAppGate({
        hasSession: true,
        hasActor: state !== "required",
        access: { kind: "ok", tenantId: "t1" },
        needsChoice: false,
        role: "OWNER",
        onboardingCompleted: true,
        nextPath: "/agenda",
        block: null,
        twoFactorRequired: state === "required",
      } as Parameters<typeof decideAppGate>[0]);
      if (state !== "required") {
        expect(gate).toBeNull();
        continue;
      }
      expect(gate).toBe("/verificar-acceso?next=%2Fagenda");
      const next = verifyAccessNext(safeNext(new URL(gate!, "http://x").searchParams.get("next"), ""), "/dashboard");
      // Pendiente: se queda acá (render), nunca redirige a sí misma.
      expect(verifyAccessDecision({ hasSession: true, disabled: false, state, next })).toEqual({ kind: "render" });
      // Pasada la 2FA: va a next, y next ya no manda de vuelta.
      const after = verifyAccessDecision({ hasSession: true, disabled: false, state: "satisfied", next });
      expect(after).toEqual({ kind: "redirect", to: "/agenda" });
      expect(after.kind === "redirect" && after.to.startsWith("/verificar-acceso")).toBe(false);
    }
  });
});
