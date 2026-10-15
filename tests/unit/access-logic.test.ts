/**
 * [IAM-0c] Lógica pura de acceso (C-IAM2). Expresa como casos puros el bucle
 * de redirecciones de §19.1: hoy `buildActor` (lib/session.ts) elige la
 * membresía por `invitedAt desc` y, si en ESE consultorio no hay
 * `Practitioner`, tira `no_membership` aunque el usuario tenga otro
 * consultorio usable → layout → /onboarding → «done» → /dashboard → …
 *
 * Estas funciones todavía no las consume nadie (IAM-3a las enchufa en
 * `buildActor`); los casos fijan el comportamiento que va a tener.
 */
import { describe, it, expect } from "vitest";
import {
  isUsableMembership,
  chooseActiveTenant,
  resolveAccessState,
  invitationStatus,
  canSafelyDeleteAuthUser,
  type MembershipLite,
} from "@/lib/access-logic";

const d = (iso: string) => new Date(iso);

const m = (over: Partial<MembershipLite> & { tenantId: string }): MembershipLite => ({
  role: "PRACTITIONER",
  acceptedAt: d("2026-09-01T12:00:00Z"),
  disabledAt: null,
  hasPractitioner: true,
  ...over,
});

const NO_PREF = { cookieTenantId: null, preferredTenantId: null };

describe("[IAM-0c] isUsableMembership", () => {
  it("aceptada, habilitada y con Practitioner → usable", () => {
    expect(isUsableMembership(m({ tenantId: "A" }))).toBe(true);
  });
  it("sin aceptar → no usable", () => {
    expect(isUsableMembership(m({ tenantId: "A", acceptedAt: null }))).toBe(false);
  });
  it("deshabilitada → no usable", () => {
    expect(isUsableMembership(m({ tenantId: "A", disabledAt: d("2026-10-01T00:00:00Z") }))).toBe(false);
  });
  it("disabledAt ausente (la columna todavía no existe) cuenta como habilitada", () => {
    const { disabledAt: _omit, ...rest } = m({ tenantId: "A" });
    expect(isUsableMembership(rest)).toBe(true);
  });
  it("sin Practitioner, con practitionerForAllRoles = true (antes de IAM-4a) → no usable para NINGÚN rol", () => {
    for (const role of ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"] as const) {
      expect(isUsableMembership(m({ tenantId: "A", role, hasPractitioner: false }), { practitionerForAllRoles: true })).toBe(false);
    }
  });
  it("[IAM-4a] por defecto (PRACTITIONER_FOR_ALL_ROLES = false): Secretaria, Facturación y Administrador/a usables sin Practitioner; los clínicos no", () => {
    // PL-Z M1: el Administrador/a nunca atiende (§20.17), aunque la fila diga `clinical = true`: no necesita Practitioner.
    for (const role of ["ASSISTANT", "BILLING", "ADMIN"] as const) {
      expect(isUsableMembership(m({ tenantId: "A", role, hasPractitioner: false }))).toBe(true);
    }
    for (const role of ["OWNER", "PRACTITIONER"] as const) {
      expect(isUsableMembership(m({ tenantId: "A", role, hasPractitioner: false }))).toBe(false);
    }
  });
  it("con practitionerForAllRoles = false: los no clínicos entran sin Practitioner; los clínicos no", () => {
    const opts = { practitionerForAllRoles: false };
    expect(isUsableMembership(m({ tenantId: "A", role: "ASSISTANT", hasPractitioner: false }), opts)).toBe(true);
    expect(isUsableMembership(m({ tenantId: "A", role: "BILLING", hasPractitioner: false }), opts)).toBe(true);
    expect(isUsableMembership(m({ tenantId: "A", role: "PRACTITIONER", hasPractitioner: false }), opts)).toBe(false);
    expect(isUsableMembership(m({ tenantId: "A", role: "OWNER", hasPractitioner: false }), opts)).toBe(false);
    // PL-Z M1: el Administrador/a no atiende → entra sin Practitioner.
    expect(isUsableMembership(m({ tenantId: "A", role: "ADMIN", hasPractitioner: false }), opts)).toBe(true);
  });
});

