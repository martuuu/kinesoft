/**
 * BO2-C · lógica pura del directorio de usuarios y de la salud de Plataforma (`lib/platform-health-logic.ts`).
 *
 * Por qué importa (plan §19.1, «cuentas muertas»): invitados sin contraseña, usuarios de Auth huérfanos al
 * revocar o vencer (email «tomado»), perfiles cuyo email ya no coincide con Auth, altas trabadas. Los detectores
 * de `/plataforma/salud` y las guardas de las acciones (no deshabilitarse a sí mismo, no dejar la plataforma sin
 * superadmin) se deciden acá; el server solo junta los datos. Corre en TZ=UTC y TZ=AR con el mismo resultado:
 * todo es aritmética de instantes, sin reloj del host.
 */
import { describe, it, expect } from "vitest";
import {
  classifyPlatformUser,
  isStalledOnboarding,
  STALLED_ONBOARDING_DAYS,
  emailsDiffer,
  authOrphansFrom,
  emailMismatchesFrom,
  summarize,
  HEALTH_SAMPLE_LIMIT,
  disableBlockReason,
  revokeAdminBlockReason,
  isAuthBanned,
  PLATFORM_BAN_DURATION,
  accessLinkPurpose,
  confirmEmailMatches,
} from "@/lib/platform-health-logic";

const DAY = 86_400_000;

describe("classifyPlatformUser", () => {
  it("con alguna membresía es equipo, aunque también sea paciente de portal", () => {
    expect(classifyPlatformUser({ membershipCount: 1, portalLinkCount: 0, isPlatformAdmin: false })).toBe("team");
    expect(classifyPlatformUser({ membershipCount: 2, portalLinkCount: 3, isPlatformAdmin: false })).toBe("team");
  });
  it("sin membresías y con fichas vinculadas es paciente de portal", () => {
    expect(classifyPlatformUser({ membershipCount: 0, portalLinkCount: 1, isPlatformAdmin: false })).toBe("portal");
  });
  it("un superadmin sin consultorio no es huérfano (es equipo de la plataforma)", () => {
    expect(classifyPlatformUser({ membershipCount: 0, portalLinkCount: 0, isPlatformAdmin: true })).toBe("team");
  });
  it("sin nada es huérfano", () => {
    expect(classifyPlatformUser({ membershipCount: 0, portalLinkCount: 0, isPlatformAdmin: false })).toBe("orphan");
  });
});

describe("isStalledOnboarding", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  it(`trabada = más de ${STALLED_ONBOARDING_DAYS} días sin terminar el alta`, () => {
    const created = new Date(now.getTime() - (STALLED_ONBOARDING_DAYS * DAY + 1));
    expect(isStalledOnboarding({ createdAt: created, onboardingCompletedAt: null }, now)).toBe(true);
  });
  it("justo en el límite todavía no está trabada", () => {
    const created = new Date(now.getTime() - STALLED_ONBOARDING_DAYS * DAY);
    expect(isStalledOnboarding({ createdAt: created, onboardingCompletedAt: null }, now)).toBe(false);
  });
  it("con el alta terminada nunca está trabada", () => {
    const created = new Date(now.getTime() - 100 * DAY);
    expect(isStalledOnboarding({ createdAt: created, onboardingCompletedAt: new Date(now.getTime() - 99 * DAY) }, now)).toBe(false);
  });
});

describe("emailsDiffer", () => {
  it("compara normalizado (mayúsculas y espacios no cuentan)", () => {
    expect(emailsDiffer("Juan@X.com ", "juan@x.com")).toBe(false);
    expect(emailsDiffer("juan@x.com", "juan2@x.com")).toBe(true);
  });
  it("sin email en Auth (cuenta solo-teléfono) no es una diferencia reparable", () => {
    expect(emailsDiffer("juan@x.com", null)).toBe(false);
  });
});

describe("authOrphansFrom / emailMismatchesFrom", () => {
  const auth = [
    { id: "a1", email: "a1@x.com", emailConfirmedAt: null, lastSignInAt: null, createdAt: "2026-01-01T00:00:00Z", bannedUntil: null },
    { id: "a2", email: "a2@x.com", emailConfirmedAt: "2026-01-01T00:00:00Z", lastSignInAt: null, createdAt: "2026-01-02T00:00:00Z", bannedUntil: null },
    { id: "a3", email: "nuevo@x.com", emailConfirmedAt: "2026-01-01T00:00:00Z", lastSignInAt: null, createdAt: "2026-01-03T00:00:00Z", bannedUntil: null },
  ];
  it("huérfano de Auth = usuario de Auth sin UserProfile con el mismo id", () => {
    const orphans = authOrphansFrom(auth, new Set(["a2", "a3"]));
    expect(orphans.map((o) => o.id)).toEqual(["a1"]);
  });
  it("email distinto entre perfil y Auth, por id", () => {
    const profiles = [
      { id: "a2", email: "a2@x.com" },
      { id: "a3", email: "viejo@x.com" },
      { id: "zz", email: "zz@x.com" }, // sin usuario de Auth: lo cubre otro detector, no este
    ];
    expect(emailMismatchesFrom(profiles, auth)).toEqual([{ userId: "a3", profileEmail: "viejo@x.com", authEmail: "nuevo@x.com" }]);
  });
});

