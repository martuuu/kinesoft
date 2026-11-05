/**
 * CF3 · fixer ZF2 · lecturas con bordes que el cierre de CF3 encontró, contra la DB real (dos roles).
 *
 *   - [CF3-ZF2-3] `getPatientCore` (`patientCoreInTx`): el «próximo turno» de las ramas `admin` (Secretaria) y `basic`
 *     (kine sin el paciente) contaba un NO_SHOW futuro (un ausente marcado por adelantado) como el próximo turno. El
 *     bundle de compartir y el perfil `full` (`patientUpcomingBookingsInTx`) ya excluían CANCELLED y NO_SHOW: misma regla.
 *   - [CF3-ZF2-5] `listExceptions` con un rango inválido tiraba `Error` genérico (500 en prod, sin copy). Ahora devuelve
 *     `ActionResult` con un mensaje accionable; el camino feliz trae las filas en `data`.
 * Solo se mockea la sesión (tests/helpers/actor).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPatientCore } from "@/lib/patients";
import { listExceptions } from "@/lib/practitioner-schedule";
import { toARDateKey } from "@/lib/datetime-ar";
import { addDays as addDaysToDayKey } from "@/lib/availability/day";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

describe.skipIf(!RUN)("[CF3-ZF2] lecturas", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let secretaria: { userId: string };
  let kineBasico: { userId: string };
  let patientId: string;
  let realNext: Date;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { sharedPatientView: false });
    secretaria = await addPractitioner(db, T, "ASSISTANT");
    kineBasico = await addPractitioner(db, T, "PRACTITIONER");
    patientId = await addPatient(db, T, { firstName: "Nora" });
    const mk = (at: Date, status: "CONFIRMED" | "CANCELLED" | "NO_SHOW") =>
      db.booking.create({
        data: {
          tenantId: T.tenantId,
          patientId,
          practitionerId: T.practitionerId,
          serviceId: T.serviceId,
          scheduledFor: at,
          durationMin: 45,
          status,
          idempotencyKey: randomUUID(),
        },
      });
    const now = Date.now();
    await mk(new Date(now + 1 * DAY), "NO_SHOW");
    await mk(new Date(now + 2 * DAY), "CANCELLED");
    realNext = new Date(now + 3 * DAY);
    await mk(realNext, "CONFIRMED");
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("[CF3-ZF2-3] admin y basic: el próximo turno saltea el ausente y el cancelado (control: full igual)", async () => {
    for (const [who, access] of [
      [secretaria.userId, "admin"],
      [kineBasico.userId, "basic"],
      [T.userId, "full"],
    ] as const) {
      asUser(who);
      const core = await getPatientCore(patientId);
      expect(core?.access, who).toBe(access);
      if (access === "full") continue; // la rama full no tiene `nextBookingAt` (el perfil usa `nextBooking`)
      expect((core as { nextBookingAt: Date | null }).nextBookingAt?.getTime(), access).toBe(realNext.getTime());
    }
  });

  it("[CF3-ZF2-5] listExceptions: rango inválido → ok:false con copy accionable; válido → ok:true con data", async () => {
    asUser(T.userId);
    const today = toARDateKey(new Date());
    const bad = [
      { from: "2026-13-01", to: "2026-13-31" },
      { from: addDaysToDayKey(today, 5), to: today },
      { from: today, to: addDaysToDayKey(today, 401) },
    ];
    for (const r of bad) {
      expect(await listExceptions({ ...r, practitionerId: T.practitionerId }), JSON.stringify(r)).toEqual({
        ok: false,
        error: "Revisá el rango de fechas: «desde» no puede ser posterior a «hasta» y el rango abarca como mucho 400 días.",
      });
    }
    await db.scheduleException.create({
      data: { tenantId: T.tenantId, practitionerId: T.practitionerId, date: new Date(`${today}T00:00:00.000Z`), kind: "CLOSED", createdById: T.userId },
    });
    const ok = await listExceptions({ from: today, to: addDaysToDayKey(today, 30), practitionerId: T.practitionerId });
    expect(ok).toMatchObject({ ok: true, data: [{ practitionerId: T.practitionerId, date: today, kind: "CLOSED" }] });
  });
});
