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
  capabilitiesForMember,
  canCollectCopago,
  canConfirmInsurer,
  canManageBlocksFor,
  canOperateBooking,
  canWriteClinical,
  type Capability,
  type PatientAccessLevel,
} from "@/lib/capabilities";

// Planes E1 (PLANES.md §8 P0-Ck, literal): agenda.operateAll / plans.manage /
// plans.schedule / plans.authorize. "Con full" NO va en la matriz.
// PL-1b (C-PL5): el default por ROL nunca trae `account.*` (titularidad y «Planes y pagos» salen de
// `capabilitiesForMember`, no del rol).
// T3b-1k1 (C-AS1): `billing.collectOwn` es solo del PRACTITIONER (patrón `manageOwnBlocks`): OWNER/ADMIN cobran
// cualquier turno con `billing.collect`, así que «lo propio» no les suma nada y la matriz queda exacta.
const ROLE_DEFAULT_ALL = CAPABILITIES.filter((c) => !c.startsWith("account.") && c !== "billing.collectOwn");
const EXPECTED: Record<Role, Capability[]> = {
  OWNER: [...ROLE_DEFAULT_ALL],
  ADMIN: [...ROLE_DEFAULT_ALL],
  PRACTITIONER: [
    "agenda.viewAll",
    "agenda.reception",
    "agenda.manageOwnBlocks",
    "clinical.read",
    "plans.manage",
    "plans.schedule",
    "plans.authorize",
    "billing.collectOwn",
  ],
  ASSISTANT: [
    "agenda.viewAll",
    "agenda.reception",
    "agenda.manageBlocks",
    "agenda.manageOwnBlocks",
    "agenda.operateAll",
    "plans.schedule",
    "plans.authorize",
    "billing.collect",
    "patients.editAdmin",
  ],
  BILLING: ["agenda.viewAll", "billing.manage", "billing.collect"],
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

// HD-17: `isTenantAdminRole` (deprecado en PL-1b, sin call sites) se borró con su describe. Para un actor:
// `(await capabilitiesForActor(actor)).has("tenant.admin")`.

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

/*
 * T3b-1k1 (C-AS1, plan §23.3; decisiones 1-4 del 19-oct). Las 4 capabilities nuevas, por MIEMBRO (la barrera real es
 * `capabilitiesForMember`, no el rol en abstracto): la matriz exacta con los defaults de cada rol (sin delegaciones;
 * el Titular atiende) y con «Configuración» delegada, que es lo único que mueve `tenant.sensitive`.
 */
describe("[AS-1k1] capabilities nuevas — matriz exacta por rol", () => {
  const NEW_CAPS = ["billing.collect", "billing.collectOwn", "patients.editAdmin", "tenant.sensitive"] as const;
  const mem = (role: Role, grantSettings = false) => ({ role, clinical: true, grantSettings, grantBilling: false });
  const has = (role: Role, grantSettings = false) =>
    NEW_CAPS.filter((c) => capabilitiesForMember(mem(role, grantSettings)).has(c));

  it("[AS-1k1] existen en CAPABILITIES", () => {
    for (const c of NEW_CAPS) expect(CAPABILITIES).toContain(c);
  });

  it("[AS-1k1] sin delegaciones: collect a OWNER/ADMIN/ASSISTANT/BILLING, collectOwn al PRACTITIONER, editAdmin a OWNER/ADMIN/ASSISTANT, sensitive solo al OWNER", () => {
    expect({
      OWNER: has("OWNER"),
      ADMIN: has("ADMIN"),
      PRACTITIONER: has("PRACTITIONER"),
      ASSISTANT: has("ASSISTANT"),
      BILLING: has("BILLING"),
    }).toEqual({
      OWNER: ["billing.collect", "patients.editAdmin", "tenant.sensitive"],
      ADMIN: ["billing.collect", "patients.editAdmin"],
      PRACTITIONER: ["billing.collectOwn"],
      ASSISTANT: ["billing.collect", "patients.editAdmin"],
      BILLING: ["billing.collect"],
    });
  });

  it("[AS-1k1] con «Configuración»: ADMIN y PRACTITIONER suman tenant.sensitive (decisión 4); ASSISTANT y BILLING nunca (decisión 3)", () => {
    expect(has("OWNER", true)).toContain("tenant.sensitive");
    expect(has("ADMIN", true)).toContain("tenant.sensitive");
    expect(has("PRACTITIONER", true)).toContain("tenant.sensitive");
    expect(has("ASSISTANT", true)).not.toContain("tenant.sensitive");
    expect(has("BILLING", true)).not.toContain("tenant.sensitive");
    // «Configuración» no cambia quién cobra ni quién edita datos administrativos.
    expect(has("ASSISTANT", true)).toEqual(["billing.collect", "patients.editAdmin"]);
    expect(has("PRACTITIONER", true)).toEqual(["billing.collectOwn", "tenant.sensitive"]);
  });
});

describe("[AS-1k1] canCollectCopago = collect || (collectOwn && turno propio)", () => {
  const me = "prac-me";
  const other = "prac-other";
  const COLLECT = new Set<Capability>(["billing.collect"]);
  const OWN = new Set<Capability>(["billing.collectOwn"]);
  const NONE = new Set<Capability>();

  it("[AS-1k1] billing.collect: cualquier turno, con o sin profesional del actor, y el guest", () => {
    expect(canCollectCopago(COLLECT, null, other)).toBe(true);
    expect(canCollectCopago(COLLECT, me, other)).toBe(true);
    expect(canCollectCopago(COLLECT, null, null)).toBe(true);
  });

  it("[AS-1k1] billing.collectOwn: solo el turno propio", () => {
    expect(canCollectCopago(OWN, me, me)).toBe(true);
    expect(canCollectCopago(OWN, me, other)).toBe(false);
    expect(canCollectCopago(OWN, me, null)).toBe(false);
  });

  it("[AS-1k1] un actor sin practitionerId nunca pasa por collectOwn (nunca `null === null`)", () => {
    expect(canCollectCopago(OWN, null, null)).toBe(false);
    expect(canCollectCopago(OWN, null, other)).toBe(false);
  });

  it("[AS-1k1] sin ninguna de las dos: nunca (billing.manage solo no cobra copagos)", () => {
    expect(canCollectCopago(NONE, me, me)).toBe(false);
    expect(canCollectCopago(new Set<Capability>(["billing.manage"]), me, me)).toBe(false);
  });

  it("[AS-1k1] por miembro: Secretaria y Facturación cobran cualquiera; el profesional solo lo suyo; un Titular que no atiende cobra igual", () => {
    const m = (role: Role, clinical = true) => capabilitiesForMember({ role, clinical, grantSettings: false, grantBilling: false });
    expect(canCollectCopago(m("ASSISTANT"), null, other)).toBe(true);
    expect(canCollectCopago(m("BILLING"), null, other)).toBe(true);
    expect(canCollectCopago(m("ADMIN"), null, other)).toBe(true);
    expect(canCollectCopago(m("OWNER", false), null, other)).toBe(true);
    expect(canCollectCopago(m("PRACTITIONER"), me, me)).toBe(true);
    expect(canCollectCopago(m("PRACTITIONER"), me, other)).toBe(false);
  });
});

describe("[AS-1k1] canConfirmInsurer = billing.manage", () => {
  it.each(ROLES)("%s → billing.manage del rol", (role) => {
    const caps = capabilitiesFor(role);
    expect(canConfirmInsurer(caps)).toBe(caps.has("billing.manage"));
  });

  it("Secretaria y profesional no confirman obra social; Facturación sí", () => {
    expect(canConfirmInsurer(capabilitiesFor("ASSISTANT"))).toBe(false);
    expect(canConfirmInsurer(capabilitiesFor("PRACTITIONER"))).toBe(false);
    expect(canConfirmInsurer(capabilitiesFor("BILLING"))).toBe(true);
  });
});
