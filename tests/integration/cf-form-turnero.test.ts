/**
 * CF-FORM (§28, decisión 5 de Martin, brief CF «D · Formulario del turnero»): en el turnero público los obligatorios son
 * nombre, apellido, DNI, email, teléfono y el «diagnóstico» de la vertical (Kinesiología: `title` «Diagnóstico»;
 * General: `notes` «Motivo de consulta»). La fecha de nacimiento pasa a ser opcional.
 *
 * `submitPublicBooking` REAL contra Postgres, en el canal de servicio (sin Actor, como en prod). La vertical que manda
 * es la de la fila del consultorio (server): el cliente no la manda. Se mockea solo el rate-limit.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { submitPublicBooking, listPublicSlots } from "@/lib/public-booking";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addService,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Un día hábil (no domingo) entre 7 y 13 días adelante, en calendario AR. */
function futureWeekday(offset = 0): string {
  for (let d = 7 + offset; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) return key;
  }
}

describe.skipIf(!RUN)("CF-FORM · formulario del turnero", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kinesiología (default de la base)
  let G: EphemeralTenant; // General
  let kSvc: string;
  let gSvc: string;
  const DAY = futureWeekday();

  type PatientOverrides = Partial<SubmitPublicBookingInput["patient"]> & { dateOfBirth?: string | null };
  function input(T: EphemeralTenant, serviceId: string, slot: string, patient: PatientOverrides): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: randomUUID(),
      practitionerId: T.practitionerId,
      serviceId,
      scheduledFor: slot,
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        documentId: `4${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`,
        ...patient,
      } as SubmitPublicBookingInput["patient"],
    };
  }
  async function freeSlot(T: EphemeralTenant, serviceId: string, nth = 0): Promise<string> {
    const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId, date: DAY });
    const free = slots.filter((x) => x.available);
    if (!free[nth]) throw new Error("sin horarios libres en el día de prueba");
    return free[nth].iso;
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    K = await createEphemeralTenant(db);
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    kSvc = await addService(db, K, { name: "Evaluación", durationMin: 60, priceCents: 0, maxConcurrent: 4 });
    gSvc = await addService(db, G, { name: "Consulta", durationMin: 60, priceCents: 0, maxConcurrent: 4 });
  });
  afterAll(async () => {
    await K?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  it("[CF-D1] Kine: reserva sin fecha de nacimiento (\"\", ausente o null) → ok y la ficha queda con dateOfBirth null", async () => {
    const slot = await freeSlot(K, kSvc);
    for (const dob of ["", undefined, null] as const) {
      const req = input(K, kSvc, slot, { title: "Lumbalgia", ...(dob === undefined ? {} : { dateOfBirth: dob }) });
      if (dob === undefined) delete (req.patient as { dateOfBirth?: unknown }).dateOfBirth;
      const r = await submitPublicBooking(req);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      const b = await db.booking.findUniqueOrThrow({
        where: { id: r.data.bookingId },
        select: { title: true, patient: { select: { dateOfBirth: true, documentId: true } } },
      });
      expect(b.title).toBe("Lumbalgia");
      expect(b.patient?.documentId).toBe(req.patient.documentId);
      expect(b.patient?.dateOfBirth).toBeNull();
    }
  });

  it("[CF-D1] con fecha válida se guarda en UTC-medianoche (AUDIT §5.11) e inválida/futura/anterior a 1900 → error como hoy", async () => {
    const slot = await freeSlot(K, kSvc);
    const ok = await submitPublicBooking(input(K, kSvc, slot, { title: "Esguince", dateOfBirth: "1990-05-10" }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    if (!ok.ok) return;
    const b = await db.booking.findUniqueOrThrow({
      where: { id: ok.data.bookingId },
      select: { patient: { select: { dateOfBirth: true } } },
    });
    expect(b.patient?.dateOfBirth?.toISOString()).toBe("1990-05-10T00:00:00.000Z");

    const nextYear = `${new Date().getUTCFullYear() + 1}-01-01`;
    for (const bad of ["no-es-fecha", "1899-12-31", nextYear]) {
      const before = await db.patient.count({ where: { tenantId: K.tenantId } });
      const r = await submitPublicBooking(input(K, kSvc, slot, { title: "Esguince", dateOfBirth: bad }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe("Datos inválidos");
      expect(JSON.stringify(r.fieldErrors)).toContain("Fecha de nacimiento inválida");
      expect(await db.patient.count({ where: { tenantId: K.tenantId } })).toBe(before);
    }
  });

  it("[CF-D2] Kine sin diagnóstico → fieldErrors.title con «diagnóstico» y nada escrito; el motivo sigue opcional", async () => {
    const slot = await freeSlot(K, kSvc, 1);
    const before = await db.patient.count({ where: { tenantId: K.tenantId } });
    for (const title of [undefined, "", "   "]) {
      const r = await submitPublicBooking(input(K, kSvc, slot, { title, notes: "Me duele la espalda" }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.fieldErrors?.title?.[0]).toMatch(/diagnóstico/i);
      expect(r.fieldErrors?.notes).toBeUndefined();
    }
    expect(await db.patient.count({ where: { tenantId: K.tenantId } })).toBe(before);
    expect(await db.booking.count({ where: { tenantId: K.tenantId, scheduledFor: new Date(slot) } })).toBe(0);

    // Con diagnóstico y sin motivo: reserva.
    const ok = await submitPublicBooking(input(K, kSvc, slot, { title: "Cervicalgia" }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
  });

  it("[CF-D2] General sin motivo de consulta → fieldErrors.notes con «motivo de consulta»; el diagnóstico no se pide", async () => {
    const slot = await freeSlot(G, gSvc);
    const before = await db.patient.count({ where: { tenantId: G.tenantId } });
    for (const notes of [undefined, "", "  "]) {
      // Un `title` armado a mano no reemplaza al motivo: en General el campo no existe en la UI.
      const r = await submitPublicBooking(input(G, gSvc, slot, { notes, title: "Lumbalgia" }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.fieldErrors?.notes?.[0]).toMatch(/motivo de consulta/i);
      expect(r.fieldErrors?.title).toBeUndefined();
    }
    expect(await db.patient.count({ where: { tenantId: G.tenantId } })).toBe(before);

    const ok = await submitPublicBooking(input(G, gSvc, slot, { notes: "Control anual" }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    if (!ok.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: ok.data.bookingId }, select: { notes: true } });
    expect(b.notes).toContain("Control anual");
  });
});
