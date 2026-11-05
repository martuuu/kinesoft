/**
 * X6 · [PEND-a] El turnero cotiza con el copago de Particular (enmienda C-TP8, plan §26.9; default de Martin §26.1 #5).
 *
 * Hallazgo «particular-en-cero-cotiza» de T5-Z (AUDIT «Ronda T5»): el wizard cotizaba con `Service.priceCents` y el server
 * cobra el copago resuelto (lib/copago.ts, AUDIT §5.5). Acá se fija, contra Postgres y con el Mercado Pago FALSO
 * (`installFakeMp`: solo se reemplaza la red), que lo que el wizard promete con el payload REAL de `getPublicClinic` es
 * lo que `submitPublicBooking` REAL cobra:
 *   - Particular $ 8.000 (servicio $ 10.000) → cotiza $ 8.000 y el cobro REQUIRED es de $ 8.000, sin interstitial;
 *   - Particular $ 0 → no promete pago, avisa «sin pago online» y el server reserva sin cobro;
 *   - con obra social → «depende de tu cobertura» y el interstitial muestra el monto del server;
 *   - FIXED / PERCENT → la seña de la política sobre el copago de Particular, igual en los dos lados;
 *   - con el cobro apagado (política OFF o `MP_CONNECT_MODE=off`) `getPublicClinic` no lee la fila Particular.
 * `@/lib/db` solo se instrumenta (`installQueryCounter`, un listener de `query`) para contar lecturas de `Insurer`.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { submitPublicBooking, listPublicSlots, getPublicClinic } from "@/lib/public-booking";
import type { PublicClinic, SubmitPublicBookingInput } from "@/lib/public-booking-types";
import {
  amountDiffers,
  checkoutCopyFor,
  quotedForInterstitial,
  reservesWithoutOnlinePayment,
  wizardOnlinePaymentFor,
  type WizardCoverage,
} from "@/lib/public-wizard-state";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { connectFakeAccount, installFakeMp, setPaymentPolicy, type InstalledFakeMp } from "@/tests/helpers/mp-connect-fake";
import { measure } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addInsurer,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const PRICE = 10_000_00; // $ 10.000
const PARTICULAR = 8_000_00; // $ 8.000

function weekdays(): string[] {
  const out: string[] = [];
  for (let d = 3; d <= 25; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) out.push(key);
  }
  return out;
}

describe.skipIf(!RUN)("[PEND-a] cotización del turnero = cobro del server", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fake: InstalledFakeMp;
  let svc: string;
  let osde: string;
  const DAYS = weekdays();

  function input(o: { slot: string; coverageInsurer?: string }): SubmitPublicBookingInput {
    const n = Math.floor(Math.random() * 1e8);
    return {
      tenantSlug: T.slug,
      idempotencyKey: randomUUID(),
      practitionerId: T.practitionerId,
      serviceId: svc,
      scheduledFor: o.slot,
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${n.toString().padStart(8, "0")}`,
        documentId: `${30_000_000 + (n % 9_000_000)}`,
        dateOfBirth: "1990-05-10",
        title: "Lumbalgia",
        ...(o.coverageInsurer ? { coverageInsurer: o.coverageInsurer } : {}),
      },
    };
  }

  async function freeSlot(): Promise<string> {
    for (const date of DAYS) {
      const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId: svc, date });
      const s = slots.find((x) => x.available);
      if (s) return s.iso;
    }
    throw new Error("sin horarios libres en los días de prueba");
  }

  /** Lo que el wizard mostraría con el payload real (mismos helpers que `public-booking-wizard.tsx`). */
  async function wizard(cov?: WizardCoverage) {
    const clinic = (await getPublicClinic(T.slug)) as PublicClinic;
    const payment = wizardOnlinePaymentFor(clinic, T.practitionerId, PRICE, cov);
    const without = reservesWithoutOnlinePayment(clinic, T.practitionerId, cov);
    const checkout = checkoutCopyFor({ payment, choice: null, priceCents: PRICE, withoutOnlinePayment: without });
    return { clinic, payment, without, checkout, quoted: quotedForInterstitial(payment, checkout.online) };
  }

  const chargesOf = (bookingId: string) => db.onlineCharge.findMany({ where: { bookingId } });
  const setParticular = (copagoCents: number) =>
    db.insurer.update({ where: { id: T.particularInsurerId }, data: { copagoCents } });

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Osteopatía", durationMin: 60, priceCents: PRICE, maxConcurrent: 1 },
        select: { id: true },
      })
    ).id;
    osde = await addInsurer(db, T, { name: "OSDE", copagoCents: 2_000_00 });
    fake = installFakeMp();
    await connectFakeAccount(db, T);
  });
  afterAll(async () => {
    fake?.uninstall();
    await T?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    process.env.MP_CONNECT_MODE = "fake";
    await setParticular(PARTICULAR);
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
  });

  it("[PEND-a] Particular $ 8.000: cotiza $ 8.000 y el server cobra $ 8.000 (REQUIRED, sin interstitial)", async () => {
    const w = await wizard({ insurerId: T.particularInsurerId });
    expect(w.clinic.onlinePayment?.particularCopagoCents).toBe(PARTICULAR);
    expect(w.payment?.quote).toEqual({ amountCents: PARTICULAR, chargeKind: "FULL" });
    expect(w.checkout).toMatchObject({ online: true, totalLabel: "Total a pagar", totalCents: PARTICULAR });
    // Sin decir nada de la cobertura (paciente nuevo) = lo mismo.
    expect((await wizard()).payment?.quote.amountCents).toBe(PARTICULAR);

    const r = await submitPublicBooking(input({ slot: await freeSlot() }));
    expect(r.ok && r.data).toMatchObject({ next: "checkout", amountCents: PARTICULAR });
    if (!r.ok) return;
    const [c] = await chargesOf(r.data.bookingId);
    expect(c).toMatchObject({ kind: "FULL", amountCents: PARTICULAR, copagoBasisCents: PARTICULAR, status: "ACTIVE" });
    expect(amountDiffers(r.data, w.quoted)).toBe(false);
  });

  it("[PEND-a] Particular $ 0: el wizard no promete pago y el server reserva sin cobro", async () => {
    await setParticular(0);
    const w = await wizard({ insurerId: T.particularInsurerId });
    expect(w.clinic.onlinePayment?.particularCopagoCents).toBe(0);
    expect(w.payment).toBeNull();
    expect(w.without).toBe(true);
    expect(w.checkout).toMatchObject({ online: false, cta: "Confirmar turno" });
    expect(w.checkout.note).toBe("Este turno se reserva sin pago online: lo pagás en el consultorio.");

    const r = await submitPublicBooking(input({ slot: await freeSlot() }));
    expect(r.ok && r.data).toMatchObject({ next: "reserved", amountCents: null });
    if (!r.ok) return;
    expect(await chargesOf(r.data.bookingId)).toEqual([]);
    expect(amountDiffers(r.data, w.quoted)).toBe(false);
  });

  it("[PEND-a] con obra social: «depende de tu cobertura» y el interstitial muestra lo que cobra el server", async () => {
    const w = await wizard({ insurerId: osde, coverageInsurer: "OSDE" });
    expect(w.payment?.coverageDependent).toBe(true);
    expect(w.checkout.note).toMatch(/^El monto final depende de tu cobertura/);
    expect(w.quoted).toBe("coverage");

    // Paciente nuevo con «OSDE» tipeado: `Coverage` de texto libre sin `insurerRef` → el server cobra el precio
    // (rama «OS sin fila» de lib/copago.ts). El wizard no lo prometió: el interstitial lo muestra antes de MP.
    const r = await submitPublicBooking(input({ slot: await freeSlot(), coverageInsurer: "OSDE" }));
    expect(r.ok && r.data).toMatchObject({ next: "checkout", amountCents: PRICE });
    if (!r.ok) return;
    expect((await chargesOf(r.data.bookingId))[0].amountCents).toBe(PRICE);
    expect(amountDiffers(r.data, w.quoted)).toBe(true);
  });

  it("[PEND-a] FIXED y PERCENT: la seña de la política sobre el copago de Particular, igual en wizard y server", async () => {
    for (const [policy, seña] of [
      [{ chargeKind: "FIXED", fixedCents: 3_000_00 }, 3_000_00],
      [{ chargeKind: "PERCENT", percentBps: 3000 }, 2_400_00],
    ] as const) {
      await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", ...policy });
      const w = await wizard();
      expect(w.payment?.quote, JSON.stringify(policy)).toEqual({ amountCents: seña, chargeKind: "DEPOSIT" });
      expect(w.checkout.split).toEqual({ nowCents: seña, restCents: PARTICULAR - seña });

      const r = await submitPublicBooking(input({ slot: await freeSlot() }));
      expect(r.ok && r.data).toMatchObject({ next: "checkout", amountCents: seña });
      if (!r.ok) return;
      expect((await chargesOf(r.data.bookingId))[0]).toMatchObject({ kind: "DEPOSIT", amountCents: seña });
      expect(amountDiffers(r.data, w.quoted)).toBe(false);
    }
  });

  it("[PEND-a] cobro apagado (política OFF o MP_CONNECT_MODE=off): 0 lecturas extra de Insurer en getPublicClinic", async () => {
    const count = async () => {
      // `measure` solo devuelve totales: las sentencias de `Insurer` se cuentan en el recorder global mientras graba.
      const { result } = await measure(async () => {
        const g = globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } };
        const clinic = await getPublicClinic(T.slug);
        return { clinic, insurer: g.__kineQueryRecorder.events.filter((e) => /"Insurer"/.test(e.query)).length };
      });
      return result;
    };
    const on = await count();
    expect(on.clinic?.onlinePayment?.particularCopagoCents).toBe(PARTICULAR);
    expect(on.insurer).toBe(1); // CF3 PR-P: la lista pública y la fila Particular salen de la misma consulta

    await setPaymentPolicy(db, T.tenantId, { mode: "OFF" });
    const off = await count();
    expect(off.clinic?.onlinePayment).toBeNull();
    expect(off.insurer).toBe(1);

    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED" });
    process.env.MP_CONNECT_MODE = "off";
    const modeOff = await count();
    expect(modeOff.clinic?.onlinePayment).toBeNull();
    expect(modeOff.insurer).toBe(1);
  });
});