describe("[IAM-0c] chooseActiveTenant / resolveAccessState: el bucle de §19.1", () => {
  // Kine de A que acepta B: el Practitioner es único global (schema.prisma,
  // `userId @unique`) y queda en A; B se acepta más tarde y SIN Practitioner.
  // Hoy buildActor elige B (invitada más reciente) y tira → bucle.
  const kineAAceptaB = [
    m({ tenantId: "A", acceptedAt: d("2026-08-01T12:00:00Z"), hasPractitioner: true }),
    m({ tenantId: "B", acceptedAt: d("2026-10-10T12:00:00Z"), hasPractitioner: false }),
  ];

  it("kine de A que acepta B: B no es usable y se elige A", () => {
    expect(chooseActiveTenant(kineAAceptaB, NO_PREF)).toBe("A");
    expect(resolveAccessState(kineAAceptaB, NO_PREF)).toEqual({ kind: "ok", tenantId: "A" });
  });

  it("kine de A que acepta B, con la cookie apuntando a B (no usable) → se ignora y va a A", () => {
    const pref = { cookieTenantId: "B", preferredTenantId: null };
    expect(chooseActiveTenant(kineAAceptaB, pref)).toBe("A");
    expect(resolveAccessState(kineAAceptaB, pref)).toEqual({ kind: "ok", tenantId: "A" });
  });

  it("kine de A que acepta B como Secretario/a (IAM-4a apagó practitionerForAllRoles): B ya es usable", () => {
    const ms = [kineAAceptaB[0], { ...kineAAceptaB[1], role: "ASSISTANT" as const }];
    expect(chooseActiveTenant(ms, NO_PREF)).toBe("B");
    expect(chooseActiveTenant(ms, NO_PREF, { practitionerForAllRoles: false })).toBe("B");
    // …pero como kinesiólogo/a en B sigue sin Practitioner: A.
    expect(chooseActiveTenant(kineAAceptaB, NO_PREF, { practitionerForAllRoles: false })).toBe("A");
  });

  it("removido sin membresías → needs_onboarding (no el callejón «escribinos a soporte»)", () => {
    expect(chooseActiveTenant([], NO_PREF)).toBeNull();
    expect(resolveAccessState([], NO_PREF)).toEqual({ kind: "needs_onboarding" });
  });

  it("solo invitaciones (Invitation) sin membresía → needs_onboarding: /onboarding ya ofrece las invitaciones", () => {
    // resolveAccessState solo ve membresías; una Invitation pendiente no crea
    // Membership hasta aceptarse. Es el mismo caso que «ninguna membresía».
    expect(resolveAccessState([], { cookieTenantId: "X", preferredTenantId: "Y" })).toEqual({
      kind: "needs_onboarding",
    });
  });

  it("solo membresías sin aceptar → no_access / pending_only", () => {
    const ms = [m({ tenantId: "A", acceptedAt: null }), m({ tenantId: "B", acceptedAt: null })];
    expect(chooseActiveTenant(ms, NO_PREF)).toBeNull();
    expect(resolveAccessState(ms, NO_PREF)).toEqual({ kind: "no_access", reason: "pending_only" });
  });

  it("todo deshabilitado → no_access / all_disabled", () => {
    const off = d("2026-10-01T00:00:00Z");
    const ms = [m({ tenantId: "A", disabledAt: off }), m({ tenantId: "B", disabledAt: off, hasPractitioner: false })];
    expect(resolveAccessState(ms, NO_PREF)).toEqual({ kind: "no_access", reason: "all_disabled" });
  });

  it("deshabilitado + pendiente (nada aceptado y habilitado) → all_disabled", () => {
    const ms = [m({ tenantId: "A", disabledAt: d("2026-10-01T00:00:00Z") }), m({ tenantId: "B", acceptedAt: null })];
    expect(resolveAccessState(ms, NO_PREF)).toEqual({ kind: "no_access", reason: "all_disabled" });
  });

  it("aceptada y habilitada pero sin Practitioner (y nada más) → no_access / missing_practitioner", () => {
    const ms = [m({ tenantId: "B", hasPractitioner: false })];
    expect(resolveAccessState(ms, NO_PREF)).toEqual({ kind: "no_access", reason: "missing_practitioner" });
  });

  it("missing_practitioner gana sobre all_disabled cuando hay de los dos (es lo reparable)", () => {
    const ms = [
      m({ tenantId: "A", disabledAt: d("2026-10-01T00:00:00Z") }),
      m({ tenantId: "B", hasPractitioner: false }),
    ];
    expect(resolveAccessState(ms, NO_PREF)).toEqual({ kind: "no_access", reason: "missing_practitioner" });
  });
});

