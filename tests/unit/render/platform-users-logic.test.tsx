import { describe, it, expect } from "vitest";
import {
  accessLinkBlockReason,
  accessLinkMessage,
  authStateLines,
  buildUsersHref,
  canOfferEmailSync,
  formatDateTimeAR,
  membershipNeedsPractitioner,
  membershipRoleLabel,
  membershipStatusLabel,
  parseUsersQuery,
  rowTenantsSummary,
  superadminConfirmReady,
  toggleMessage,
} from "@/components/plataforma/users/users-logic";

/**
 * [BO3-D] Lógica pura de presentación del directorio de usuarios de /plataforma. Corre en TZ=UTC y TZ=AR (el
 * último ingreso se muestra siempre en hora AR).
 */
describe("[BO3-D] users-logic · query y URL", () => {
  it("parsea searchParams y cae al default con valores inválidos", () => {
    expect(parseUsersQuery({})).toEqual({ q: "", kind: "all", page: 1 });
    expect(parseUsersQuery({ q: "  ana@x.com ", kind: "portal", page: "3" })).toEqual({ q: "ana@x.com", kind: "portal", page: 3 });
    expect(parseUsersQuery({ kind: "admin", page: "-2" })).toEqual({ q: "", kind: "all", page: 1 });
    expect(parseUsersQuery({ kind: ["team", "portal"], page: "1.5" })).toEqual({ q: "", kind: "team", page: 1 });
  });

  it("arma la URL sin keys vacías, sin kind=all ni page=1", () => {
    expect(buildUsersHref({ q: "", kind: "all" })).toBe("/plataforma/usuarios");
    expect(buildUsersHref({ q: " ana ", kind: "team" }, 2)).toBe("/plataforma/usuarios?q=ana&kind=team&page=2");
    expect(buildUsersHref({ q: "a+b@x.com", kind: "all" }, 1)).toBe("/plataforma/usuarios?q=a%2Bb%40x.com");
  });
});

describe("[BO3-D] users-logic · PHI de portal", () => {
  it("de portal solo dice el conteo; de equipo, cuántas membresías", () => {
    expect(rowTenantsSummary({ membershipCount: 0, portalLinkCount: 1, isPlatformAdmin: false })).toBe("Paciente en 1 consultorio");
    expect(rowTenantsSummary({ membershipCount: 0, portalLinkCount: 3, isPlatformAdmin: false })).toBe("Paciente en 3 consultorios");
    expect(rowTenantsSummary({ membershipCount: 2, portalLinkCount: 1, isPlatformAdmin: false })).toBe(
      "Equipo en 2 consultorios · Paciente en 1 consultorio"
    );
    expect(rowTenantsSummary({ membershipCount: 0, portalLinkCount: 0, isPlatformAdmin: true })).toBe("Solo Plataforma");
    expect(rowTenantsSummary({ membershipCount: 0, portalLinkCount: 0, isPlatformAdmin: false })).toBe("Ninguno");
  });
});

