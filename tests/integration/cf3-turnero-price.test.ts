/**
 * CF3 (§30, PR-P) · precio por profesional en el turnero REAL contra Postgres (canal service, los 2 roles con
 * `test:integration` y `test:integration:owner`) y Mercado Pago FALSO (`installFakeMp`: solo la red).
 *
 *   - `getPublicClinic`: `particularQuotes` por profesional (D-CF3-1) y SOLO de los que muestran el precio (D-CF3-3):
 *     ningún número de un profesional oculto en el payload; la fila «Particular» se lee SIEMPRE, en la misma lectura de
 *     coberturas (1 sentencia de Insurer, con o sin cobro); `insuredContactAvailable` sin el número; `clinicPhone`.
 *   - submit: cobra con la escalera nueva (profesional, fila «Particular» con `insurerIsParticular`, OS real) y lo que
 *     el wizard promete (helpers reales de `public-wizard-state`) es lo que cobra (paridad de `tp2t-turnero-cobro`).
 *   - estado del turno: el resto de la seña sobre el precio del profesional; sin cobro, el precio oculto no sale.
 *   - `getInsuredContact` (D-CF3-5): opt-in + consentimiento v2 + reservable en ESE consultorio, rate limit propio.
 * `@/lib/db` solo se instrumenta (contador de sentencias); el rate limit se reemplaza por uno que el test controla.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});
const rl = vi.hoisted(() => ({ blocked: new Set<string>(), keys: [] as string[] }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async (key: string) => {
    rl.keys.push(key);
    const blocked = [...rl.blocked].some((p) => key.startsWith(p));
    return { ok: !blocked, remaining: blocked ? 0 : 99, retryAfterMs: 0 };
  },
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  getInsuredContact,
  getPublicBookingStatus,
  getPublicClinic,
  listPublicSlots,
  submitPublicBooking,
} from "@/lib/public-booking";
import type { PublicClinic, SubmitPublicBookingInput } from "@/lib/public-booking-types";
import {
  amountDiffers,
  checkoutCopyFor,
  checkoutPricingFor,
  particularQuoteFor,
  quotedForInterstitial,
  wizardOnlinePaymentFor,
  type WizardCoverage,
} from "@/lib/public-wizard-state";
import { INSURED_CONTACT_MESSAGE } from "@/lib/public-insured-contact";
import { LEAD_CONTACT_CONSENT_VERSION, LEAD_CONTACT_CONSENT_VERSION_V1 } from "@/lib/public-lead-contact";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { connectFakeAccount, installFakeMp, setPaymentPolicy, type InstalledFakeMp } from "@/tests/helpers/mp-connect-fake";
import { measure } from "@/tests/helpers/query-counter";
import {
  addInsurer,
  addPatient,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const SERVICE_PRICE = 10_000_00;
const PARTICULAR = 8_000_00;
const A_PRICE = 15_000_00; // titular, precio visible
const B_PRICE = 9_123_00; // segundo profesional, precio OCULTO (número distintivo para buscarlo en el payload)
const OSDE_COPAGO = 2_000_00;
const B_WA = "+5491123456789";
const CLINIC_PHONE = "011 4567-8901";

function weekdays(): string[] {
  const out: string[] = [];
  for (let d = 3; d <= 25; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) out.push(key);
  }
  return out;
}

describe.skipIf(!RUN)("[CF3-PRP] turnero: precio por profesional, precio oculto y contacto para obra social", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let other: EphemeralTenant;
  let fake: InstalledFakeMp;
  let svc: string;
  let svcB: string;
  let osde: string;
  let A: string;
  let B: string;
  const DAYS = weekdays();
  const used = new Set<string>();

  function input(o: {
    practitionerId: string;
    slot: string;
    serviceId?: string;
    patient?: { documentId: string; email: string; phone: string };
    coverageInsurer?: string;
  }): SubmitPublicBookingInput {
    const n = Math.floor(Math.random() * 1e8);
    return {
      tenantSlug: T.slug,
      idempotencyKey: randomUUID(),
      practitionerId: o.practitionerId,
      serviceId: o.serviceId ?? svc,
      scheduledFor: o.slot,
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: o.patient?.email ?? `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: o.patient?.phone ?? `11${n.toString().padStart(8, "0")}`,
        documentId: o.patient?.documentId ?? `${30_000_000 + (n % 9_000_000)}`,
        dateOfBirth: "1990-05-10",
        title: "Lumbalgia",
        ...(o.coverageInsurer ? { coverageInsurer: o.coverageInsurer } : {}),
      },
    };
  }

  async function freeSlot(practitionerId: string, serviceId = svc): Promise<string> {
    for (const date of DAYS) {
      const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId, serviceId, date });
      const s = slots.find((x) => x.available && !used.has(`${practitionerId}|${x.iso}`));
      if (s) {
        used.add(`${practitionerId}|${s.iso}`);
        return s.iso;
      }
    }
    throw new Error("sin horarios libres en los días de prueba");
  }

  /** Lo que el wizard (PR-W) muestra con el payload REAL: mismos helpers que `public-booking-wizard.tsx`. */
  async function wizard(practitionerId: string, cov?: WizardCoverage) {
    const clinic = (await getPublicClinic(T.slug)) as PublicClinic;
    const service = clinic.services.find((s) => s.id === svc)!;
    const payment = wizardOnlinePaymentFor(clinic, practitionerId, service.priceCents, cov, svc);
    const checkout = checkoutCopyFor({ payment, choice: null, ...checkoutPricingFor(clinic, practitionerId, svc, cov) });
    return { clinic, payment, checkout, quoted: quotedForInterstitial(payment, checkout.online) };
  }

  const chargesOf = (bookingId: string) => db.onlineCharge.findMany({ where: { bookingId } });

  /** Ficha existente cuyo contacto coincide con el que se tipea (sin TP-D22) y con cobertura a `insurerId`. */
  async function existingPatient(insurerId: string, insurerName: string) {
    const n = Math.floor(Math.random() * 1e8);
    const p = {
      documentId: `${20_000_000 + (n % 9_000_000)}`,
      email: `ex-${randomUUID().slice(0, 8)}@test.local`,
      phone: `11${n.toString().padStart(8, "0")}`,
    };
    const patientId = await addPatient(db, T, { firstName: "Ana", lastName: "Pérez", ...p });
    await db.coverage.create({ data: { patientId, insurer: insurerName, insurerId } });
    return p;
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    other = await createEphemeralTenant(db);
    A = T.practitionerId;
    B = (await addPractitioner(db, T)).practitionerId;
    await db.tenant.update({ where: { id: T.tenantId }, data: { phone: CLINIC_PHONE } });
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Osteopatía", durationMin: 60, priceCents: SERVICE_PRICE, maxConcurrent: 1 },
        select: { id: true },
      })
    ).id;
    // Servicio propio de B (solo él lo ofrece): con su precio oculto, ningún número de este servicio viaja.
    svcB = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: B, name: "Drenaje", durationMin: 60, priceCents: 7_777_00, maxConcurrent: 1 },
        select: { id: true },
      })
    ).id;
    await db.practitionerService.createMany({
      data: [
        { tenantId: T.tenantId, practitionerId: A, serviceId: svc, priceCents: A_PRICE },
        { tenantId: T.tenantId, practitionerId: B, serviceId: svc, priceCents: B_PRICE },
        { tenantId: T.tenantId, practitionerId: B, serviceId: svcB, priceCents: 6_666_00 },
      ],
    });
    await db.practitioner.update({
      where: { id: B },
      data: {
        showPublicPrice: false,
        contactWhatsapp: B_WA,
        contactConsentAt: new Date(),
        contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION,
        showContactForInsured: true,
      },
    });
    osde = await addInsurer(db, T, { name: "OSDE", copagoCents: OSDE_COPAGO });
    fake = installFakeMp();
    await connectFakeAccount(db, T);
    await connectFakeAccount(db, T, { practitionerId: B, seller: 2 });
  });
  afterAll(async () => {
    fake?.uninstall();
    await T?.cleanup();
    await other?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    process.env.MP_CONNECT_MODE = "fake";
    rl.blocked.clear();
    rl.keys.length = 0;
    await db.insurer.update({ where: { id: T.particularInsurerId }, data: { copagoCents: PARTICULAR } });
    await setPaymentPolicy(db, T.tenantId, { mode: "OFF" });
  });

  // ─── getPublicClinic ────────────────────────────────────────────────

  it("[CF3-PRP13] particularQuotes por profesional; el del precio oculto no aparece y su número no está en el payload", async () => {
    const clinic = (await getPublicClinic(T.slug))!;
    expect(clinic.particularQuotes?.[A]?.[svc]).toBe(A_PRICE);
    // El servicio propio del titular (factory, sin precio propio) cotiza con «Particular», sin cobro online prendido.
    expect(clinic.particularQuotes?.[A]?.[T.serviceId]).toBe(PARTICULAR);
    expect(clinic.particularQuotes && B in clinic.particularQuotes).toBe(false);
    const json = JSON.stringify(clinic);
    for (const n of [B_PRICE, 6_666_00, 7_777_00]) expect(json, String(n)).not.toContain(String(n));
    // El servicio que comparten: su precio base no es el de B (B tiene propio) → viaja; el que solo ofrece B → 0.
    expect(clinic.services.find((s) => s.id === svc)?.priceCents).toBe(SERVICE_PRICE);
    expect(clinic.services.find((s) => s.id === svcB)?.priceCents).toBe(0);
    // El wizard: A con su precio, B sin número, «cualquiera» sin número (D-CF3-4).
    expect(particularQuoteFor(clinic, A, svc)).toBe(A_PRICE);
    expect(particularQuoteFor(clinic, B, svc)).toBeNull();
    expect(particularQuoteFor(clinic, null, svc)).toBeNull();
  });

  it("[CF3-PRP14] la fila «Particular» se lee siempre en la MISMA sentencia de coberturas (1 de Insurer, con o sin cobro)", async () => {
    const count = async () => {
      const { result } = await measure(async () => {
        const g = globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } };
        const clinic = await getPublicClinic(T.slug);
        return { clinic, insurer: g.__kineQueryRecorder.events.filter((e) => /"Insurer"/.test(e.query)).length };
      });
      return result;
    };
    const off = await count();
    expect(off.clinic?.onlinePayment).toBeNull();
    expect(off.insurer).toBe(1);
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const on = await count();
    expect(on.insurer).toBe(1);
    // Ningún copago de obra social en el payload (C-TP8): la lista pública sigue siendo id/nombre/isParticular.
    expect(on.clinic?.insurers?.every((i) => Object.keys(i).sort().join() === "id,isParticular,name")).toBe(true);
    expect(JSON.stringify(on.clinic)).not.toContain(String(OSDE_COPAGO));
    // Particular es la cotización del titular en su servicio propio (visible): sí viaja como fallback del wizard viejo.
    expect(on.clinic?.onlinePayment?.particularCopagoCents).toBe(PARTICULAR);
  });

  it("[CF3-PRP15] un oculto que hereda «Particular» → onlinePayment.particularCopagoCents no viaja", async () => {
    await db.practitionerService.update({
      where: { practitionerId_serviceId: { practitionerId: B, serviceId: svc } },
      data: { priceCents: null },
    });
    try {
      await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
      const clinic = (await getPublicClinic(T.slug))!;
      expect(clinic.onlinePayment?.particularCopagoCents).toBeNull();
      expect(clinic.particularQuotes?.[A]?.[T.serviceId]).toBe(PARTICULAR); // el de A sí (es SU cotización)
    } finally {
      await db.practitionerService.update({
        where: { practitionerId_serviceId: { practitionerId: B, serviceId: svc } },
        data: { priceCents: B_PRICE },
      });
    }
  });

  it("[CF3-PRP16] insuredContactAvailable solo con opt-in + v2 (sin el número en el HTML) y clinicPhone = Tenant.phone", async () => {
    const clinic = (await getPublicClinic(T.slug))!;
    expect(clinic.insuredContactAvailable).toEqual({ [B]: true });
    expect(clinic.clinicPhone).toBe(CLINIC_PHONE);
    const json = JSON.stringify(clinic);
    expect(json).not.toContain(B_WA.slice(1));
    expect(json).not.toContain("1123456789");

    await db.practitioner.update({ where: { id: B }, data: { contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION_V1 } });
    try {
      expect((await getPublicClinic(T.slug))!.insuredContactAvailable).toEqual({});
    } finally {
      await db.practitioner.update({ where: { id: B }, data: { contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION } });
    }
  });

  // ─── getInsuredContact ───────────────────────────────────────────────

  it("[CF3-PRP17] getInsuredContact: links con el texto sin PHI; sin opt-in, v1, slug ajeno o no reservable → none", async () => {
    const ok = await getInsuredContact(T.slug, B);
    expect(ok).toMatchObject({ ok: true, telUrl: `tel:${B_WA}` });
    if (!ok.ok) return;
    expect(ok.waUrl).toBe(`https://wa.me/${B_WA.slice(1)}?text=${encodeURIComponent(INSURED_CONTACT_MESSAGE)}`);
    expect(ok.name).toMatch(/^Kine /);
    expect(rl.keys.some((k) => k.startsWith("pub:insuredcontact:"))).toBe(true);

    expect(await getInsuredContact(T.slug, A)).toEqual({ ok: false, reason: "none" }); // sin opt-in
    expect(await getInsuredContact(other.slug, B)).toEqual({ ok: false, reason: "none" }); // otro consultorio
    expect(await getInsuredContact("no-existe-cf3", B)).toEqual({ ok: false, reason: "none" });
    expect(await getInsuredContact(T.slug, "x".repeat(500))).toEqual({ ok: false, reason: "none" }); // input inválido

    await db.practitioner.update({ where: { id: B }, data: { contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION_V1 } });
    expect(await getInsuredContact(T.slug, B)).toEqual({ ok: false, reason: "none" });
    await db.practitioner.update({
      where: { id: B },
      data: { contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION, publicBookingEnabled: false },
    });
    expect(await getInsuredContact(T.slug, B)).toEqual({ ok: false, reason: "none" }); // fuera del turnero
    await db.practitioner.update({ where: { id: B }, data: { publicBookingEnabled: true } });
    await db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: false } });
    expect(await getInsuredContact(T.slug, B)).toEqual({ ok: false, reason: "none" }); // turnero cerrado
    await db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: true } });
    expect((await getInsuredContact(T.slug, B)).ok).toBe(true);
  });

  it("[CF3-PRP18] getInsuredContact con el rate limit agotado → rate_limited, sin leer la base", async () => {
    rl.blocked.add("pub:insuredcontact:");
    const { result, m } = await measure(() => getInsuredContact(T.slug, B));
    expect(result).toEqual({ ok: false, reason: "rate_limited" });
    expect(m.statements).toBe(0);
  });

  // ─── submit + estado: escalera nueva, paridad wizard = server ───────────

  it("[CF3-PRP19] particular nuevo con A: el wizard promete el precio de A y el server cobra eso (no Particular)", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const w = await wizard(A);
    expect(w.payment?.quote).toEqual({ amountCents: A_PRICE, chargeKind: "FULL" });
    expect(w.checkout).toMatchObject({ online: true, totalLabel: "Total a pagar", totalCents: A_PRICE });
    const r = await submitPublicBooking(input({ practitionerId: A, slot: await freeSlot(A) }));
    expect(r.ok && r.data).toMatchObject({ next: "checkout", amountCents: A_PRICE });
    if (!r.ok) return;
    expect((await chargesOf(r.data.bookingId))[0]).toMatchObject({ kind: "FULL", amountCents: A_PRICE, copagoBasisCents: A_PRICE });
    expect(amountDiffers(r.data, w.quoted)).toBe(false);
  });

  it("[CF3-PRP20] B con precio oculto: el wizard no promete número y el monto (el de B) se ve antes de Mercado Pago", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const w = await wizard(B);
    expect(w.payment?.amountHidden).toBe(true);
    expect(w.quoted).toBe("coverage");
    const r = await submitPublicBooking(input({ practitionerId: B, slot: await freeSlot(B) }));
    expect(r.ok && r.data).toMatchObject({ next: "checkout", amountCents: B_PRICE });
    if (!r.ok) return;
    expect(amountDiffers(r.data, w.quoted)).toBe(true);
  });

  it("[CF3-PRP21] ficha con cobertura a la fila «Particular» → precio del profesional; con OS real → copago de la OS", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const part = await existingPatient(T.particularInsurerId, "Particular");
    const r1 = await submitPublicBooking(input({ practitionerId: A, slot: await freeSlot(A), patient: part }));
    expect(r1.ok && r1.data).toMatchObject({ next: "checkout", amountCents: A_PRICE });

    const os = await existingPatient(osde, "OSDE");
    const r2 = await submitPublicBooking(input({ practitionerId: A, slot: await freeSlot(A), patient: os }));
    expect(r2.ok && r2.data).toMatchObject({ next: "checkout", amountCents: OSDE_COPAGO });
    // El wizard con obra social: sin precio y con el bloque de cobertura (A sin opt-in → el consultorio).
    const w = await wizard(A, { insurerId: osde, coverageInsurer: "OSDE" });
    expect(w.checkout.showTotal).toBe(false);
    expect(w.checkout.insured).toMatchObject({ contactAvailable: false });
    const wb = await wizard(B, { insurerId: osde, coverageInsurer: "OSDE" });
    expect(wb.checkout.insured).toMatchObject({ contactAvailable: true });
  });

  it("[CF3-PRP22] estado con seña: el resto se calcula sobre el precio del profesional (antes, sobre Particular)", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "FIXED", fixedCents: 3_000_00 });
    const r = await submitPublicBooking(input({ practitionerId: A, slot: await freeSlot(A) }));
    expect(r.ok && r.data).toMatchObject({ next: "checkout", amountCents: 3_000_00 });
    if (!r.ok) return;
    const s = await getPublicBookingStatus(r.data.bookingId);
    // Seña todavía sin pagar: falta todo el copago del turno, que es el precio de A (no los $ 8.000 de Particular).
    expect(s?.onlineCharge?.remainingCents).toBe(A_PRICE);
  });

  it("[CF3-PRP23] estado sin cobro: el monto es la cotización del profesional; con el precio oculto, ninguno", async () => {
    const ra = await submitPublicBooking(input({ practitionerId: A, slot: await freeSlot(A) }));
    expect(ra.ok && ra.data.next).toBe("reserved");
    if (!ra.ok) return;
    expect((await getPublicBookingStatus(ra.data.bookingId))?.amountCents).toBe(A_PRICE);

    const rb = await submitPublicBooking(input({ practitionerId: B, slot: await freeSlot(B) }));
    expect(rb.ok && rb.data.next).toBe("reserved");
    if (!rb.ok) return;
    const sb = await getPublicBookingStatus(rb.data.bookingId);
    expect(sb?.amountCents).toBe(0);
    expect(JSON.stringify(sb)).not.toContain(String(B_PRICE));
  });
});
