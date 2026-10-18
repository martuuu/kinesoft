/**
 * [AS-1s] Profesional reservable en el turnero y en los write paths de Configuración (plan §23.2 / §23.5).
 *
 * Por qué:
 *  - `bookablePractitionerWhere` (lib/practitioner-scope.ts) miraba solo la MEMBRESÍA (aceptada, rol que atiende, sin
 *    `Membership.disabledAt`). Un usuario deshabilitado en Plataforma (`UserProfile.disabledAt`, BO0/M7: no entra a
 *    ningún consultorio) seguía en el turnero, la agenda y la disponibilidad, y se le podían reservar turnos.
 *  - Los write paths de servicios, horarios, servicios por profesional y coberturas validaban el profesional solo
 *    contra el tenant: a un profesional suspendido (o a la Secretaria con su fila `Practitioner` vieja) se le podía
 *    asignar un servicio, cargar franjas o excepciones y habilitar servicios/coberturas.
 *
 * Símbolos REALES contra Postgres en los dos roles; se mockea solo la sesión (integration-setup) y el rate-limit
 * in-memory del turnero. Anti-false-green: a todos se les da una fila `PractitionerService` PUBLIC habilitada, y cada
 * rechazo tiene su control (el mismo pedido con un profesional activo pasa).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import type { PrismaClient } from "@prisma/client";
import { listPractitioners } from "@/lib/bookings";
import { getPublicClinic, listPublicSlots } from "@/lib/public-booking";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { acceptedPractitionerIds } from "@/lib/agenda-defaults";
import { createService, updateService } from "@/lib/services";
import { savePractitionerWeek, upsertException } from "@/lib/practitioner-schedule";
import { listPractitionerServices, upsertPractitionerService } from "@/lib/practitioner-services";
import { listPractitionerPayers, setPractitionerPayers } from "@/lib/practitioner-payers";
import { toARDateKey } from "@/lib/datetime-ar";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

type Prac = { userId: string; practitionerId: string };
const sorted = (ids: Iterable<string>) => [...ids].sort();

const PS = { enabled: true, visibility: "PUBLIC" as const, concurrencyOverride: false, notifyOnBooking: false };
const week = (locationId: string) => [{ dow: 1, startMin: 540, endMin: 720, locationId }];

describe.skipIf(!RUN)("[AS-1s] profesional reservable: turnero y write paths", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let kine: Prac;
  /** Suspendido en el consultorio (`Membership.disabledAt`, M6). */
  let suspended: Prac;
  /** Deshabilitado en Plataforma (`UserProfile.disabledAt`, M7) con la membresía intacta. */
  let platformOff: Prac;
  /** Secretaria con fila `Practitioner` vieja (antes de IAM-4a). */
  let assistant: Prac;
  let locationId: string;
  let bookable: string[];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    kine = await addPractitioner(db, A, "PRACTITIONER");
    suspended = await addPractitioner(db, A, "PRACTITIONER");
    platformOff = await addPractitioner(db, A, "PRACTITIONER");
    assistant = await addPractitioner(db, A, "ASSISTANT");
    await db.membership.update({
      where: { userId_tenantId: { userId: suspended.userId, tenantId: A.tenantId } },
      data: { disabledAt: new Date() },
    });
    await db.userProfile.update({
      where: { id: platformOff.userId },
      data: { disabledAt: new Date(), disabledReason: "Deshabilitado por el test" },
    });
    await db.practitionerService.createMany({
      data: [A.practitionerId, kine, suspended, platformOff, assistant].map((p) => ({
        tenantId: A.tenantId,
        practitionerId: typeof p === "string" ? p : p.practitionerId,
        serviceId: A.serviceId,
        enabled: true,
        visibility: "PUBLIC" as const,
      })),
    });
    locationId = (await db.location.create({ data: { tenantId: A.tenantId, name: "Principal", isPrimary: true } })).id;
    bookable = sorted([A.practitionerId, kine.practitionerId]);
  }, 60_000);

  afterAll(async () => {
    await A?.cleanup();
    if (db) {
      await db.userProfile.deleteMany({ where: { id: { in: [kine, suspended, platformOff, assistant].map((p) => p?.userId).filter(Boolean) } } });
      await db.$disconnect();
    }
  });

  it("turnero, agenda y disponibilidad dejan afuera al usuario deshabilitado en Plataforma", async () => {
    asUser(A.userId);
    const clinic = await getPublicClinic(A.slug);
    expect(clinic).not.toBeNull();
    expect(sorted(clinic!.practitioners.map((p) => p.id))).toEqual(bookable);

    // Un día hábil (el horario heredado del consultorio es de lunes a viernes): hoy + 7 puede caer en domingo.
    let day = toARDateKey(new Date(Date.now() + 7 * 86_400_000));
    for (let n = 8; [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay()); n++) {
      day = toARDateKey(new Date(Date.now() + n * 86_400_000));
    }
    const slots = (practitionerId: string) =>
      listPublicSlots({ tenantSlug: A.slug, practitionerId, serviceId: A.serviceId, date: day });
    expect(await slots(platformOff.practitionerId)).toEqual([]);
    // Control: el mismo pedido para un profesional activo trae horarios (sin franjas hereda el horario del consultorio).
    expect((await slots(kine.practitionerId)).length).toBeGreaterThan(0);

    expect(sorted((await listPractitioners()).map((p) => p.id))).toEqual(bookable);
    const avail = await loadAvailabilityInputs(db, { tenantId: A.tenantId, from: day, to: day });
    expect(sorted(new Set(avail.templates.map((t) => t.practitionerId)))).toEqual(bookable);
    expect(sorted(await acceptedPractitionerIds(db, A.tenantId))).toEqual(bookable);
  });

  it("servicio: no se asigna a un profesional suspendido, deshabilitado ni a la Secretaria (sí a uno activo)", async () => {
    asUser(A.userId);
    for (const p of [suspended, platformOff, assistant]) {
      const r = await createService({ name: `Svc ${p.practitionerId}`, durationMin: 30, priceCents: 0, practitionerId: p.practitionerId });
      expect(r.ok).toBe(false);
      expect(await db.service.count({ where: { tenantId: A.tenantId, name: `Svc ${p.practitionerId}` } })).toBe(0);
    }
    const ok = await createService({ name: "Svc kine", durationMin: 30, priceCents: 0, practitionerId: kine.practitionerId });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;

    // Pasarlo a un suspendido: rechazo y el dueño no cambia.
    const moved = await updateService(ok.data.id, { practitionerId: suspended.practitionerId });
    expect(moved.ok).toBe(false);
    expect((await db.service.findUniqueOrThrow({ where: { id: ok.data.id } })).practitionerId).toBe(kine.practitionerId);
  });

  it("servicio que YA era de un suspendido: editar el precio con el mismo profesional sigue andando", async () => {
    // El formulario manda todos los campos: si el dueño actual (suspendido) bloqueara el guardado, el consultorio no
    // podría ni corregir un precio de ese servicio hasta reactivarlo o reasignarlo.
    asUser(A.userId);
    const svc = await db.service.create({
      data: { tenantId: A.tenantId, practitionerId: suspended.practitionerId, name: "Svc viejo", durationMin: 30 },
    });
    const r = await updateService(svc.id, { name: "Svc viejo", priceCents: 1234, practitionerId: suspended.practitionerId });
    expect(r.ok).toBe(true);
    expect((await db.service.findUniqueOrThrow({ where: { id: svc.id } })).priceCents).toBe(1234);
  });

  it("horarios: franjas y excepciones de un suspendido o deshabilitado → rechazo sin escribir", async () => {
    asUser(A.userId);
    for (const p of [suspended, platformOff, assistant]) {
      expect((await savePractitionerWeek(p.practitionerId, week(locationId))).ok).toBe(false);
      expect((await upsertException({ practitionerId: p.practitionerId, date: "2031-03-03", kind: "CLOSED" })).ok).toBe(false);
      expect(await db.practitionerSchedule.count({ where: { practitionerId: p.practitionerId } })).toBe(0);
      expect(await db.scheduleException.count({ where: { practitionerId: p.practitionerId } })).toBe(0);
    }
    expect((await savePractitionerWeek(kine.practitionerId, week(locationId))).ok).toBe(true);
    expect((await upsertException({ practitionerId: kine.practitionerId, date: "2031-03-03", kind: "CLOSED" })).ok).toBe(true);
  });

  it("servicios por profesional y coberturas: suspendido o deshabilitado → rechazo (lectura y escritura)", async () => {
    asUser(A.userId);
    for (const p of [suspended, platformOff, assistant]) {
      const before = await db.practitionerService.findMany({ where: { practitionerId: p.practitionerId }, select: { enabled: true } });
      expect((await upsertPractitionerService(p.practitionerId, A.serviceId, { ...PS, enabled: false })).ok).toBe(false);
      expect(await db.practitionerService.findMany({ where: { practitionerId: p.practitionerId }, select: { enabled: true } })).toEqual(before);
      expect((await setPractitionerPayers(p.practitionerId, [])).ok).toBe(false);
      expect(await db.practitionerPayer.count({ where: { practitionerId: p.practitionerId } })).toBe(0);
      expect((await listPractitionerServices(p.practitionerId)).ok).toBe(false);
      expect((await listPractitionerPayers(p.practitionerId)).ok).toBe(false);
    }
    expect((await upsertPractitionerService(kine.practitionerId, A.serviceId, PS)).ok).toBe(true);
    expect((await setPractitionerPayers(kine.practitionerId, [])).ok).toBe(true);
    expect((await listPractitionerServices(kine.practitionerId)).ok).toBe(true);
    expect((await listPractitionerPayers(kine.practitionerId)).ok).toBe(true);
  });
});
