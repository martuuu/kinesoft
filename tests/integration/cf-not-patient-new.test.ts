/**
 * [CF-F2] CF-NOT (§28, ola CF-1) — el alta de un paciente avisa a los titulares, no solo a quien lo cargó.
 *
 * Reporte del cliente: «El profesional cargó 4 pacientes y los siguientes 2 no aparecían». `createPatient` hacía
 * `notify({ userId: actor.userId })`: el aviso `PATIENT_NEW` le llegaba SOLO al profesional que lo creaba, y el OWNER
 * no se enteraba de nada. Ahora va por `notifyTenantOwners({ alsoUserId: actor.userId })`: OWNER/ADMIN activos + el
 * creador, con los filtros de HD-12 (suspendido, invitación sin aceptar o usuario deshabilitado no reciben).
 *
 * Símbolo real de `lib/patients.ts` contra la DB; solo se mockea la sesión (integration-setup). El aviso es
 * fire-and-forget: el test afirma también que los activos SÍ reciben, para que un throw tragado no pase por verde.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createPatient } from "@/lib/patients";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[CF-F2] PATIENT_NEW llega a los titulares", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let adminSuspended: { userId: string; practitionerId: string };
  let otherKine: { userId: string; practitionerId: string };

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db); // T.userId = OWNER activo
    kine = await addPractitioner(db, T, "PRACTITIONER");
    adminSuspended = await addPractitioner(db, T, "ADMIN");
    otherKine = await addPractitioner(db, T, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: adminSuspended.userId, tenantId: T.tenantId } },
      data: { disabledAt: new Date() },
    });
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("[CF-F2] un PRACTITIONER crea 2 pacientes → el OWNER recibe 2 PATIENT_NEW (uno por paciente); el ADMIN suspendido no", async () => {
    asUser(kine.userId);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const s = uniqueSuffix();
      const r = await createPatient({ firstName: "Cf", lastName: `Alta ${s}`, documentId: `CF-${s}` });
      if (!r.ok) throw new Error(r.error);
      ids.push(r.data.id);
    }
    const rows = await db.notification.findMany({
      where: { tenantId: T.tenantId, kind: "PATIENT_NEW" },
      select: { userId: true, link: true, title: true, body: true },
    });
    const to = (userId: string) => rows.filter((r) => r.userId === userId);

    expect(to(T.userId).map((r) => r.link).sort()).toEqual(ids.map((id) => `/pacientes/${id}`).sort());
    // El creador lo sigue recibiendo (como antes), una vez por paciente aunque no sea titular.
    expect(to(kine.userId)).toHaveLength(2);
    expect(to(adminSuspended.userId)).toHaveLength(0);
    // Un profesional que no es titular ni creador no se entera.
    expect(to(otherKine.userId)).toHaveLength(0);
    // Sin PHI de más: el título lleva el nombre; DNI y email no viajan en el cuerpo.
    for (const r of rows) {
      expect(r.title).toMatch(/^Nuevo paciente · Cf Alta /);
      expect(r.body).toBeNull();
    }
  });
});
