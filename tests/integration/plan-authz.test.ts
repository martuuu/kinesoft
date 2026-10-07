/**
 * P2-C1 · gates de Planes (`lib/plan-authz-internal.ts`, E1 de PLANES.md §5 +
 * enmienda EV0 de §10).
 *
 * Matriz rol × acción × acceso contra la base real, con el `getActor()` real
 * (solo se mockea la sesión de Supabase) y `patientAccessFor` dentro del
 * `runWithRls` del caller. Corre con los dos roles de DB: `kinesoft_app` (RLS)
 * y el owner BYPASSRLS (`test:integration:owner`, reproduce prod): con
 * BYPASSRLS, un paciente de otro tenant tiene que seguir dando Forbidden por
 * el filtro de tenant de `patientAccessFor`, no por RLS.
 *
 * Reglas (literal de §5):
 *   - manage:    `plans.manage` + acceso full + `clinical.read`.
 *   - schedule:  `plans.schedule` + (full o `agenda.operateAll`).
 *   - authorize: `plans.authorize` + (full o `agenda.operateAll`).
 *   - los tres arrancan con `assertModule(actor, 'planes')`.
 * Controles anti-falso-verde: OWNER y el PRACTITIONER asignado pasan las tres;
 * si "todo se rechazara" esos casos caen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getActor, ForbiddenError, type Actor } from "@/lib/session";
import { getMembershipRole } from "@/lib/authz";
import { capabilitiesFor, type Capability, type PatientAccessLevel } from "@/lib/capabilities";
import { runWithRls } from "@/lib/rls";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import {
  assertPlanAuthorizeInTx,
  assertPlanManageInTx,
  assertPlanScheduleInTx,
  canSeePlanAuthorization,
  planTitleFor,
  PLAN_FORBIDDEN_COPY,
} from "@/lib/plan-authz-internal";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

type Gate = typeof assertPlanManageInTx;
const GATES: Record<"manage" | "schedule" | "authorize", Gate> = {
  manage: assertPlanManageInTx,
  schedule: assertPlanScheduleInTx,
  authorize: assertPlanAuthorizeInTx,
};

async function ctxFor(userId: string): Promise<{ actor: Actor; caps: ReadonlySet<Capability> }> {
  asUser(userId);
  const actor = await getActor();
  return { actor, caps: capabilitiesFor(await getMembershipRole(actor)) };
}

/** Corre el gate como lo hará una action: dentro de `runWithRls` del tenant del actor. */
async function run(
  gate: Gate,
  userId: string,
  patientId: string
): Promise<{ ok: true; access: PatientAccessLevel } | { ok: false; err: unknown }> {
  const { actor, caps } = await ctxFor(userId);
  try {
    const access = await runWithRls(actor.tenantId, (tx) => gate(tx, actor, caps, patientId));
    return { ok: true, access };
  } catch (err) {
    return { ok: false, err };
  }
}

