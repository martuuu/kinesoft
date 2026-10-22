/**
 * T5 · [TP-3i] `/pagar/[token]` contra Postgres (plan §25.7 «Página pública», C-TP9).
 *
 * Se renderiza la página REAL (`app/(booking)/pagar/[token]/page.tsx`) con el `getPublicPaymentLink` real (canal
 * service, rate limit en memoria) sobre un link creado con la action real (`createPaymentLink`, preferencia en el
 * Mercado Pago FALSO: regla de T5, nada de Mercado Pago real). Se afirma lo que sale en el HTML y lo que queda en la
 * base:
 *   - el nombre del paciente (ni el apellido, DNI, email, celular ni el turno) **no** aparece en el HTML;
 *   - **el GET no escribe**: ni el cobro, ni el turno, ni auditoría, ni mails, ni notificaciones cambian por abrirla
 *     (tampoco con un link vencido por reloj, que el cron vence y la página solo calcula).
 *
 * Mocks: la sesión de Supabase, `next/cache` y `next/headers` (integration-setup), la red (`installFakeMp`) y el router
 * de Next para el poller (`useRouter` fuera del App Router tira).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
import { createPaymentLink } from "@/lib/payment-links";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, addStaff, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { connectFakeAccount, installFakeMp, type InstalledFakeMp } from "@/tests/helpers/mp-connect-fake";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {} }),
}));

import PagarPage from "@/app/(booking)/pagar/[token]/page";
import { PAY_LINK_COPY } from "@/components/payments/pay-link-view";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

describe.skipIf(!RUN)("[TP-3i] /pagar/[token] (página real)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let assistant: { userId: string; membershipId: string };
  let pat: string;
  let kineAccountId = "";
  let fake: InstalledFakeMp;
  // Nombres que no pueden aparecer en ningún otro texto de la página.
  const FIRST = `Zoilo${randomBytes(3).toString("hex")}`;
  const LAST = `Quintanilla${randomBytes(3).toString("hex")}`;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addStaff(db, T, "ASSISTANT");
    pat = await addPatient(db, T, {
      firstName: FIRST,
      lastName: LAST,
      email: `${FIRST.toLowerCase()}@test.local`,
      phone: "1155557777",
      assignedPractitionerId: kine.practitionerId,
    });
    fake = installFakeMp();
    kineAccountId = (await connectFakeAccount(db, T, { practitionerId: kine.practitionerId, linksDelegated: true })).accountId;
  }, 60_000);

  afterAll(async () => {
    fake?.uninstall();
    if (db) {
      await T?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(() => __rateLimitInternals.reset());

  async function seedBooking() {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: pat,
        practitionerId: kine.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() + DAY),
        durationMin: 45,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        copagoCents: 20_000_00,
        idempotencyKey: randomUUID(),
      },
    });
  }

  async function render(token: string, r?: string) {
    return renderToStaticMarkup(await PagarPage({ params: { token }, searchParams: r ? { r } : {} }));
  }

  /** Todo lo que abrir la página podría tocar si escribiera. */
  async function snapshot(chargeId: string, bookingId: string) {
    const [charge, booking, audits, mails, notifs] = await Promise.all([
      db.onlineCharge.findUniqueOrThrow({ where: { id: chargeId } }),
      db.booking.findUniqueOrThrow({ where: { id: bookingId } }),
      db.auditEvent.count({ where: { tenantId: T.tenantId } }),
      db.emailLog.count({ where: { tenantId: T.tenantId } }),
      db.notification.count({ where: { tenantId: T.tenantId } }),
    ]);
    return { charge, booking, audits, mails, notifs };
  }

  it("[TP-3i] para pagar: el nombre del paciente no aparece en el HTML, hay un <a> al checkout y el GET no escribe", async () => {
    const b = await seedBooking();
    asUser(assistant.userId);
    const r = await createPaymentLink({
      patientId: pat,
      bookingId: b.id,
      practitionerId: kine.practitionerId,
      purpose: "REST",
      concept: "Sesión del jueves",
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(r.error);
    const token = new URL(r.data.url).pathname.split("/").pop()!;
    const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: r.data.chargeId } });
    const patient = await db.patient.findUniqueOrThrow({ where: { id: pat } });

    const before = await snapshot(row.id, b.id);
    const html = await render(token);
    const htmlBack = await render(token, "ok");
    const after = await snapshot(row.id, b.id);

    expect(html).toContain(PAY_LINK_COPY.payable.title);
    expect(html).toContain(`href="${row.checkoutUrl!.replace(/&/g, "&amp;")}"`);
    expect(html).toContain("Sesión del jueves");
    expect(htmlBack).toContain(PAY_LINK_COPY.processing.title);
    for (const h of [html, htmlBack]) {
      for (const leak of [FIRST, LAST, patient.documentId!, patient.email!, patient.phone!, b.id, pat, row.id]) {
        expect(h).not.toContain(leak);
      }
    }
    expect(after).toEqual(before);
  });

  it("[TP-3i] vencido por reloj: la página dice «venció» y la fila sigue ACTIVE (lo vence el cron, no el GET)", async () => {
    const b = await seedBooking();
    const token = randomBytes(16).toString("base64url");
    const c = await db.onlineCharge.create({
      data: {
        tenantId: T.tenantId,
        origin: "LINK",
        kind: "FULL",
        mpAccountId: kineAccountId,
        practitionerId: kine.practitionerId,
        patientId: pat,
        bookingId: b.id,
        amountCents: 20_000_00,
        concept: "Vencido",
        publicToken: token,
        createdByUserId: assistant.userId,
        createdAt: new Date(Date.now() - 3 * DAY),
        expiresAt: new Date(Date.now() - DAY),
        idempotencyKey: `link:${randomUUID()}`,
      },
    });
    const before = await snapshot(c.id, b.id);
    const html = await render(token);
    expect(html).toContain(PAY_LINK_COPY.expired.title);
    expect(html).not.toContain(FIRST);
    expect(await snapshot(c.id, b.id)).toEqual(before);
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ACTIVE");
  });

  it("[TP-3i] token desconocido o mal formado → «no encontramos» sin datos de ningún consultorio", async () => {
    for (const t of [randomBytes(16).toString("base64url"), "corto", "../../etc/passwd"]) {
      const html = await render(t);
      expect(html).toContain(PAY_LINK_COPY.missing.title);
      expect(html).not.toContain(T.tenantId);
    }
  });
});