describe("[IAM-0c] chooseActiveTenant: preferencias y desempate", () => {
  const ms = [
    m({ tenantId: "A", acceptedAt: d("2026-08-01T12:00:00Z") }),
    m({ tenantId: "B", acceptedAt: d("2026-10-10T12:00:00Z") }),
    m({ tenantId: "C", acceptedAt: d("2026-09-15T12:00:00Z") }),
  ];

  it("sin preferencias: la usable con acceptedAt más reciente", () => {
    expect(chooseActiveTenant(ms, NO_PREF)).toBe("B");
    expect(chooseActiveTenant(ms, {})).toBe("B");
  });

  it("el orden de entrada no importa (no depende de invitedAt ni del orderBy de la query)", () => {
    expect(chooseActiveTenant([...ms].reverse(), NO_PREF)).toBe("B");
  });

  it("cookie usable gana", () => {
    expect(chooseActiveTenant(ms, { cookieTenantId: "A", preferredTenantId: "C" })).toBe("A");
  });

  it("cookie ajena (un consultorio del que no es miembro) se ignora → preferred", () => {
    expect(chooseActiveTenant(ms, { cookieTenantId: "ZZZ", preferredTenantId: "C" })).toBe("C");
  });

  it("cookie ajena sin preferred → la más reciente", () => {
    expect(chooseActiveTenant(ms, { cookieTenantId: "ZZZ" })).toBe("B");
  });

  it("preferred no usable (deshabilitada) se ignora → la más reciente usable", () => {
    const withDisabled = ms.map((x) => (x.tenantId === "C" ? { ...x, disabledAt: d("2026-10-01T00:00:00Z") } : x));
    expect(chooseActiveTenant(withDisabled, { cookieTenantId: null, preferredTenantId: "C" })).toBe("B");
  });

  it("la más reciente no usable → la siguiente usable por acceptedAt", () => {
    const bBroken = ms.map((x) => (x.tenantId === "B" ? { ...x, hasPractitioner: false } : x));
    expect(chooseActiveTenant(bBroken, NO_PREF)).toBe("C");
  });

  it("empate exacto de acceptedAt → determinístico por tenantId", () => {
    const at = d("2026-10-10T12:00:00Z");
    const tie = [m({ tenantId: "Y", acceptedAt: at }), m({ tenantId: "X", acceptedAt: at })];
    expect(chooseActiveTenant(tie, NO_PREF)).toBe(chooseActiveTenant([...tie].reverse(), NO_PREF));
  });
});

describe("[IAM-0c] invitationStatus", () => {
  const now = d("2026-10-14T15:00:00Z");
  const base = { acceptedAt: null, expiresAt: d("2026-10-20T00:00:00Z"), revokedAt: null };

  it("viva → pending", () => {
    expect(invitationStatus(base, now)).toBe("pending");
  });
  it("aceptada → accepted (aunque esté vencida)", () => {
    expect(invitationStatus({ ...base, acceptedAt: d("2026-10-01T00:00:00Z"), expiresAt: d("2026-10-02T00:00:00Z") }, now)).toBe(
      "accepted"
    );
  });
  it("vencida → expired; en el instante exacto del vencimiento ya está vencida (como el `expiresAt > now` de las queries)", () => {
    expect(invitationStatus({ ...base, expiresAt: d("2026-10-01T00:00:00Z") }, now)).toBe("expired");
    expect(invitationStatus({ ...base, expiresAt: now }, now)).toBe("expired");
  });
  it("anulada → revoked, aunque además esté vencida", () => {
    expect(invitationStatus({ ...base, revokedAt: d("2026-10-10T00:00:00Z") }, now)).toBe("revoked");
    expect(invitationStatus({ ...base, revokedAt: d("2026-10-10T00:00:00Z"), expiresAt: d("2026-10-11T00:00:00Z") }, now)).toBe(
      "revoked"
    );
  });
  it("revokedAt ausente (la columna todavía no existe) → no anulada", () => {
    expect(invitationStatus({ acceptedAt: null, expiresAt: d("2026-10-20T00:00:00Z") }, now)).toBe("pending");
  });
});

describe("[IAM-0c] canSafelyDeleteAuthUser", () => {
  const zombie = {
    emailConfirmedAt: null,
    lastSignInAt: null,
    hasProfile: false,
    membershipCount: 0,
    patientLinks: 0,
  };

  it("zombie (nunca entró, sin confirmar, sin nada colgado) → se puede borrar", () => {
    expect(canSafelyDeleteAuthUser(zombie)).toBe(true);
  });

  it("cualquier rastro de uso lo impide", () => {
    expect(canSafelyDeleteAuthUser({ ...zombie, emailConfirmedAt: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(canSafelyDeleteAuthUser({ ...zombie, lastSignInAt: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(canSafelyDeleteAuthUser({ ...zombie, hasProfile: true })).toBe(false);
    expect(canSafelyDeleteAuthUser({ ...zombie, membershipCount: 1 })).toBe(false);
    expect(canSafelyDeleteAuthUser({ ...zombie, patientLinks: 1 })).toBe(false);
  });

  it("strings vacíos de GoTrue no cuentan como «nunca»: falla cerrado", () => {
    // GoTrue manda null cuando no hay fecha; un "" es un dato raro → no se borra.
    expect(canSafelyDeleteAuthUser({ ...zombie, emailConfirmedAt: "" })).toBe(false);
  });
});
