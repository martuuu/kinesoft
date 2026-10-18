/**
 * HF-3 (plan §22.4, D-HF7) · pausa temporal de la 2FA del superadmin: `twoFactorBypassDecision` (puro) y su copy.
 *
 * Correr con TZ=UTC (AGENTS §3): el vencimiento es «hasta el fin de ese día AR», y en un host UTC el borde de las
 * 03:00 Z es justo donde un `toISOString().slice(0,10)` lo correría un día.
 */
import { describe, it, expect } from "vitest";
import {
  TWO_FACTOR_BYPASS_MAX_DAYS,
  formatBypassUntil,
  twoFactorBypassBandCopy,
  twoFactorBypassDecision,
  type TwoFactorBypassUser,
} from "@/lib/two-factor-bypass-logic";

const ME = "4f7c2a1e-9b3d-4c8e-a2f1-0d5e6b7c8a9f";
const OTHER = "test-user-otro";
const admin = (o: Partial<TwoFactorBypassUser> = {}): TwoFactorBypassUser => ({
  id: ME,
  isPlatformAdmin: true,
  disabledAt: null,
  ...o,
});
// 18-oct-2026 12:00 AR.
const NOW = new Date("2026-10-18T15:00:00Z");
const decide = (raw: string | undefined, o: { user?: TwoFactorBypassUser | null; now?: Date; enforcement?: "off" | "enforce" } = {}) =>
  twoFactorBypassDecision({
    raw,
    enforcement: o.enforcement ?? "off",
    user: o.user === undefined ? admin() : o.user,
    now: o.now ?? NOW,
  });

describe("[HF-3] parse: id propio y fecha vigente → activo; vencida, >30 días, mal formada o id ajeno → inactivo", () => {
  it("id propio y fecha vigente → activo, con la fecha", () => {
    expect(decide(`${ME}@2026-10-31`)).toEqual({ active: true, until: "2026-10-31" });
    // Vence hoy: vale hasta el fin del día AR.
    expect(decide(`${ME}@2026-10-18`)).toEqual({ active: true, until: "2026-10-18" });
  });

  it("lista separada por coma (con espacios y un salto de línea pegado en Vercel)", () => {
    expect(decide(` ${OTHER}@2026-10-20 , ${ME}@2026-10-25\n`)).toEqual({ active: true, until: "2026-10-25" });
    // El mismo id dos veces: manda la fecha más cercana (falla cerrado).
    expect(decide(`${ME}@2026-11-01,${ME}@2026-10-22`)).toEqual({ active: true, until: "2026-10-22" });
  });

  it("borde de día AR en un host UTC: el 31/10 vale hasta las 23:59 AR (02:59 Z del 01/11)", () => {
    expect(decide(`${ME}@2026-10-31`, { now: new Date("2026-11-01T02:59:59Z") })).toMatchObject({ active: true });
    expect(decide(`${ME}@2026-10-31`, { now: new Date("2026-11-01T03:00:00Z") })).toEqual({ active: false, reason: "expired" });
    // Y a la inversa: el 18/10 a las 22:00 AR ya es 19/10 en UTC, pero en AR sigue siendo hoy.
    expect(decide(`${ME}@2026-10-18`, { now: new Date("2026-10-19T01:00:00Z") })).toMatchObject({ active: true });
  });

  it("vencida → inactivo", () => {
    expect(decide(`${ME}@2026-10-17`)).toEqual({ active: false, reason: "expired" });
  });

  it(`más de ${TWO_FACTOR_BYPASS_MAX_DAYS} días → inactivo (se ignora); justo ${TWO_FACTOR_BYPASS_MAX_DAYS} → activo`, () => {
    expect(TWO_FACTOR_BYPASS_MAX_DAYS).toBe(30);
    expect(decide(`${ME}@2026-11-17`)).toEqual({ active: true, until: "2026-11-17" });
    expect(decide(`${ME}@2026-11-18`)).toEqual({ active: false, reason: "too_far" });
    expect(decide(`${ME}@2027-10-18`)).toEqual({ active: false, reason: "too_far" });
  });

  it("mal formada → inactivo (toda la variable: un error de tipeo no habilita nada)", () => {
    for (const raw of [
      "si",
      ME,
      `${ME}@`,
      `@2026-10-31`,
      `${ME}@31/10/2026`,
      `${ME}@2026-13-01`,
      `${ME}@2026-02-30`,
      `${ME}@2026-10-31T23:59`,
      `"${ME}@2026-10-31"`,
      `${ME} 2026-10-31`,
      `${ME}@2026-10-31@2026-10-30`,
      `${ME}@2026-10-31;${OTHER}@2026-10-31`,
      `${ME}@2026-10-31,no-valida`,
    ]) {
      expect(decide(raw), raw).toEqual({ active: false, reason: "malformed" });
    }
  });

  it("vacía o sin setear → inactivo sin motivo de alarma", () => {
    expect(decide(undefined)).toEqual({ active: false, reason: "unset" });
    expect(decide("")).toEqual({ active: false, reason: "unset" });
    expect(decide("  \n")).toEqual({ active: false, reason: "unset" });
  });

  it("id ajeno → inactivo", () => {
    expect(decide(`${OTHER}@2026-10-31`)).toEqual({ active: false, reason: "not_listed" });
    // Prefijo o sufijo del id no es el id.
    expect(decide(`${ME.slice(0, 8)}@2026-10-31`)).toEqual({ active: false, reason: "not_listed" });
  });

  it("[HF-3] no-superadmin con su id en la lista → sin efecto; superadmin deshabilitado o sin perfil → sin efecto", () => {
    expect(decide(`${ME}@2026-10-31`, { user: admin({ isPlatformAdmin: false }) })).toEqual({ active: false, reason: "not_superadmin" });
    expect(decide(`${ME}@2026-10-31`, { user: admin({ disabledAt: new Date("2026-10-01T00:00:00Z") }) })).toEqual({
      active: false,
      reason: "not_superadmin",
    });
    expect(decide(`${ME}@2026-10-31`, { user: null })).toEqual({ active: false, reason: "not_superadmin" });
  });

  it("[HF-3] con enforce el bypass no aplica", () => {
    expect(decide(`${ME}@2026-10-31`, { enforcement: "enforce" })).toEqual({ active: false, reason: "enforce" });
  });
});

describe("[HF-3] copy de la banda", () => {
  it("fecha en formato AR (dd/MM) y el texto fijo", () => {
    expect(formatBypassUntil("2026-10-31")).toBe("31/10");
    expect(formatBypassUntil("2026-11-05")).toBe("05/11");
    expect(twoFactorBypassBandCopy("2026-10-31")).toBe(
      "La verificación en dos pasos está en pausa para tu usuario hasta el 31/10. Volvé a activarla antes de esa fecha."
    );
  });
});
