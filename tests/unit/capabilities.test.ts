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
  isTenantAdminRole,
  type Capability,
} from "@/lib/capabilities";

const EXPECTED: Record<Role, Capability[]> = {
  OWNER: [...CAPABILITIES],
  ADMIN: [...CAPABILITIES],
  PRACTITIONER: ["agenda.viewAll", "agenda.reception", "agenda.manageOwnBlocks", "clinical.read"],
  ASSISTANT: ["agenda.viewAll", "agenda.reception", "agenda.manageBlocks", "agenda.manageOwnBlocks"],
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
