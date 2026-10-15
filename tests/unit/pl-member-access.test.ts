/**
 * PL-1b (C-PL5; decisiones 7 y 8 de Martin) — capacidades por MIEMBRO, «¿atiende?» y etiquetas.
 *
 * - Titular/Admin que no atiende: sin `clinical.read` ni `plans.manage` (ve como la Secretaria, Ley 26.529).
 * - «Configuración» (`grantSettings`) y «Planes y pagos» (`grantBilling`) se delegan a cualquier rol, pero nunca
 *   abren lo clínico.
 * - `account.owner` es solo del Titular; nadie lo recibe por delegación.
 * - Un Titular que no atiende no necesita `Practitioner` para entrar (alta como Administrador/a sin agenda).
 *
 * Todo puro: símbolos reales de `lib/capabilities.ts`, `lib/roles.ts` y `lib/access-logic.ts`.
 */
import { describe, it, expect } from "vitest";
import type { Role } from "@prisma/client";
import { CAPABILITIES, capabilitiesForMember, capabilitiesFor, type Capability } from "@/lib/capabilities";
import { isClinicalMember, isClinicalRole, roleLabel } from "@/lib/roles";
import { isUsableMembership, resolveAccessState, type MembershipLite } from "@/lib/access-logic";
import type { MemberAccess } from "@/lib/saas-plans-types";

const ROLES: Role[] = ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"];
const ALL = [...CAPABILITIES] as Capability[];
const CLINICAL: Capability[] = ["clinical.read", "plans.manage"];
const SETTINGS: Capability[] = ["tenant.admin", "schedule.configure"];
const ACCOUNT: Capability[] = ["account.billing", "account.owner"];

const m = (role: Role, o: Partial<Omit<MemberAccess, "role">> = {}): MemberAccess => ({
  role,
  clinical: o.clinical ?? true,
  grantSettings: o.grantSettings ?? false,
  grantBilling: o.grantBilling ?? false,
});
const without = (xs: Capability[], ...drop: Capability[][]) => xs.filter((c) => !drop.flat().includes(c));
const sorted = (s: ReadonlySet<Capability>) => [...s].sort();

describe("[PL-1b] capabilitiesForMember — matriz", () => {
  it("Titular que atiende: todo, incluido account.* (con o sin delegaciones)", () => {
    expect(sorted(capabilitiesForMember(m("OWNER")))).toEqual([...ALL].sort());
    expect(sorted(capabilitiesForMember(m("OWNER", { grantSettings: true, grantBilling: true })))).toEqual(
      [...ALL].sort()
    );
  });

  it("Titular que NO atiende: todo menos lo clínico; conserva account.* y Configuración", () => {
    expect(sorted(capabilitiesForMember(m("OWNER", { clinical: false })))).toEqual(without(ALL, CLINICAL).sort());
  });

  it("Admin que atiende con «Configuración»: lo de siempre, sin account.*", () => {
    expect(sorted(capabilitiesForMember(m("ADMIN", { grantSettings: true })))).toEqual(
      without(ALL, ACCOUNT).sort()
    );
  });

  it("Admin sin «Configuración»: sin tenant.admin ni schedule.configure", () => {
    expect(sorted(capabilitiesForMember(m("ADMIN")))).toEqual(without(ALL, ACCOUNT, SETTINGS).sort());
  });

  it("Admin que no atiende con «Configuración»: sin lo clínico", () => {
    expect(sorted(capabilitiesForMember(m("ADMIN", { clinical: false, grantSettings: true })))).toEqual(
      without(ALL, ACCOUNT, CLINICAL).sort()
    );
  });

  it("Admin con «Planes y pagos»: account.billing pero nunca account.owner", () => {
    const caps = capabilitiesForMember(m("ADMIN", { grantBilling: true, grantSettings: true }));
    expect(caps.has("account.billing")).toBe(true);
    expect(caps.has("account.owner")).toBe(false);
  });

  it("Secretaria con «Configuración» tiene tenant.admin pero nunca clinical.read (ni con clinical = true en la fila)", () => {
    const caps = capabilitiesForMember(m("ASSISTANT", { clinical: true, grantSettings: true, grantBilling: true }));
    expect(caps.has("tenant.admin")).toBe(true);
    expect(caps.has("schedule.configure")).toBe(true);
    expect(caps.has("account.billing")).toBe(true);
    expect(caps.has("account.owner")).toBe(false);
    expect(caps.has("clinical.read")).toBe(false);
    expect(caps.has("plans.manage")).toBe(false);
    // Lo demás es exactamente lo de la Secretaria.
    expect(sorted(caps)).toEqual([...capabilitiesFor("ASSISTANT"), ...SETTINGS, "account.billing"].sort());
  });

  it("Profesional: el flag `clinical` no le saca la HC; con «Configuración» suma tenant.admin", () => {
    expect(capabilitiesForMember(m("PRACTITIONER", { clinical: false })).has("clinical.read")).toBe(true);
    const caps = capabilitiesForMember(m("PRACTITIONER", { grantSettings: true }));
    expect(caps.has("tenant.admin")).toBe(true);
    expect(caps.has("agenda.operateAll")).toBe(false);
  });

  it("Facturación con «Planes y pagos»: account.billing; sin clínico ni Configuración", () => {
    const caps = capabilitiesForMember(m("BILLING", { grantBilling: true }));
    expect(sorted(caps)).toEqual([...capabilitiesFor("BILLING"), "account.billing"].sort());
  });

  describe("invariantes sobre todas las combinaciones", () => {
    for (const role of ROLES) {
      for (const clinical of [true, false]) {
        for (const grantSettings of [true, false]) {
          for (const grantBilling of [true, false]) {
            const acc = { role, clinical, grantSettings, grantBilling };
            it(JSON.stringify(acc), () => {
              const caps = capabilitiesForMember(acc);
              expect(caps.has("clinical.read")).toBe(isClinicalMember(acc));
              expect(caps.has("plans.manage")).toBe(isClinicalMember(acc));
              expect(caps.has("account.owner")).toBe(role === "OWNER");
              expect(caps.has("account.billing")).toBe(role === "OWNER" || grantBilling);
              expect(caps.has("tenant.admin")).toBe(role === "OWNER" || grantSettings);
              for (const c of caps) expect(CAPABILITIES).toContain(c);
            });
          }
        }
      }
    }
  });
});

