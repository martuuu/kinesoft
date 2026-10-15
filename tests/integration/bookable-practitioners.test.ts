/**
 * IAM-2e · Secretaria y Facturación fuera de la agenda, el turnero y la
 * disponibilidad (§19.2 decisión 2: Secretaria = staff sin agenda propia).
 *
 * Hoy toda membresía aceptada tiene su fila `Practitioner` (la necesita para
 * entrar hasta IAM-4), y los 8 lugares que listan profesionales filtraban solo
 * por `acceptedAt`: la Secretaria (ASSISTANT) y Facturación (BILLING)
 * aparecían como profesionales reservables. Ahora todos usan
 * `bookablePractitionerWhere(tenantId, { includeDisabledFilter: true })`:
 * membresía aceptada, en un rol clínico (OWNER/ADMIN/PRACTITIONER) y sin
 * `disabledAt`.
 *
 * Símbolos reales contra la DB; solo se mockea la sesión (integration-setup)
 * y el rate-limit del turnero (bucket in-memory por IP "unknown"). Las dos
 * páginas server (Configuración y ficha del paciente) no se pueden renderizar
 * acá: usan el mismo fragmento, que se prueba con la misma forma de query.
 *
 * Anti-false-green: a cada miembro se le da una fila `PractitionerService`
 * PUBLIC y habilitada para el servicio, así el turnero lo listaría si el
 * filtro de rol no estuviera; y los controles (OWNER, PRACTITIONER, ADMIN)
 * tienen que aparecer.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listPractitioners, listAgendaBookings } from "@/lib/bookings";
import { getPublicClinic, listPublicSlots } from "@/lib/public-booking";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { acceptedPractitionerIds } from "@/lib/agenda-defaults";
import { getPractitionerScheduleSummary } from "@/lib/practitioner-schedule";
import { setPatientShares } from "@/lib/patients";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

type Staff = { userId: string; practitionerId: string };

const sorted = (ids: Iterable<string>) => [...ids].sort();

describe.skipIf(!RUN)("IAM-2e · profesionales reservables por rol", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let admin: Staff;
  let kine: Staff;
  let assistant: Staff;
  let billing: Staff;
  /** PRACTITIONER suspendido (`Membership.disabledAt`, M6). */
  let disabledKine: Staff;
  /** Turno viejo asignado a la Secretaria (de antes de IAM-2e). */
  let assistantBookingId: string;
  let bookable: string[];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db); // OWNER con Practitioner
    admin = await addPractitioner(db, A, "ADMIN");
    kine = await addPractitioner(db, A, "PRACTITIONER");
    assistant = await addPractitioner(db, A, "ASSISTANT");
    billing = await addPractitioner(db, A, "BILLING");
    disabledKine = await addPractitioner(db, A, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: disabledKine.userId, tenantId: A.tenantId } },
      data: { disabledAt: new Date() },
    });
    const everyone = [A.practitionerId, admin, kine, assistant, billing, disabledKine].map((s) =>
      typeof s === "string" ? s : s.practitionerId
    );
    await db.practitionerService.createMany({
      data: everyone.map((practitionerId) => ({
        tenantId: A.tenantId,
        practitionerId,
        serviceId: A.serviceId,
        enabled: true,
        visibility: "PUBLIC" as const,
      })),
    });
    const patientId = await addPatient(db, A);
    const start = new Date(Date.now() + 2 * 86_400_000);
    const b = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: assistant.practitionerId,
        patientId,
        serviceId: A.serviceId,
        scheduledFor: start,
        durationMin: 45,
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    assistantBookingId = b.id;
    // PL-Z M1: el Administrador/a legado (con Practitioner y `clinical = true`) tampoco es reservable (§20.17).
    bookable = sorted([A.practitionerId, kine.practitionerId]);
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("[IAM-2e] la Secretaria no aparece en la agenda, el turnero ni la disponibilidad", async () => {
    asUser(A.userId);

    // Agenda, Sala, Planes y avisos de llegada.
    const agenda = await listPractitioners();
    expect(sorted(agenda.map((p) => p.id))).toEqual(bookable);

    // Turnero público: lista del wizard y slots pedidos por id.
    const clinic = await getPublicClinic(A.slug);
    expect(clinic).not.toBeNull();
    expect(sorted(clinic!.practitioners.map((p) => p.id))).toEqual(bookable);
    const day = toARDateKey(new Date(Date.now() + 7 * 86_400_000));
    for (const p of [assistant, billing, disabledKine]) {
      expect(
        await listPublicSlots({ tenantSlug: A.slug, practitionerId: p.practitionerId, serviceId: A.serviceId, date: day })
      ).toEqual([]);
    }

    // Motor de disponibilidad sin `practitionerIds` (= "todos").
    const avail = await loadAvailabilityInputs(db, { tenantId: A.tenantId, from: day, to: day });
    expect(sorted(new Set(avail.templates.map((t) => t.practitionerId)))).toEqual(bookable);

    // Servicio compartido / obra social nueva: a quién se le habilita.
    expect(sorted(await acceptedPractitionerIds(db, A.tenantId))).toEqual(bookable);

    // Configuración → Horarios.
    const summary = await getPractitionerScheduleSummary();
    expect(sorted(summary.map((r) => r.practitionerId))).toEqual(bookable);

    // Pickers de las páginas server (Configuración y ficha del paciente):
    // mismo fragmento, misma forma de query.
    const picker = await db.practitioner.findMany({
      where: bookablePractitionerWhere(A.tenantId, { includeDisabledFilter: true }),
      select: { id: true },
    });
    expect(sorted(picker.map((p) => p.id))).toEqual(bookable);

    // Compartir la ficha: los no clínicos y el suspendido se descartan.
    const patientId = await addPatient(db, A);
    const r = await setPatientShares({
      patientId,
      practitionerIds: [kine.practitionerId, assistant.practitionerId, billing.practitionerId, disabledKine.practitionerId],
    });
    expect(r.ok).toBe(true);
    const shares = await db.patientShare.findMany({ where: { patientId }, select: { practitionerId: true } });
    expect(shares.map((s) => s.practitionerId)).toEqual([kine.practitionerId]);
  });

  it("[IAM-2e] el turno viejo de la Secretaria sigue en la agenda (los turnos se listan por tenant y fecha, no por la lista de profesionales)", async () => {
    asUser(A.userId);
    const rows = await listAgendaBookings({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 10 * 86_400_000),
    });
    const mine = rows.find((r) => r.id === assistantBookingId);
    expect(mine?.practitionerId).toBe(assistant.practitionerId);
    // La fila Practitioner no se borra (la necesita para entrar hasta IAM-4).
    expect(await db.practitioner.count({ where: { id: assistant.practitionerId } })).toBe(1);
  });
});