describe("[BO3-D] users-logic · detalle", () => {
  it("estado de la membresía", () => {
    expect(membershipStatusLabel({ accepted: false, suspended: false })).toBe("Invitación pendiente");
    expect(membershipStatusLabel({ accepted: true, suspended: true })).toBe("Suspendida");
    expect(membershipStatusLabel({ accepted: true, suspended: false })).toBe("Activa");
  });

  it("[BO3 integrador] rótulo del rol con la vertical del consultorio", () => {
    expect(membershipRoleLabel("PRACTITIONER", "GENERAL")).toBe("Profesional");
    expect(membershipRoleLabel("PRACTITIONER", "KINESIOLOGY")).toBe("Kinesiólogo/a");
    expect(membershipRoleLabel("OWNER", "GENERAL")).toBe("Titular");
  });

  it("solo los roles clínicos aceptados y activos necesitan profesional", () => {
    const base = { accepted: true, suspended: false, hasPractitioner: false };
    expect(membershipNeedsPractitioner({ ...base, role: "PRACTITIONER" })).toBe(true);
    expect(membershipNeedsPractitioner({ ...base, role: "ASSISTANT" })).toBe(false);
    expect(membershipNeedsPractitioner({ ...base, role: "OWNER", hasPractitioner: true })).toBe(false);
    expect(membershipNeedsPractitioner({ ...base, role: "ADMIN", accepted: false })).toBe(false);
  });

  it("último ingreso en hora AR, sin depender del TZ del host", () => {
    // 02:30 UTC del 15-oct = 23:30 AR del 14-oct.
    expect(formatDateTimeAR("2026-10-15T02:30:00.000Z")).toMatch(/14.*oct.*2026.*23:30/);
    expect(formatDateTimeAR(null)).toBe("");
    expect(formatDateTimeAR("nope")).toBe("");
  });

  it("renglones de Auth: ok, missing y unavailable", () => {
    const ok = authStateLines({ status: "ok", email: "b@x.com", emailConfirmed: false, lastSignInAt: null, banned: true, emailMismatch: true });
    expect(ok.map((l) => [l.label, l.value])).toEqual([
      ["Email confirmado", "No"],
      ["Último ingreso", "Nunca entró"],
      ["Bloqueada", "Sí"],
      ["Email en el servicio de acceso", "Distinto: b@x.com"],
    ]);
    expect(authStateLines({ status: "missing" })[0].tone).toBe("warn");
    expect(authStateLines({ status: "unavailable" })[0].value).toMatch(/No pudimos consultarla/);
  });

  it("sincronizar email solo si Auth respondió y difiere", () => {
    expect(canOfferEmailSync({ status: "ok", email: "b@x.com", emailConfirmed: true, lastSignInAt: null, banned: false, emailMismatch: true })).toBe(true);
    expect(canOfferEmailSync({ status: "ok", email: "a@x.com", emailConfirmed: true, lastSignInAt: null, banned: false, emailMismatch: false })).toBe(false);
    expect(canOfferEmailSync({ status: "unavailable" })).toBe(false);
  });

  it("link de acceso: mismos cortes que el server", () => {
    const okAuth = { status: "ok" as const, email: "a@x.com", emailConfirmed: true, lastSignInAt: null, banned: false, emailMismatch: false };
    expect(accessLinkBlockReason({ disabled: false, auth: okAuth })).toBeNull();
    expect(accessLinkBlockReason({ disabled: true, auth: okAuth })).toMatch(/deshabilitado/);
    expect(accessLinkBlockReason({ disabled: false, auth: { status: "missing" } })).toMatch(/No tiene cuenta/);
    expect(accessLinkBlockReason({ disabled: false, auth: { ...okAuth, emailMismatch: true } })).toMatch(/sincronizá/);
    // Auth caído no bloquea: el server responde con su propio error.
    expect(accessLinkBlockReason({ disabled: false, auth: { status: "unavailable" } })).toBeNull();
  });
});

describe("[BO3-D] users-logic · resultados", () => {
  it("mail enviado: «Le mandamos el mail» y nunca el link", () => {
    const m = accessLinkMessage({ purpose: "activation", emailSent: true, emailStatus: "sent", copyUrl: null });
    expect(m).toMatchObject({ tone: "success", title: "Le mandamos el mail" });
  });

  it("mail no salido con link: aviso para copiarlo; bloqueado sin link: aviso de config", () => {
    expect(accessLinkMessage({ purpose: "recovery", emailSent: false, emailStatus: "skipped", copyUrl: "https://x/l" }).description).toMatch(/Copiá el link/);
    expect(accessLinkMessage({ purpose: "recovery", emailSent: false, emailStatus: "blocked", copyUrl: null }).description).toMatch(/bloqueado/);
  });

  it("Auth sin sincronizar pide reintentar", () => {
    expect(toggleMessage({ changed: true, authSynced: false }, true)).toMatchObject({ tone: "warning" });
    expect(toggleMessage({ changed: true, authSynced: false }, true).description).toMatch(/Reintentá/);
    expect(toggleMessage({ changed: true, authSynced: true }, true).title).toBe("Usuario deshabilitado");
    expect(toggleMessage({ changed: false, authSynced: true }, false).title).toBe("Ya estaba habilitado");
  });

  it("confirmación de superadmin: email exacto normalizado", () => {
    expect(superadminConfirmReady("", "ana@x.com")).toBe(false);
    expect(superadminConfirmReady("ana@x.co", "ana@x.com")).toBe(false);
    expect(superadminConfirmReady("  ANA@x.com ", "ana@x.com")).toBe(true);
  });
});
