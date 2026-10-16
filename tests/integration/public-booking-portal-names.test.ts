/**
 * DIR-0 (decisión 19 de Martin, 15-oct): el email NUNCA se muestra como nombre de un profesional.
 *
 * Bug: `fullName ?? email` en el turnero público (`getPublicClinic`), en el estado de reserva público
 * (`getPublicBookingStatus`) y en el portal del paciente (`getPortalAuth`) mostraba el email del profesional
 * a cualquier visitante cuando el perfil no tenía nombre (alta por invitación o Google sin `full_name`).
 *
 * Llama a las funciones REALES contra Postgres; se mockea solo el rate-limit (bucket in-memory por IP
 * «unknown») y la sesión de Supabase (tests/helpers/actor.ts → `<userId>@test.local`, verificado).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPublicClinic, getPublicBookingStatus } from "@/lib/public-booking";
import { getPortalAuth } from "@/lib/portal";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("DIR-0 · el email nunca como nombre del profesional", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let email: string;
  let bookingId: string;
  let patientUid: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    // El profesional de la factory queda SIN nombre (como un alta por invitación o Google sin `full_name`).
    const u = await db.userProfile.update({ where: { id: T.userId }, data: { fullName: null }, select: { email: true } });
    email = u.email;

    patientUid = `test-dir0-${uniqueSuffix()}`;
    const patientId = await addPatient(db, T, { email: `${patientUid}@test.local` });
    // ES4 S24a: el portal autoriza por (tenantId, userId), así que la ficha va vinculada.
    await db.userProfile.create({ data: { id: patientUid, email: `${patientUid}@test.local` } });
    await db.patient.update({ where: { id: patientId }, data: { userId: patientUid } });
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() + 7 * 86_400_000),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    bookingId = b.id;
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.userProfile.deleteMany({ where: { id: patientUid } });
    await db?.$disconnect();
  });

  it("[DIR-0] el turnero muestra el email del profesional sin nombre", async () => {
    const c = (await getPublicClinic(T.slug))!;
    const p = c.practitioners.find((x) => x.id === T.practitionerId)!;
    expect(p).toBeDefined();
    expect(p.name).toBe("Profesional");
    expect(JSON.stringify(c)).not.toContain(email);
  });

  it("[DIR-0] el estado de reserva público muestra el email del profesional sin nombre", async () => {
    const s = (await getPublicBookingStatus(bookingId))!;
    expect(s.practitionerName).toBe("Profesional");
    expect(JSON.stringify(s)).not.toContain(email);
  });

  it("[DIR-0] el portal muestra el email del profesional sin nombre", async () => {
    asUser(patientUid);
    const auth = await getPortalAuth();
    expect(auth.signedIn).toBe(true);
    if (!auth.signedIn) return;
    const up = auth.patients.flatMap((p) => p.upcoming).find((b) => b.id === bookingId)!;
    expect(up.practitionerName).toBe("Profesional");
    expect(JSON.stringify(auth.patients)).not.toContain(email);
  });

  it("[DIR-0] con nombre (con espacios de más) se muestra el nombre recortado", async () => {
    await db.userProfile.update({ where: { id: T.userId }, data: { fullName: "  Lic. Ana Gómez " } });
    try {
      const c = (await getPublicClinic(T.slug))!;
      expect(c.practitioners.find((x) => x.id === T.practitionerId)!.name).toBe("Lic. Ana Gómez");
      expect((await getPublicBookingStatus(bookingId))!.practitionerName).toBe("Lic. Ana Gómez");
      // Solo espacios = sin nombre.
      await db.userProfile.update({ where: { id: T.userId }, data: { fullName: "   " } });
      expect((await getPublicBookingStatus(bookingId))!.practitionerName).toBe("Profesional");
    } finally {
      await db.userProfile.update({ where: { id: T.userId }, data: { fullName: null } });
    }
  });
});
