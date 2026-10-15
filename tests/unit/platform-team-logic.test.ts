import { describe, it, expect } from "vitest";
import {
  ASSIGNABLE_ROLES,
  OWNER_LOCKED_REASON,
  emailStatusLabel,
  formatARDate,
  formatARDateTime,
  invitationStatusLabel,
  memberActions,
  memberDisplayName,
  seatsSummary,
  shouldOfferCopyLink,
  transferConfirmMatches,
} from "@/components/plataforma/team/team-logic";

/** [BO3-C] Lógica pura del panel de equipo de Plataforma: espejo de las reglas de `lib/team-internal.ts`. */
const joined = new Date("2026-09-01T12:00:00Z");

describe("[BO3-C] memberActions", () => {
  it("el OWNER no cambia de rol, no se suspende ni se quita: apagado con el porqué", () => {
    const a = memberActions({ role: "OWNER", disabledAt: null, joinedAt: joined });
    expect(a.changeRole).toEqual({ enabled: false, reason: OWNER_LOCKED_REASON });
    expect(a.suspend).toEqual({ enabled: false, reason: OWNER_LOCKED_REASON });
    expect(a.remove).toEqual({ enabled: false, reason: OWNER_LOCKED_REASON });
    expect(a.transfer).toBeNull();
    expect(a.reactivate).toBeNull();
    expect(a.passwordReset).toEqual({ enabled: true });
  });

  it("un miembro activo que aceptó: todo habilitado salvo reactivar (no se muestra)", () => {
    const a = memberActions({ role: "ASSISTANT", disabledAt: null, joinedAt: joined });
    expect(a.changeRole?.enabled).toBe(true);
    expect(a.transfer?.enabled).toBe(true);
    expect(a.suspend?.enabled).toBe(true);
    expect(a.remove?.enabled).toBe(true);
    expect(a.passwordReset?.enabled).toBe(true);
    expect(a.reactivate).toBeNull();
  });

  it("suspendido: reactivar sí; suspender no se muestra; ni transferir ni link de contraseña", () => {
    const a = memberActions({ role: "PRACTITIONER", disabledAt: joined, joinedAt: joined });
    expect(a.reactivate).toEqual({ enabled: true });
    expect(a.suspend).toBeNull();
    expect(a.transfer?.enabled).toBe(false);
    expect(a.transfer?.reason).toMatch(/suspendido/);
    expect(a.passwordReset?.enabled).toBe(false);
    expect(a.remove?.enabled).toBe(true);
  });

  it("membresía sin aceptar: no se le transfiere la titularidad", () => {
    const a = memberActions({ role: "ADMIN", disabledAt: null, joinedAt: null });
    expect(a.transfer?.enabled).toBe(false);
    expect(a.transfer?.reason).toMatch(/no aceptó/);
  });

  it("el selector de rol nunca ofrece OWNER", () => {
    expect(ASSIGNABLE_ROLES).toEqual(["ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]);
  });
});

describe("[BO3-C] transferConfirmMatches", () => {
  it("hay que tipear el email exacto (sin distinguir mayúsculas ni espacios de los bordes)", () => {
    expect(transferConfirmMatches("", "ana@x.test")).toBe(false);
    expect(transferConfirmMatches("ana@x.tes", "ana@x.test")).toBe(false);
    expect(transferConfirmMatches("otra@x.test", "ana@x.test")).toBe(false);
    expect(transferConfirmMatches("  ANA@x.test ", "ana@x.test")).toBe(true);
  });
});

describe("[PL-1c] seatsSummary (cupos por tipo)", () => {
  const c = (used: number, limit: number | null) => ({
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    full: limit !== null && used >= limit,
  });
  it("con topes: los tres contadores, sin aviso de lleno", () => {
    const s = seatsSummary({ total: c(2, 5), professional: c(2, 4), staff: c(0, 1) });
    expect(s.text).toBe("Profesionales 2 de 4 · Secretaría/administración 0 de 1 · Total 2 de 5");
    expect(s.full).toBe(false);
    expect(s.hint).toMatch(/cada uno en su tipo/);
    expect(s.hint).not.toMatch(/Cupo lleno/);
  });
  it("lleno por total: avisa", () => {
    const s = seatsSummary({ total: c(5, 5), professional: c(5, null), staff: c(0, null) });
    expect(s.full).toBe(true);
    expect(s.hint).toMatch(/^Cupo lleno/);
  });
  it("lleno por tipo: avisa aunque sobre total", () => {
    expect(seatsSummary({ total: c(2, 5), professional: c(1, 4), staff: c(1, 1) }).full).toBe(true);
  });
  it("sin tope", () => {
    expect(seatsSummary({ total: c(5, null), professional: c(4, null), staff: c(1, null) }).text).toBe(
      "Profesionales 4 (sin tope) · Secretaría/administración 1 (sin tope) · Total 5 (sin tope)"
    );
  });
});

describe("[BO3-C] rótulos", () => {
  it("estado de invitación y del mail", () => {
    expect(invitationStatusLabel({ status: "pending" })).toBe("Pendiente");
    expect(invitationStatusLabel({ status: "expired" })).toBe("Vencida");
    expect(emailStatusLabel("sent")).toEqual({ text: "Mail enviado", tone: "ok" });
    expect(emailStatusLabel("failed").tone).toBe("error");
    expect(emailStatusLabel("skipped").tone).toBe("warn");
    expect(emailStatusLabel(null).text).toBe("Sin registro de mail");
  });
  it("[DIR-0] nombre a mostrar: sin nombre es «Usuario sin nombre», nunca el email", () => {
    // DIR-0: sin nombre nunca cae al email.
    expect(memberDisplayName({ fullName: "  ", email: "a@x.test" })).toBe("Usuario sin nombre");
    expect(memberDisplayName({ fullName: "Ana", email: "a@x.test" })).toBe("Ana");
  });
  it("link copiable solo si el mail no salió y hay URL", () => {
    expect(shouldOfferCopyLink({ emailSent: false, url: "https://x/invite/t" })).toBe(true);
    expect(shouldOfferCopyLink({ emailSent: true, url: "https://x/invite/t" })).toBe(false);
    expect(shouldOfferCopyLink({ emailSent: false, url: null })).toBe(false);
  });
  it("fechas en hora argentina aunque el host esté en UTC", () => {
    // 01:30 UTC del 15 = 22:30 del 14 en AR.
    const d = new Date("2026-10-15T01:30:00Z");
    expect(formatARDate(d)).toBe("14/10/2026");
    expect(formatARDateTime(d)).toBe("14/10/2026 22:30");
  });
});
