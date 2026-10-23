/**
 * T5 · [TP-2t] Turnero con cobro online a la cuenta del profesional (plan §25.5, contrato C-TP8).
 *
 * `submitPublicBooking`, `getPublicBookingStatus`, `getPublicClinic` y `promoteHeldPublicBookingInTx` REALES contra
 * Postgres, en el canal de servicio (sin Actor, como en prod), en los dos roles. Mercado Pago es el FALSO local
 * (`installFakeMp`, C-TP12): lo único que se reemplaza es la red (`globalThis.fetch`); las preferencias las crea el
 * `fakeMpHandle` real con el token sellado de la cuenta (`connectFakeAccount`). «MP caído» = esa red tirando.
 *
 * El SDK de la plataforma (`mercadopago`) se mockea SOLO para contar llamadas: el archivo entero corre con
 * `MP_ACCESS_TOKEN` + `TURNERO_CHECKOUT=platform` (lo que antes prendía el checkout con la cuenta de la plataforma, H-TP1) y
 * tiene que quedar en 0. Se mockean también el rate-limit y lo que ya mockea integration-setup (sesión, next/cache).
 *
 * Lo que NO prueba (es de otra sesión): el webhook que acredita el pago (TP-2a, tp2w-webhook-connect). El PAID del
 * status se siembra por el owner con las columnas de comprobante que exige el CHECK, como lo dejaría el webhook.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.hoisted(() => {
  // La cuenta de la PLATAFORMA «configurada» y el switch viejo prendido: nada de eso tiene que cobrar un turno.
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
  process.env.TURNERO_CHECKOUT = "platform";
});
const sdk = vi.hoisted(() => ({ calls: 0 }));
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create() {
      sdk.calls++;
      return { id: "pref-plataforma", init_point: "https://mp.test/plataforma" };
    }
  }
  class Payment {
    async get() {
      sdk.calls++;
      throw new Error("no usado en este archivo");
    }
  }
  return { MercadoPagoConfig, Preference, Payment };
});
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  submitPublicBooking,
  listPublicSlots,
  getPublicClinic,
  getPublicBookingStatus,
} from "@/lib/public-booking";
import {
  PUBLIC_PARTICULAR_CHARGE_NOTE,
  promoteHeldPublicBookingInTx,
} from "@/lib/public-booking-internal";
import { listAgendaBookings } from "@/lib/bookings";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  connectFakeAccount,
  fakeMpGetPreference,
  installFakeMp,
  setPaymentPolicy,
  type FakeAccount,
  type InstalledFakeMp,
} from "@/tests/helpers/mp-connect-fake";
import {
  ownerClient,
  createEphemeralTenant,
  addInsurer,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const PRICE = 8_000_00; // $8.000
const PARTICULAR = 6_000_00; // $6.000

/** Días hábiles (no domingo) de 3 a 25 días adelante, en calendario AR. */
function weekdays(): string[] {
  const out: string[] = [];
  for (let d = 3; d <= 25; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) out.push(key);
  }
  return out;
}

