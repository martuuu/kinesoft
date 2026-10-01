/**
 * `setBusinessHours` arrastra la plantilla POR DEFECTO (integrador B2, handoff
 * de B2.3): mientras no exista el editor por profesional (B3.4), el horario del
 * consultorio es el que define la agenda de quien no tocó su semana. Una
 * plantilla editada NO se toca.
 *
 * Action REAL (`lib/tenant-settings.ts`) con la sesión mockeada; corre con los
 * dos roles (`kinesoft_app` con RLS y owner BYPASSRLS = prod hoy). El FOR UPDATE
 * sobre Tenant tiene que pasar con el rol de la app.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { setBusinessHours } from "@/lib/tenant-settings";
import { ForbiddenError } from "@/lib/session";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("setBusinessHours ↔ plantilla por defecto (integrador B2)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let edited: { userId: string; practitionerId: string };
  let noRows: { userId: string; practitionerId: string };
  let primary: string;
  let other: string;

  /** Plantilla por defecto: lun-sáb, sede principal, horario del tenant (8-19). */
  async function defaultWeek(practitionerId: string, locationId = primary) {
    for (const dow of [1, 2, 3, 4, 5, 6]) {
      await db.practitionerSchedule.create({
        data: { tenantId: A.tenantId, practitionerId, locationId, dow, startMin: 480, endMin: 1140 },
      });
    }
  }
  const rowsOf = (practitionerId: string) =>
    db.practitionerSchedule.findMany({
      where: { practitionerId },
      select: { dow: true, startMin: true, endMin: true },
      orderBy: { dow: "asc" },
    });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db); // 8-19 por default de la columna
    primary = (await db.location.create({ data: { tenantId: A.tenantId, name: "Principal", isPrimary: true } })).id;
    other = (await db.location.create({ data: { tenantId: A.tenantId, name: "Norte", isPrimary: false } })).id;
    edited = await addPractitioner(db, A);
    noRows = await addPractitioner(db, A);
    await defaultWeek(A.practitionerId);
    // Editada: misma forma pero el sábado en otra sede → no es "por defecto".
    await defaultWeek(edited.practitionerId);
    await db.practitionerSchedule.updateMany({
      where: { practitionerId: edited.practitionerId, dow: 6 },
      data: { locationId: other },
    });
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("OWNER con plantilla por defecto sigue el horario; la editada y la vacía no cambian", async () => {
    asUser(A.userId);
    expect(await setBusinessHours({ start: 9, end: 18 })).toEqual({ ok: true, data: undefined });

    const t = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    expect([t.businessHoursStart, t.businessHoursEnd]).toEqual([9, 18]);
    const own = await rowsOf(A.practitionerId);
    expect(own).toHaveLength(6);
    expect(own.every((r) => r.startMin === 540 && r.endMin === 1080)).toBe(true);
    const ed = await rowsOf(edited.practitionerId);
    expect(ed.every((r) => r.startMin === 480 && r.endMin === 1140)).toBe(true);
    // Sin franjas sigue sin franjas (el loader le aplica el fallback del tenant).
    expect(await rowsOf(noRows.practitionerId)).toEqual([]);

    const ev = await db.auditEvent.findFirst({
      where: { tenantId: A.tenantId, action: "tenant.business_hours" },
      orderBy: { createdAt: "desc" },
    });
    expect(ev?.payload).toMatchObject({ start: 9, end: 18, syncedPractitioners: 1 });
  });

  it("un segundo cambio vuelve a arrastrarla (el 'viejo' es el horario ya guardado)", async () => {
    asUser(A.userId);
    expect((await setBusinessHours({ start: 7, end: 20, slotMinutes: 30 })).ok).toBe(true);
    const own = await rowsOf(A.practitionerId);
    expect(own.every((r) => r.startMin === 420 && r.endMin === 1200)).toBe(true);
    expect((await rowsOf(edited.practitionerId)).every((r) => r.startMin === 480)).toBe(true);
  });

  it("rango inválido o rol sin permiso: nada cambia", async () => {
    asUser(A.userId);
    expect((await setBusinessHours({ start: 18, end: 9 })).ok).toBe(false);
    asUser(edited.userId); // PRACTITIONER
    await expect(setBusinessHours({ start: 10, end: 16 })).rejects.toBeInstanceOf(ForbiddenError);
    const t = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    expect([t.businessHoursStart, t.businessHoursEnd]).toEqual([7, 20]);
    expect((await rowsOf(A.practitionerId)).every((r) => r.startMin === 420 && r.endMin === 1200)).toBe(true);
  });
});