describe.skipIf(!RUN)("P2-C1 · plan-authz-internal", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // KINESIOLOGY (FREE ya trae `planes`)
  let Other: EphemeralTenant;
  let G: EphemeralTenant; // GENERAL: sin `planes`
  let users: Record<string, string>;
  let patientId: string; // asignado al PRACTITIONER "pro"
  let otherTenantPatientId: string;
  let generalPatientId: string;

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    Other = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
    const admin = await addPractitioner(db, K, "ADMIN");
    const pro = await addPractitioner(db, K, "PRACTITIONER");
    const proBasic = await addPractitioner(db, K, "PRACTITIONER");
    const assistant = await addPractitioner(db, K, "ASSISTANT");
    const billing = await addPractitioner(db, K, "BILLING");
    users = {
      OWNER: K.userId,
      ADMIN: admin.userId,
      PRACTITIONER_FULL: pro.userId,
      PRACTITIONER_BASIC: proBasic.userId,
      ASSISTANT: assistant.userId,
      BILLING: billing.userId,
    };
    patientId = await addPatient(db, K, { assignedPractitionerId: pro.practitionerId });
    otherTenantPatientId = await addPatient(db, Other);
    generalPatientId = await addPatient(db, G);
  });

  afterAll(async () => {
    asAnonymous();
    await K?.cleanup();
    await Other?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  // rol → [manage, schedule, authorize] y el acceso que resuelve.
  const MATRIX: Array<[string, [boolean, boolean, boolean], PatientAccessLevel | null]> = [
    ["OWNER", [true, true, true], "full"],
    ["ADMIN", [true, true, true], "full"],
    ["PRACTITIONER_FULL", [true, true, true], "full"],
    // Básico: tiene las tres capabilities, pero ni full ni operateAll.
    ["PRACTITIONER_BASIC", [false, false, false], null],
    // Secretaria (PD-09): agenda y autoriza por `agenda.operateAll`; nunca gestiona.
    ["ASSISTANT", [false, true, true], "admin"],
    // Facturación: ninguna capability de planes.
    ["BILLING", [false, false, false], null],
  ];

  for (const [role, [manage, schedule, authorize], access] of MATRIX) {
    for (const [action, expected] of [
      ["manage", manage],
      ["schedule", schedule],
      ["authorize", authorize],
    ] as const) {
      it(`${role} · ${action} → ${expected ? "ok" : "Forbidden"}`, async () => {
        const r = await run(GATES[action], users[role], patientId);
        if (expected) {
          expect(r).toEqual({ ok: true, access });
        } else {
          expect(r.ok).toBe(false);
          const err = (r as { err: unknown }).err;
          expect(err).toBeInstanceOf(ForbiddenError);
          expect((err as Error).message).toBe(PLAN_FORBIDDEN_COPY[action]);
        }
      });
    }
  }

  it("paciente de OTRO tenant → Forbidden para el OWNER en las tres (sin oráculo: mismo copy)", async () => {
    for (const action of ["manage", "schedule", "authorize"] as const) {
      const r = await run(GATES[action], users.OWNER, otherTenantPatientId);
      expect(r.ok).toBe(false);
      expect((r as { err: Error }).err).toBeInstanceOf(ForbiddenError);
      expect((r as { err: Error }).err.message).toBe(PLAN_FORBIDDEN_COPY[action]);
    }
  });

  it("paciente inexistente → Forbidden", async () => {
    const r = await run(GATES.schedule, users.ASSISTANT, "no-existe");
    expect(r.ok).toBe(false);
    expect((r as { err: Error }).err).toBeInstanceOf(ForbiddenError);
  });

  it("tenant GENERAL (OWNER) → Forbidden", async () => {
    for (const action of ["manage", "schedule", "authorize"] as const) {
      const r = await run(GATES[action], G.userId, generalPatientId);
      expect(r.ok).toBe(false);
      expect((r as { err: Error }).err).toBeInstanceOf(ForbiddenError);
      // Es el gate de módulo (copy del módulo), no el de rol: el OWNER de
      // General tiene todas las capabilities y full sobre su paciente.
      expect((r as { err: Error }).err.message).toBe(MODULE_DENIED_COPY.planes);
    }
  });

  it("planTitleFor: el título solo con clinical.read y full", async () => {
    const owner = await ctxFor(users.OWNER);
    expect(planTitleFor(owner.caps, "full", "Rodilla")).toBe("Rodilla");
    const sec = await ctxFor(users.ASSISTANT);
    expect(planTitleFor(sec.caps, "admin", "Rodilla")).toBeNull();
    // Aunque llegara "full" (no debería, PD-13), sin clinical.read no sale.
    expect(planTitleFor(sec.caps, "full", "Rodilla")).toBeNull();
    const basic = await ctxFor(users.PRACTITIONER_BASIC);
    expect(planTitleFor(basic.caps, "basic", "Rodilla")).toBeNull();
  });

  it("canSeePlanAuthorization: (full && clinical.read) || plans.authorize efectivo || billing.manage", async () => {
    const see = async (role: string, access: PatientAccessLevel) =>
      canSeePlanAuthorization((await ctxFor(users[role])).caps, access);
    expect(await see("OWNER", "full")).toBe(true);
    expect(await see("PRACTITIONER_FULL", "full")).toBe(true);
    expect(await see("ASSISTANT", "admin")).toBe(true);
    expect(await see("BILLING", "admin")).toBe(true);
    // La autorización no sale para un PRACTITIONER básico (S14).
    expect(await see("PRACTITIONER_BASIC", "basic")).toBe(false);
    expect(await see("OWNER", "none")).toBe(false);
  });
});