describe.skipIf(!RUN)("[TP-2t] turnero con cobro online", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fake: InstalledFakeMp;
  /** Servicio compartido (lo ofrecen todos los profesionales), $8.000, cupo 1. */
  let svc: string;
  /** Con cuenta propia ACTIVE (el profesional de la factory). */
  let own: FakeAccount;
  /** Sin cuenta propia (para «sin cuenta» y «la del consultorio»). */
  let kineNoAccount: { userId: string; practitionerId: string };
  /** Con cuenta propia en REAUTH_REQUIRED (no usable). */
  let kineReauth: { userId: string; practitionerId: string };
  let clinic: FakeAccount;
  const DAYS = weekdays();

  function input(
    o: {
      key?: string;
      slot: string;
      practitionerId?: string;
      payNow?: boolean;
      patient?: Partial<SubmitPublicBookingInput["patient"]>;
    }
  ): SubmitPublicBookingInput {
    const n = Math.floor(Math.random() * 1e8);
    return {
      tenantSlug: T.slug,
      idempotencyKey: o.key ?? randomUUID(),
      practitionerId: o.practitionerId ?? T.practitionerId,
      serviceId: svc,
      scheduledFor: o.slot,
      ...(o.payNow === undefined ? {} : { payNow: o.payNow }),
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${n.toString().padStart(8, "0")}`,
        documentId: `${30_000_000 + (n % 9_000_000)}`,
        dateOfBirth: "1990-05-10",
        ...o.patient,
      },
    };
  }

  /** El primer horario libre del profesional en los días de prueba (el paso de la grilla lo decide el motor). */
  async function freeSlot(practitionerId = T.practitionerId): Promise<string> {
    for (const date of DAYS) {
      const slots = await listPublicSlots({ tenantSlug: T.slug, practitionerId, serviceId: svc, date });
      const s = slots.find((x) => x.available);
      if (s) return s.iso;
    }
    throw new Error("sin horarios libres en los días de prueba");
  }

  const chargesOf = (bookingId: string) => db.onlineCharge.findMany({ where: { bookingId } });

  /** «MP caído»: la red al fake tira en las preferencias (lo demás sigue). Devuelve el restaurador. */
  function breakPreferences(): () => void {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (i: string | URL | Request, init?: RequestInit) => {
      const url = typeof i === "string" ? i : i instanceof URL ? i.toString() : i.url;
      if (url.includes("/checkout/preferences")) throw new TypeError("fetch failed");
      return prev(i, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = prev;
    };
  }

  /** PAID como lo deja el webhook (TP-2a): comprobante completo, que exige el CHECK `OnlineCharge_receipt_check`. */
  async function markPaid(chargeId: string, amountCents: number) {
    const now = new Date();
    await db.onlineCharge.update({
      where: { id: chargeId },
      data: {
        status: "PAID",
        mpPaymentId: `${Date.now()}`.slice(-12),
        mpStatus: "approved",
        paidAmountCents: amountCents,
        approvedAt: now,
        settledAt: now,
        paymentMethodId: "visa",
        paymentTypeId: "credit_card",
        installments: 1,
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    await db.insurer.update({ where: { id: T.particularInsurerId }, data: { copagoCents: PARTICULAR } });
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Osteopatía", durationMin: 60, priceCents: PRICE, maxConcurrent: 1 },
        select: { id: true },
      })
    ).id;
    kineNoAccount = await addPractitioner(db, T, "PRACTITIONER");
    kineReauth = await addPractitioner(db, T, "PRACTITIONER");
    fake = installFakeMp();
    own = await connectFakeAccount(db, T);
    clinic = await connectFakeAccount(db, T, { kind: "CLINIC", seller: 2 });
    await connectFakeAccount(db, T, { practitionerId: kineReauth.practitionerId, status: "REAUTH_REQUIRED" });
  });
  afterAll(async () => {
    fake?.uninstall();
    await T?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    process.env.MP_CONNECT_MODE = "fake";
    await setPaymentPolicy(db, T.tenantId, { mode: "OFF" });
  });

  // ── Casos sin cobro ───────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2t] política OFF → reservado sin OnlineCharge", async () => {
    const r = await submitPublicBooking(input({ slot: await freeSlot(), payNow: true }));
    expect(r).toEqual({ ok: true, data: { bookingId: expect.any(String), next: "reserved", initPoint: null, amountCents: null } });
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect([b.status, b.paymentStatus]).toEqual(["CONFIRMED", "UNPAID"]);
    expect(await chargesOf(b.id)).toEqual([]);
  });

  it("[TP-2t] MP_CONNECT_MODE=off con REQUIRED → sin cobro", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED" });
    process.env.MP_CONNECT_MODE = "off";
    const calls = fake.calls.length;
    const r = await submitPublicBooking(input({ slot: await freeSlot() }));
    expect(r.ok && r.data.next).toBe("reserved");
    if (!r.ok) return;
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } })).status).toBe("CONFIRMED");
    expect(await chargesOf(r.data.bookingId)).toEqual([]);
    expect(fake.calls.length).toBe(calls);
  });

  it("[TP-2t] sin cuenta (o con la propia en REAUTH) → sin cobro; la del consultorio solo con useClinicAccount", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", useClinicAccount: false });
    for (const k of [kineNoAccount, kineReauth]) {
      const r = await submitPublicBooking(input({ slot: await freeSlot(k.practitionerId), practitionerId: k.practitionerId }));
      expect(r.ok && r.data.next).toBe("reserved");
      if (r.ok) expect(await chargesOf(r.data.bookingId)).toEqual([]);
    }

    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", useClinicAccount: true });
    const r = await submitPublicBooking(
      input({ slot: await freeSlot(kineNoAccount.practitionerId), practitionerId: kineNoAccount.practitionerId })
    );
    expect(r.ok && r.data.next).toBe("checkout");
    if (!r.ok) return;
    const [c] = await chargesOf(r.data.bookingId);
    expect([c.mpAccountId, c.practitionerId]).toEqual([clinic.accountId, kineNoAccount.practitionerId]);

    // La propia manda sobre la del consultorio.
    const r2 = await submitPublicBooking(input({ slot: await freeSlot() }));
    expect(r2.ok && r2.data.next).toBe("checkout");
    if (r2.ok) expect((await chargesOf(r2.data.bookingId))[0].mpAccountId).toBe(own.accountId);
  });

  // ── REQUIRED / OPTIONAL ──────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2t] REQUIRED → PENDING + cobro ACTIVE + preferencia (binary_mode, vence al fin del hold, ?acct=, oc:)", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const r = await submitPublicBooking(input({ slot: await freeSlot() }));
    expect(r).toEqual({
      ok: true,
      data: { bookingId: expect.any(String), next: "checkout", initPoint: expect.stringMatching(/^https?:\/\//), amountCents: PARTICULAR },
    });
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect([b.status, b.paymentStatus]).toEqual(["PENDING", "UNPAID"]);
    const [c] = await chargesOf(b.id);
    expect(c).toMatchObject({
      origin: "TURNERO",
      kind: "FULL",
      status: "ACTIVE",
      amountCents: PARTICULAR,
      copagoBasisCents: PARTICULAR,
      mpAccountId: own.accountId,
      idempotencyKey: `turnero:${b.id}`,
      checkoutUrl: r.data.initPoint,
    });
    expect(c.expiresAt.getTime()).toBe(b.createdAt.getTime() + 30 * 60_000);
    const pref = fakeMpGetPreference(c.preferenceId!);
    expect(pref).not.toBeNull();
    expect(pref!.binary).toBe(true);
    expect(pref!.externalReference).toBe(`oc:${c.id}`);
    expect(new URL(pref!.notificationUrl!).searchParams.get("acct")).toBe(own.webhookRef);
    expect(pref!.body.payment_methods).toEqual({ excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] });
    expect(new Date(String(pref!.body.expiration_date_to)).getTime()).toBe(c.expiresAt.getTime());
    // El título no lleva el servicio (dato de salud en el resumen de la tarjeta).
    expect(JSON.stringify(pref!.body.items)).not.toContain("Osteopatía");
    // Sin aviso de «Turno online reservado»: un REQUIRED lo confirma (y avisa) el pago.
    expect(
      await db.notification.count({ where: { tenantId: T.tenantId, kind: "BOOKING_CREATED", createdAt: { gte: b.createdAt } } })
    ).toBe(0);
  });

  it("[TP-2t] OPTIONAL: «reservar» (sin payNow) → CONFIRMED sin cobro; «pagar ahora» → CONFIRMED + cobro (48 h o inicio)", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "OPTIONAL", chargeKind: "FIXED", fixedCents: 2_000_00 });
    for (const payNow of [undefined, false]) {
      const r = await submitPublicBooking(input({ slot: await freeSlot(), payNow }));
      expect(r.ok && r.data.next).toBe("reserved");
      if (r.ok) expect(await chargesOf(r.data.bookingId)).toEqual([]);
    }
    const r = await submitPublicBooking(input({ slot: await freeSlot(), payNow: true }));
    expect(r.ok && r.data).toMatchObject({ next: "checkout", amountCents: 2_000_00 });
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect(b.status).toBe("CONFIRMED");
    const [c] = await chargesOf(b.id);
    expect([c.kind, c.status, c.amountCents, c.copagoBasisCents]).toEqual(["DEPOSIT", "ACTIVE", 2_000_00, null]);
    expect(c.expiresAt.getTime()).toBe(Math.min(b.createdAt.getTime() + 48 * 3_600_000, b.scheduledFor.getTime()));
    expect(fakeMpGetPreference(c.preferenceId!)!.binary).toBe(false);
    // Reservado = aviso de alta (una vez).
    expect(
      await db.notification.count({
        where: { tenantId: T.tenantId, userId: T.userId, kind: "BOOKING_CREATED", createdAt: { gte: b.createdAt } },
      })
    ).toBe(1);
  });

  // ── Montos ───────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2t] copago 0 o seña < $1 → sin cobro", async () => {
    // La política no admite una seña fija < $1 (CHECK de M18); sí un porcentaje que redondea a $0.
    const withCopago = async (copagoCents: number) => {
      const ins = await addInsurer(db, T, { copagoCents });
      const doc = `${Math.floor(Math.random() * 1e8)}`;
      const who = { firstName: "Luz", lastName: "Gómez", documentId: doc, email: `luz-${doc}@test.local`, phone: `11${doc.padStart(8, "0")}` };
      const pid = await addPatient(db, T, who);
      await db.coverage.create({ data: { patientId: pid, insurer: "OS", insurerId: ins } });
      return who;
    };
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "PERCENT", percentBps: 1 }); // 0,01 % de $1.000 = $0,10
    const r1 = await submitPublicBooking(input({ slot: await freeSlot(), patient: await withCopago(1_000_00) }));
    expect(r1.ok && r1.data.next).toBe("reserved");
    if (r1.ok) expect(await chargesOf(r1.data.bookingId)).toEqual([]);

    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const r2 = await submitPublicBooking(input({ slot: await freeSlot(), patient: await withCopago(0) }));
    expect(r2.ok && r2.data.next).toBe("reserved");
    if (r2.ok) expect(await chargesOf(r2.data.bookingId)).toEqual([]);
  });

  it("[TP-2t] COPAGO = el de la agenda (paridad con listAgendaBookings: copago propio, OS, particular, precio)", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const osIns = await addInsurer(db, T, { copagoCents: 3_000_00 });
    const cases: { label: string; setup: (pid: string) => Promise<void>; expected: number }[] = [
      {
        label: "copago propio de la cobertura",
        setup: async (pid) => {
          await db.coverage.create({ data: { patientId: pid, insurer: "OS", insurerId: osIns, copagoCents: 2_500_00 } });
        },
        expected: 2_500_00,
      },
      {
        label: "obra social",
        setup: async (pid) => {
          await db.coverage.create({ data: { patientId: pid, insurer: "OS", insurerId: osIns } });
        },
        expected: 3_000_00,
      },
      { label: "particular", setup: async () => {}, expected: PARTICULAR },
      {
        label: "OS libre sin catálogo → precio",
        setup: async (pid) => {
          await db.coverage.create({ data: { patientId: pid, insurer: "OS a mano" } });
        },
        expected: PRICE,
      },
    ];
    asUser(T.userId);
    for (const k of cases) {
      const doc = `${Math.floor(Math.random() * 1e8)}`;
      const who = { firstName: "Paz", lastName: "Ríos", documentId: doc, email: `paz-${doc}@test.local`, phone: `11${doc.padStart(8, "0")}` };
      const pid = await addPatient(db, T, who);
      await k.setup(pid);
      const r = await submitPublicBooking(input({ slot: await freeSlot(), patient: who }));
      expect(r.ok && r.data, k.label).toMatchObject({ next: "checkout", amountCents: k.expected });
      if (!r.ok) continue;
      const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
      expect(b.patientId, k.label).toBe(pid);
      const rows = await listAgendaBookings({ from: new Date(+b.scheduledFor - 60_000), to: new Date(+b.scheduledFor + 60_000) });
      expect(rows.find((x) => x.id === b.id)?.copagoCents, k.label).toBe(k.expected);
    }
  });

  it("[TP-2t] DNI de una ficha con contacto distinto → se cobra como particular + nota (TP-D22)", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const osIns = await addInsurer(db, T, { copagoCents: 1_000_00 });
    const doc = `${Math.floor(Math.random() * 1e8)}`;
    const pid = await addPatient(db, T, { firstName: "Sol", lastName: "Paz", documentId: doc, email: `sol-${doc}@test.local` });
    await db.coverage.create({ data: { patientId: pid, insurer: "OS", insurerId: osIns } });
    const r = await submitPublicBooking(
      input({ slot: await freeSlot(), patient: { firstName: "Sol", lastName: "Paz", documentId: doc, email: `otra-${doc}@test.local` } })
    );
    expect(r.ok && r.data).toMatchObject({ next: "checkout", amountCents: PARTICULAR });
    if (!r.ok) return;
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } });
    expect(b.patientId).toBe(pid);
    expect(b.notes).toContain(PUBLIC_PARTICULAR_CHARGE_NOTE);
  });

  // ── Replay y fallas de MP ────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2t] replay → el mismo initPoint, un solo cobro y una sola preferencia", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED" });
    const req = input({ slot: await freeSlot() });
    const r1 = await submitPublicBooking(req);
    expect(r1.ok && r1.data.next).toBe("checkout");
    if (!r1.ok) return;
    const prefCalls = () => fake.calls.filter((u) => u.endsWith("/checkout/preferences")).length;
    const before = prefCalls();
    const r2 = await submitPublicBooking(req);
    expect(r2).toEqual(r1);
    expect(prefCalls()).toBe(before);
    expect(await chargesOf(r1.data.bookingId)).toHaveLength(1);
  });

  it("[TP-2t] REQUIRED con MP caído → error; el reintento usa el MISMO cobro (TP-D29)", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED" });
    const req = input({ slot: await freeSlot() });
    const restore = breakPreferences();
    let r1: Awaited<ReturnType<typeof submitPublicBooking>>;
    try {
      r1 = await submitPublicBooking(req);
    } finally {
      restore();
    }
    expect(r1).toEqual({ ok: false, error: "No pudimos abrir Mercado Pago. Probá de nuevo en unos minutos." });
    const b = await db.booking.findFirstOrThrow({ where: { idempotencyKey: `pub:${T.tenantId}:${req.idempotencyKey}` } });
    expect(b.status).toBe("PENDING");
    const [c0] = await chargesOf(b.id);
    expect([c0.status, c0.preferenceId]).toEqual(["ACTIVE", null]);

    const r2 = await submitPublicBooking(req);
    expect(r2.ok && r2.data).toMatchObject({ bookingId: b.id, next: "checkout" });
    const after = await chargesOf(b.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(c0.id);
    expect(after[0].preferenceId).not.toBeNull();
  });

  it("[TP-2t] OPTIONAL «pagar ahora» con MP caído → reservado + notice; el cobro queda anulado", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "OPTIONAL" });
    const req = input({ slot: await freeSlot(), payNow: true });
    const restore = breakPreferences();
    let r: Awaited<ReturnType<typeof submitPublicBooking>>;
    try {
      r = await submitPublicBooking(req);
    } finally {
      restore();
    }
    expect(r).toEqual({
      ok: true,
      data: { bookingId: expect.any(String), next: "reserved", initPoint: null, amountCents: null, notice: "payment-unavailable" },
    });
    if (!r.ok) return;
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } })).status).toBe("CONFIRMED");
    const [c] = await chargesOf(r.data.bookingId);
    expect([c.status, c.cancelReason, c.preferenceId]).toEqual(["CANCELLED", "preference_failed", null]);
    // El replay repite el aviso y no reabre nada.
    expect(await submitPublicBooking(req)).toEqual(r);
  });

  // ── Holds ─────────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2t] re-reserva del propio hold vencido → el turno viejo CANCELLED y su cobro EXPIRED", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED" });
    const slot = await freeSlot();
    const who = { documentId: `${Math.floor(Math.random() * 1e8)}`, email: `re-${randomUUID().slice(0, 6)}@test.local`, phone: "1144443333" };
    const r1 = await submitPublicBooking(input({ slot, patient: who }));
    expect(r1.ok && r1.data.next).toBe("checkout");
    if (!r1.ok) return;
    // Pasaron 40 min: el hold venció (el cobro conserva su vencimiento original, que ya pasó en la práctica).
    await db.booking.update({ where: { id: r1.data.bookingId }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } });

    const r2 = await submitPublicBooking(input({ slot, patient: who }));
    expect(r2.ok && r2.data.next).toBe("checkout");
    if (!r2.ok) return;
    expect(r2.data.bookingId).not.toBe(r1.data.bookingId);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r1.data.bookingId } })).status).toBe("CANCELLED");
    expect((await chargesOf(r1.data.bookingId))[0].status).toBe("EXPIRED");
    expect((await chargesOf(r2.data.bookingId))[0].status).toBe("ACTIVE");
  });

  it("[TP-2t] promoteHeld no promueve un PENDING con cobro vivo (tampoco el replay con la política apagada)", async () => {
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED" });
    const req = input({ slot: await freeSlot() });
    const r = await submitPublicBooking(req);
    expect(r.ok && r.data.next).toBe("checkout");
    if (!r.ok) return;
    const bookingId = r.data.bookingId;
    const res = await db.$transaction((tx) => promoteHeldPublicBookingInTx(tx, { tenantId: T.tenantId, bookingId }));
    expect(res).toEqual({ kind: "payment-in-flight" });
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("PENDING");

    // El consultorio apaga el cobro: el replay devuelve el mismo link, no regala el turno.
    await setPaymentPolicy(db, T.tenantId, { mode: "OFF" });
    expect(await submitPublicBooking(req)).toEqual(r);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("PENDING");
  });

  // ── Plataforma, status y lo público ──────────────────────────────────────────────────────────────────────────

  it("[TP-2t] Plataforma: MP_ACCESS_TOKEN + TURNERO_CHECKOUT=platform → 0 llamadas al SDK", async () => {
    // Todo el archivo corre con la cuenta de la plataforma «configurada» y el switch viejo en `platform`.
    expect(process.env.TURNERO_CHECKOUT).toBe("platform");
    const r = await submitPublicBooking(input({ slot: await freeSlot() }));
    expect(r.ok && r.data.next).toBe("reserved");
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED" });
    const r2 = await submitPublicBooking(input({ slot: await freeSlot(kineNoAccount.practitionerId), practitionerId: kineNoAccount.practitionerId }));
    expect(r2.ok && r2.data.next).toBe("reserved");
    expect(sdk.calls).toBe(0);
  });

  it("[TP-2t] status con onlineCharge; nunca «$ 0» pendiente", async () => {
    // Sin cobro: null.
    const plain = await submitPublicBooking(input({ slot: await freeSlot() }));
    if (!plain.ok) throw new Error(plain.error);
    expect(await getPublicBookingStatus(plain.data.bookingId)).toMatchObject({ onlineCharge: null, onlinePayment: false, amountCents: PRICE });

    // FULL pendiente → pagado.
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "COPAGO" });
    const full = await submitPublicBooking(input({ slot: await freeSlot() }));
    if (!full.ok) throw new Error(full.error);
    const st1 = await getPublicBookingStatus(full.data.bookingId);
    expect(st1).toMatchObject({
      status: "PENDING",
      amountCents: PARTICULAR,
      onlinePayment: true,
      onlineCharge: { kind: "FULL", status: "ACTIVE", amountCents: PARTICULAR, remainingCents: PARTICULAR, receipt: null },
    });
    const [cf] = await chargesOf(full.data.bookingId);
    await markPaid(cf.id, PARTICULAR);
    const st2 = await getPublicBookingStatus(full.data.bookingId);
    expect(st2?.onlineCharge).toMatchObject({ status: "PAID", remainingCents: 0, receipt: { operationId: expect.stringMatching(/^\d+$/) } });

    // Seña: lo que falta = copago − seña pagada (el trigger de M18 suma la seña al turno).
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED", chargeKind: "FIXED", fixedCents: 1_500_00 });
    const dep = await submitPublicBooking(input({ slot: await freeSlot() }));
    if (!dep.ok) throw new Error(dep.error);
    expect((await getPublicBookingStatus(dep.data.bookingId))?.onlineCharge).toMatchObject({
      kind: "DEPOSIT",
      amountCents: 1_500_00,
      remainingCents: PARTICULAR,
    });
    const [cd] = await chargesOf(dep.data.bookingId);
    await markPaid(cd.id, 1_500_00);
    expect((await getPublicBookingStatus(dep.data.bookingId))?.onlineCharge).toMatchObject({
      status: "PAID",
      remainingCents: PARTICULAR - 1_500_00,
    });
  });

  it("[TP-2t] getPublicClinic.onlinePayment solo con cuentas usables", async () => {
    expect((await getPublicClinic(T.slug))?.onlinePayment).toBeNull();
    await setPaymentPolicy(db, T.tenantId, {
      mode: "OPTIONAL",
      chargeKind: "PERCENT",
      percentBps: 3000,
      cancellationNote: "La seña no se devuelve con menos de 24 h.",
    });
    const c1 = await getPublicClinic(T.slug);
    expect(c1?.onlinePayment).toEqual({
      mode: "OPTIONAL",
      chargeKind: "PERCENT",
      fixedCents: null,
      percentBps: 3000,
      cancellationNote: "La seña no se devuelve con menos de 24 h.",
      practitionerIds: [T.practitionerId],
      // PEND-a (enmienda C-TP8): el copago de Particular, para que el wizard cotice lo que cobra el server.
      particularCopagoCents: PARTICULAR,
    });
    expect(c1).not.toHaveProperty("onlineCheckout");
    // Sin datos de la cuenta en lo público.
    expect(JSON.stringify(c1)).not.toContain(own.webhookRef);

    await setPaymentPolicy(db, T.tenantId, { mode: "OPTIONAL", useClinicAccount: true });
    expect((await getPublicClinic(T.slug))?.onlinePayment?.practitionerIds.sort()).toEqual(
      [T.practitionerId, kineNoAccount.practitionerId, kineReauth.practitionerId].sort()
    );

    process.env.MP_CONNECT_MODE = "off";
    expect((await getPublicClinic(T.slug))?.onlinePayment).toBeNull();
  });
});
