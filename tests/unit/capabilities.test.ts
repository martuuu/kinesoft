/**
 * Matriz rol → capabilities (B1.7 AUTHZ). Tabla completa: si alguien agrega
 * una capability o toca un rol, este test obliga a decidir explícitamente qué
 * reciben los demás (falla con la fila exacta).
 */
import { describe, it, expect } from "vitest";
import type { Role } from "@prisma/client";
import {
  CAPABILITIES,
  capabilitiesFor,
  canManageBlocksFor,
  canOperateBooking,
  canWriteClinical,
  isTenantAdminRole,
  type Capability,
  type PatientAccessLevel,
} from "@/lib/capabilities";

// Planes E1 (PLANES.md §8 P0-Ck, literal): agenda.operateAll / plans.manage /
// plans.schedule / plans.authorize. "Con full" NO va en la matriz.
const EXPECTED: Record<Role, Capability[]> = {
  OWNER: [...CAPABILITIES],
  ADMIN: [...CAPABILITIES],
  PRACTITIONER: [
    "agenda.viewAll",
    "agenda.reception",
    "agenda.manageOwnBlocks",
    "clinical.read",
    "plans.manage",
    "plans.schedule",
    "plans.authorize",
  ],
  ASSISTANT: [
    "agenda.viewAll",
    "agenda.reception",
    "agenda.manageBlocks",
    "agenda.manageOwnBlocks",
    "agenda.operateAll",
    "plans.schedule",
    "plans.authorize",
  ],
  BILLING: ["agenda.viewAll", "billing.manage"],
};
const ROLES = Object.keys(EXPECTED) as Role[];

describe("capabilitiesFor — matriz", () => {
  for (const role of ROLES) {
    for (const cap of CAPABILITIES) {
      const want = EXPECTED[role].includes(cap);
      it(`${role} ${want ? "tiene" : "NO tiene"} ${cap}`, () => {
        expect(capabilitiesFor(role).has(cap)).toBe(want);
      });
    }
  }

  it("los 5 roles del enum están en la matriz (ASSISTANT/BILLING se preservan, AUDIT §5.17)", () => {
    expect(ROLES.sort()).toEqual(["ADMIN", "ASSISTANT", "BILLING", "OWNER", "PRACTITIONER"]);
  });

  it("sin rol (sin membresía) o rol desconocido → set vacío (falla cerrado)", () => {
    expect(capabilitiesFor(null).size).toBe(0);
    expect(capabilitiesFor(undefined).size).toBe(0);
    expect(capabilitiesFor("SUPERUSER" as Role).size).toBe(0);
  });

  it("clinical.read: ASSISTANT y BILLING no leen contenido clínico", () => {
    expect(capabilitiesFor("ASSISTANT").has("clinical.read")).toBe(false);
    expect(capabilitiesFor("BILLING").has("clinical.read")).toBe(false);
  });

  it("cada llamada devuelve un set nuevo (mutarlo no contamina la matriz)", () => {
    const a = capabilitiesFor("BILLING") as Set<Capability>;
    a.add("tenant.admin");
    expect(capabilitiesFor("BILLING").has("tenant.admin")).toBe(false);
  });
});

describe("isTenantAdminRole — mismo criterio que el chequeo OWNER/ADMIN copiado", () => {
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["PRACTITIONER", false],
    ["ASSISTANT", false],
    ["BILLING", false],
  ] as const)("%s → %s", (role, want) => {
    expect(isTenantAdminRole(role)).toBe(want);
  });
  it("sin membresía → false", () => expect(isTenantAdminRole(null)).toBe(false));
});

describe("canManageBlocksFor", () => {
  const me = "prac-me";
  const other = "prac-other";

  it("PRACTITIONER: solo su propia agenda; ni ajena ni candado 'todos' (null)", () => {
    const caps = capabilitiesFor("PRACTITIONER");
    expect(canManageBlocksFor(caps, me, me)).toBe(true);
    expect(canManageBlocksFor(caps, me, other)).toBe(false);
    expect(canManageBlocksFor(caps, me, null)).toBe(false);
  });

  it.each(["OWNER", "ADMIN", "ASSISTANT"] as const)("%s: propia, ajena y 'todos'", (role) => {
    const caps = capabilitiesFor(role);
    expect(canManageBlocksFor(caps, me, me)).toBe(true);
    expect(canManageBlocksFor(caps, me, other)).toBe(true);
    expect(canManageBlocksFor(caps, me, null)).toBe(true);
  });

  it("BILLING: ninguna", () => {
    const caps = capabilitiesFor("BILLING");
    expect(canManageBlocksFor(caps, me, me)).toBe(false);
    expect(canManageBlocksFor(caps, me, other)).toBe(false);
    expect(canManageBlocksFor(caps, me, null)).toBe(false);
  });
});