describe("[PL-1b] isClinicalMember / isClinicalRole", () => {
  it("PRACTITIONER siempre; OWNER según el flag (ADMIN: solo filas legadas hasta M8b); ASSISTANT/BILLING nunca", () => {
    expect(isClinicalMember({ role: "PRACTITIONER", clinical: false })).toBe(true);
    expect(isClinicalMember({ role: "OWNER", clinical: true })).toBe(true);
    expect(isClinicalMember({ role: "OWNER", clinical: false })).toBe(false);
    expect(isClinicalMember({ role: "ADMIN", clinical: false })).toBe(false);
    expect(isClinicalMember({ role: "ASSISTANT", clinical: true })).toBe(false);
    expect(isClinicalMember({ role: "BILLING", clinical: true })).toBe(false);
  });

  it("isClinicalRole sigue siendo «el rol PUEDE atender» (§20.17: el ADMIN no)", () => {
    expect(ROLES.filter(isClinicalRole).sort()).toEqual(["OWNER", "PRACTITIONER"]);
  });
});

describe("[PL-1b] roleLabel con clinical", () => {
  it("«(sin agenda)» solo para el Titular que no atiende (§20.17: el Administrador/a nunca atiende, sin sufijo)", () => {
    expect(roleLabel("OWNER", "KINESIOLOGY", { clinical: false })).toBe("Titular (sin agenda)");
    expect(roleLabel("ADMIN", null, { clinical: false })).toBe("Administrador/a");
    expect(roleLabel("OWNER", "KINESIOLOGY", { clinical: true })).toBe("Titular");
    expect(roleLabel("OWNER")).toBe("Titular");
    expect(roleLabel("ADMIN")).toBe("Administrador/a");
    // El flag no cambia los roles que no lo usan.
    expect(roleLabel("ASSISTANT", null, { clinical: false })).toBe("Secretario/a");
    expect(roleLabel("PRACTITIONER", "GENERAL", { clinical: false })).toBe("Profesional");
  });
});

describe("[PL-1b] isUsableMembership: Practitioner solo si atiende", () => {
  const base: MembershipLite = { tenantId: "t1", role: "OWNER", acceptedAt: new Date("2026-10-01T12:00:00Z"), hasPractitioner: false };

  it("Titular que no atiende, sin Practitioner → usable (y el estado es ok, no missing_practitioner)", () => {
    expect(isUsableMembership({ ...base, clinical: false })).toBe(true);
    expect(resolveAccessState([{ ...base, clinical: false }], {})).toEqual({ kind: "ok", tenantId: "t1" });
  });

  it("Admin que no atiende, sin Practitioner → usable", () => {
    expect(isUsableMembership({ ...base, role: "ADMIN", clinical: false })).toBe(true);
  });

  it("Titular que atiende (o sin el dato: default de la columna) sin Practitioner → no usable", () => {
    expect(isUsableMembership({ ...base, clinical: true })).toBe(false);
    expect(isUsableMembership(base)).toBe(false);
  });

  it("el flag no exime a un PRACTITIONER", () => {
    expect(isUsableMembership({ ...base, role: "PRACTITIONER", clinical: false })).toBe(false);
  });
});

describe("[PL-1b] capabilitiesForMembership (reemplazo de capabilitiesFor(m?.role))", () => {
  it("sin membresía → vacío; con ella → capabilitiesForMember", async () => {
    const { capabilitiesForMembership, MEMBER_ACCESS_SELECT } = await import("@/lib/capabilities");
    expect(capabilitiesForMembership(null).size).toBe(0);
    expect(capabilitiesForMembership(undefined).size).toBe(0);
    const owner = m("OWNER", { clinical: false });
    expect(sorted(capabilitiesForMembership(owner))).toEqual(sorted(capabilitiesForMember(owner)));
    expect(Object.keys(MEMBER_ACCESS_SELECT).sort()).toEqual(["clinical", "grantBilling", "grantSettings", "role"]);
  });
});
