/**
 * CF3 · [CF3-PRC2-*] El precio del profesional (D-CF3-1, enmienda AUDIT §5.5) llega a TODOS los lectores de la
 * escalera fuera de `lib/bookings.ts`: preview del modal (`getPatientBillingPreview`), perfil del paciente (resumen y
 * Facturación), «Próximos turnos» del dashboard, link de pago (`resolveLinkCopagoInTx`) y cobro del turnero
 * (`resolvePublicCopagoCents`). Paridad por profesional: el mismo turno da el mismo monto en todos lados.
 *
 * Escenario: un servicio de $ 50 (5000) con dos profesionales. B cobra $ 90 (PractitionerService.priceCents = 9000);
 * el Titular A no tiene precio propio (NULL → hereda, idéntico a hoy). La fila «Particular» del consultorio vale $ 25.
 *   - particular sin cobertura        → B: 9000 (profesional) · A: 2500 (Particular)
 *   - cobertura a la fila Particular  → B: 9000 (profesional) · A: 2500 (copago de la fila)
 *   - OS real con copago $ 8          → 800 con los dos (la OS manda)
 *   - OS libre sin fila (insurerId null) → B: 9000 · A: 5000 (servicio)
 *   - copago propio $ 30              → 3000 con los dos
 * Corre en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS). Se mockea solo la red (nada acá la usa).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPatientBillingPreview, getPatientBookingsAll, getPatientBookingsSummary } from "@/lib/patients";
import { getDashboardData } from "@/lib/dashboard";
import { listBookingsInRange } from "@/lib/bookings";
import { resolveLinkCopagoInTx } from "@/lib/payment-links-internal";
import { resolvePublicCopagoCents } from "@/lib/public-booking-charge-internal";
import { runWithRls } from "@/lib/rls";
import { formatARS } from "@/lib/format";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addInsurer,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const SERVICE = 5000;
const PRO_B = 9000;
const PARTICULAR = 2500;
const OS_COPAGO = 800;
const OWN = 3000;

type Case = { name: string; patientId: string; b: number; a: number; sourceB: string; sourceA: string };

describe.skipIf(!RUN)("[CF3-PRC2] escalera con el precio del profesional en los lectores de fuera de la agenda", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let X: EphemeralTenant;
  let B: { userId: string; practitionerId: string };
  const cases: Case[] = [];
  /** turno por (paciente, profesional), en el futuro para el dashboard. */
  const bookingOf = new Map<string, string>();
  let slot = 0;
  const base = Date.now() + 3 * 86_400_000;

  async function addBooking(patientId: string, practitionerId: string): Promise<string> {
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(base + slot++ * 3_600_000),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
        copagoCents: null,
      },
    });
    return b.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    X = await createEphemeralTenant(db);
    B = await addPractitioner(db, T);
    await db.insurer.update({ where: { id: T.particularInsurerId }, data: { copagoCents: PARTICULAR } });
    await db.practitionerService.create({
      data: { tenantId: T.tenantId, practitionerId: B.practitionerId, serviceId: T.serviceId, priceCents: PRO_B },
    });
    // Precio de un profesional de OTRO consultorio: nunca tiene que aparecer en T.
    await db.practitionerService.create({
      data: { tenantId: X.tenantId, practitionerId: X.practitionerId, serviceId: X.serviceId, priceCents: 7777 },
    });

    const part = await addPatient(db, T);
    const rowPart = await addPatient(db, T);
    await db.coverage.create({ data: { patientId: rowPart, insurer: "Particular", insurerId: T.particularInsurerId } });
    const os = await addPatient(db, T);
    const osde = await addInsurer(db, T, { name: "OSDE", copagoCents: OS_COPAGO });
    await db.coverage.create({ data: { patientId: os, insurer: "OSDE", insurerId: osde } });
    const free = await addPatient(db, T);
    await db.coverage.create({ data: { patientId: free, insurer: "Mutual Libre", insurerId: null } });
    const own = await addPatient(db, T);
    await db.coverage.create({ data: { patientId: own, insurer: "OSDE", insurerId: osde, copagoCents: OWN } });

    cases.push(
      { name: "particular", patientId: part, b: PRO_B, a: PARTICULAR, sourceB: "precio del profesional", sourceA: "Particular" },
      { name: "fila Particular", patientId: rowPart, b: PRO_B, a: PARTICULAR, sourceB: "precio del profesional", sourceA: "Particular" },
      { name: "OS con copago", patientId: os, b: OS_COPAGO, a: OS_COPAGO, sourceB: "OS", sourceA: "OS" },
      { name: "OS libre", patientId: free, b: PRO_B, a: SERVICE, sourceB: "precio del profesional", sourceA: "precio del servicio" },
      { name: "copago propio", patientId: own, b: OWN, a: OWN, sourceB: "copago propio", sourceA: "copago propio" }
    );
    for (const c of cases) {
      bookingOf.set(`${c.patientId}:B`, await addBooking(c.patientId, B.practitionerId));
      bookingOf.set(`${c.patientId}:A`, await addBooking(c.patientId, T.practitionerId));
    }
    asUser(T.userId);
  });

  afterAll(async () => {
    await T?.cleanup();
    await X?.cleanup();
    await db?.$disconnect();
  });

  it("[CF3-PRC2-1] preview del modal: con el profesional entra a la escalera y etiqueta la fuente", async () => {
    for (const c of cases) {
      expect(await getPatientBillingPreview(c.patientId, T.serviceId, B.practitionerId), `${c.name} · B`).toMatchObject({
        copagoCents: c.b,
        source: c.sourceB,
        serviceId: T.serviceId,
      });
      expect(await getPatientBillingPreview(c.patientId, T.serviceId, T.practitionerId), `${c.name} · A`).toMatchObject({
        copagoCents: c.a,
        source: c.sourceA,
      });
    }
  });

  it("[CF3-PRC2-2] preview sin profesional = conducta de hoy; profesional ajeno o inexistente = sin precio propio", async () => {
    for (const c of cases) {
      const today = await getPatientBillingPreview(c.patientId, T.serviceId);
      expect(today, c.name).toMatchObject({ copagoCents: c.a, source: c.sourceA });
      expect(await getPatientBillingPreview(c.patientId, T.serviceId, X.practitionerId), `${c.name} · ajeno`).toEqual(today);
      expect(await getPatientBillingPreview(c.patientId, T.serviceId, "no-existe"), `${c.name} · inexistente`).toEqual(today);
    }
  });

  it("[CF3-PRC2-3] link de pago y cobro del turnero = preview, por profesional", async () => {
    for (const c of cases) {
      for (const [who, pro, want] of [
        ["B", B.practitionerId, c.b],
        ["A", T.practitionerId, c.a],
      ] as const) {
        const [link, publicCharge] = await runWithRls(T.tenantId, async (tx) => [
          await resolveLinkCopagoInTx(tx, T.tenantId, {
            copagoCents: null,
            patientId: c.patientId,
            serviceId: T.serviceId,
            practitionerId: pro,
          }),
          await resolvePublicCopagoCents(tx, {
            tenantId: T.tenantId,
            patientId: c.patientId,
            practitionerId: pro,
            serviceId: T.serviceId,
            servicePriceCents: SERVICE,
            contactMismatch: false,
          }),
        ]);
        expect(link, `${c.name} · ${who} · link`).toBe(want);
        expect(publicCharge, `${c.name} · ${who} · turnero`).toBe(want);
      }
    }
  });

  it("[CF3-PRC2-4] turnero con contacto distinto (TP-D22): particular con el precio del profesional, sin leer la cobertura", async () => {
    const os = cases.find((c) => c.name === "OS con copago")!;
    const got = await runWithRls(T.tenantId, (tx) =>
      resolvePublicCopagoCents(tx, {
        tenantId: T.tenantId,
        patientId: os.patientId,
        practitionerId: B.practitionerId,
        serviceId: T.serviceId,
        servicePriceCents: SERVICE,
        contactMismatch: true,
      })
    );
    expect(got).toBe(PRO_B);
  });

  it("[CF3-PRC2-5] perfil del paciente (resumen y Facturación) = preview, por profesional", async () => {
    for (const c of cases) {
      const summary = await getPatientBookingsSummary(c.patientId, 10);
      const all = (await getPatientBookingsAll(c.patientId)).rows;
      for (const [who, want] of [
        ["B", c.b],
        ["A", c.a],
      ] as const) {
        const id = bookingOf.get(`${c.patientId}:${who}`);
        expect(summary.find((r) => r.id === id)?.copagoCents, `${c.name} · ${who} · resumen`).toBe(want);
        expect(all.find((r) => r.id === id)?.copagoCents, `${c.name} · ${who} · Facturación`).toBe(want);
      }
    }
  });

  it("[CF3-PRC2-6] dashboard «Próximos turnos»: el monto de la línea usa el precio del profesional", async () => {
    // Los dos primeros turnos del tenant son del particular: B (9000) y A (2500). El dashboard trae los 3 próximos.
    const { next } = await getDashboardData();
    const part = cases[0];
    const rowB = next.find((r) => r.id === bookingOf.get(`${part.patientId}:B`));
    const rowA = next.find((r) => r.id === bookingOf.get(`${part.patientId}:A`));
    expect(rowB?.tag).toBe(`Consulta - ${formatARS(PRO_B)}`);
    expect(rowA?.tag).toBe(`Consulta - ${formatARS(PARTICULAR)}`);
  });

  it("[CF3-PRC2-7] agenda (lib/bookings.ts, PR-C1) = preview, por profesional", async () => {
    const from = new Date(base - 3_600_000);
    const rows = await listBookingsInRange({ from, to: new Date(base + (slot + 1) * 3_600_000) });
    for (const c of cases) {
      for (const [who, want] of [
        ["B", c.b],
        ["A", c.a],
      ] as const) {
        const id = bookingOf.get(`${c.patientId}:${who}`);
        expect(rows.find((r) => r.id === id)?.copagoCents, `${c.name} · ${who} · agenda`).toBe(want);
      }
    }
  });
});