describe("Planes E1 — capabilities nuevas", () => {
  const PLAN_CAPS = ["agenda.operateAll", "plans.manage", "plans.schedule", "plans.authorize"] as const;

  it("las 4 existen en CAPABILITIES", () => {
    for (const c of PLAN_CAPS) expect(CAPABILITIES).toContain(c);
  });

  it("BILLING no tiene ninguna de las 4", () => {
    const caps = capabilitiesFor("BILLING");
    for (const c of PLAN_CAPS) expect(caps.has(c)).toBe(false);
  });

  it("la Secretaria (ASSISTANT) opera todo y agenda/autoriza en planes, pero NO gestiona planes (PD-09)", () => {
    const caps = capabilitiesFor("ASSISTANT");
    expect(caps.has("agenda.operateAll")).toBe(true);
    expect(caps.has("plans.schedule")).toBe(true);
    expect(caps.has("plans.authorize")).toBe(true);
    expect(caps.has("plans.manage")).toBe(false);
  });

  it("PRACTITIONER gestiona planes pero no opera la agenda ajena por capability", () => {
    const caps = capabilitiesFor("PRACTITIONER");
    expect(caps.has("plans.manage")).toBe(true);
    expect(caps.has("agenda.operateAll")).toBe(false);
  });

  it.each(["OWNER", "ADMIN"] as const)("%s tiene las 4", (role) => {
    const caps = capabilitiesFor(role);
    for (const c of PLAN_CAPS) expect(caps.has(c)).toBe(true);
  });
});

const LEVELS: PatientAccessLevel[] = ["full", "admin", "basic", "none"];

describe("canOperateBooking = full || agenda.operateAll (forma positiva, C8)", () => {
  // Tabla completa rol × nivel. `admin` y `none` NO operan sin operateAll:
  // es la razón por la que no rige la forma `access !== 'basic'` de E1.
  const WANT: Record<Role, Record<PatientAccessLevel, boolean>> = {
    OWNER: { full: true, admin: true, basic: true, none: true },
    ADMIN: { full: true, admin: true, basic: true, none: true },
    ASSISTANT: { full: true, admin: true, basic: true, none: true },
    PRACTITIONER: { full: true, admin: false, basic: false, none: false },
    BILLING: { full: true, admin: false, basic: false, none: false },
  };
  for (const role of ROLES) {
    for (const lvl of LEVELS) {
      it(`${role} con acceso ${lvl} → ${WANT[role][lvl]}`, () => {
        expect(canOperateBooking(capabilitiesFor(role), lvl)).toBe(WANT[role][lvl]);
      });
    }
  }

  it("BILLING en nivel admin NO opera (el bug que evita la forma positiva)", () => {
    expect(canOperateBooking(capabilitiesFor("BILLING"), "admin")).toBe(false);
  });

  it("sin membresía: solo con full (falla cerrado en todo lo demás)", () => {
    const none = capabilitiesFor(null);
    expect(canOperateBooking(none, "basic")).toBe(false);
    expect(canOperateBooking(none, "admin")).toBe(false);
    expect(canOperateBooking(none, "none")).toBe(false);
  });
});

describe("canWriteClinical = clinical.read && full", () => {
  it.each(ROLES)("%s: solo con acceso full y si lee clínica", (role) => {
    const caps = capabilitiesFor(role);
    const reads = caps.has("clinical.read");
    for (const lvl of LEVELS) {
      expect(canWriteClinical(caps, lvl)).toBe(reads && lvl === "full");
    }
  });

  it("ASSISTANT y BILLING nunca, ni con full (PD-13: admin no escribe clínica)", () => {
    expect(canWriteClinical(capabilitiesFor("ASSISTANT"), "full")).toBe(false);
    expect(canWriteClinical(capabilitiesFor("BILLING"), "full")).toBe(false);
    expect(canWriteClinical(capabilitiesFor("ASSISTANT"), "admin")).toBe(false);
  });

  it("PRACTITIONER: full sí; básico no", () => {
    expect(canWriteClinical(capabilitiesFor("PRACTITIONER"), "full")).toBe(true);
    expect(canWriteClinical(capabilitiesFor("PRACTITIONER"), "basic")).toBe(false);
  });
});