describe("summarize", () => {
  it("cuenta todo y muestra a lo sumo la lista corta", () => {
    const rows = Array.from({ length: HEALTH_SAMPLE_LIMIT + 5 }, (_, i) => i);
    expect(summarize(rows)).toEqual({ available: true, count: HEALTH_SAMPLE_LIMIT + 5, sample: rows.slice(0, HEALTH_SAMPLE_LIMIT) });
  });
  it("con un conteo aparte (la lista vino con take) usa ese conteo", () => {
    expect(summarize([1, 2], 40)).toEqual({ available: true, count: 40, sample: [1, 2] });
  });
});

describe("guardas de deshabilitar y de quitar superadmin", () => {
  it("nadie se deshabilita a sí mismo", () => {
    expect(disableBlockReason({ actorId: "u1", targetId: "u1", targetIsActiveAdmin: true, activeAdminCount: 3 })).toBe("self");
  });
  it("no se deshabilita al último superadmin activo", () => {
    expect(disableBlockReason({ actorId: "u1", targetId: "u2", targetIsActiveAdmin: true, activeAdminCount: 1 })).toBe("last_admin");
    expect(disableBlockReason({ actorId: "u1", targetId: "u2", targetIsActiveAdmin: true, activeAdminCount: 2 })).toBeNull();
  });
  it("un usuario común se deshabilita aunque haya un solo superadmin", () => {
    expect(disableBlockReason({ actorId: "u1", targetId: "u2", targetIsActiveAdmin: false, activeAdminCount: 1 })).toBeNull();
  });
  it("no se quita al último superadmin activo (ni a uno mismo si es el último)", () => {
    expect(revokeAdminBlockReason({ targetIsActiveAdmin: true, activeAdminCount: 1 })).toBe("last_admin");
    expect(revokeAdminBlockReason({ targetIsActiveAdmin: true, activeAdminCount: 2 })).toBeNull();
    // Un superadmin deshabilitado no cuenta como activo: quitárselo no reduce los activos.
    expect(revokeAdminBlockReason({ targetIsActiveAdmin: false, activeAdminCount: 1 })).toBeNull();
  });
});

describe("estado de Auth y link de acceso", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  it("baneado = bannedUntil en el futuro", () => {
    expect(isAuthBanned({ bannedUntil: "2126-10-14T12:00:00Z" }, now)).toBe(true);
    expect(isAuthBanned({ bannedUntil: "2026-10-13T12:00:00Z" }, now)).toBe(false);
    expect(isAuthBanned({ bannedUntil: null }, now)).toBe(false);
    expect(isAuthBanned({ bannedUntil: "basura" }, now)).toBe(false);
  });
  it("el ban de plataforma es largo (GoTrue no tiene «para siempre»)", () => {
    expect(PLATFORM_BAN_DURATION).toMatch(/^\d+h$/);
    expect(Number.parseInt(PLATFORM_BAN_DURATION, 10)).toBeGreaterThanOrEqual(24 * 365 * 50);
  });
  it("activación si nunca confirmó o nunca entró; si no, recuperación", () => {
    expect(accessLinkPurpose({ emailConfirmedAt: null, lastSignInAt: null })).toBe("activation");
    expect(accessLinkPurpose({ emailConfirmedAt: "2026-01-01T00:00:00Z", lastSignInAt: null })).toBe("activation");
    expect(accessLinkPurpose({ emailConfirmedAt: "2026-01-01T00:00:00Z", lastSignInAt: "2026-01-02T00:00:00Z" })).toBe("recovery");
  });
  it("la confirmación tipeada tiene que ser el email exacto (sin distinguir mayúsculas)", () => {
    expect(confirmEmailMatches(" Juan@X.com", "juan@x.com")).toBe(true);
    expect(confirmEmailMatches("juan@x.co", "juan@x.com")).toBe(false);
    expect(confirmEmailMatches("", "juan@x.com")).toBe(false);
    expect(confirmEmailMatches(undefined, "juan@x.com")).toBe(false);
  });
});
