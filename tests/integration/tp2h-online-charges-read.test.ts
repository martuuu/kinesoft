/**
 * T5 · [TP-2h] Lecturas de cobros online del staff (plan §25, contrato C-TP9: `lib/online-charges-read.ts`).
 *
 * Nace en TP-K2 (tanda T5c) como `it.fails` (stubs que devolvían «todavía no disponible»); TP-2h los da vuelta y suma
 * los casos con cobros sembrados de los dos orígenes: comprobante con los datos crudos de las 7 filas (decisión de
 * TP-K4), DTO sin token suelto, `rawPayload` ni `idempotencyKey`, alcance `collectOwn`, aislamiento entre
 * consultorios, filtros, resumen y cursor de /cobros, y el mes AR del período en TZ=UTC.
 *
 * Actions reales contra Postgres, en los dos roles. Se mockea la sesión de Supabase y `next/cache` (integration-setup).
 * Los cobros se siembran con el owner (como el webhook/los links, que escriben por su canal): el guard de M18 obliga a
 * nacer ACTIVE y a pasar por transiciones válidas, así que el sembrado es el mismo camino que la realidad.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getBookingOnlineCharges, listOnlineCharges, listPatientOnlineCharges } from "@/lib/online-charges-read";
import { buildMpReceipt } from "@/lib/mp-receipt";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { connectFakeAccount } from "@/tests/helpers/mp-connect-fake";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[TP-2h] lecturas de cobros online", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let pat: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    pat = await addPatient(db, T);
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("[TP-2h] getBookingOnlineCharges: un turno propio sin cobros devuelve una lista vacía", async () => {
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: pat,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() + 86_400_000),
        durationMin: 45,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        idempotencyKey: randomUUID(),
      },
    });
    asUser(T.userId);
    expect(await getBookingOnlineCharges({ bookingId: b.id })).toEqual({ ok: true, data: [] });
  });

  it("[TP-2h] listOnlineCharges: consultorio sin cobros → sin filas, sin cursor y resumen en 0", async () => {
    asUser(T.userId);
    expect(await listOnlineCharges({})).toEqual({
      ok: true,
      data: { rows: [], nextCursor: null, summary: { paidCents: 0, liveCount: 0, liveCents: 0 } },
    });
  });

  it("[TP-2h] listPatientOnlineCharges: paciente propio sin cobros devuelve una lista vacía", async () => {
    asUser(T.userId);
    expect(await listPatientOnlineCharges({ patientId: pat })).toEqual({ ok: true, data: [] });
  });
});

describe.skipIf(!RUN)("[TP-2h] lecturas de cobros online · con cobros", () => {
  let db: PrismaClient;
  let S: EphemeralTenant;
  let X: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let assistant: { userId: string };
  let billing: { userId: string };
  let pat: string;
  let ownerAccount: string;
  let kineAccount: string;
  /** Turno del Titular con un cobro del turnero PAGADO (FULL) y un link anulado que después se pagó (tardío). */
  let paidBooking: string;
  /** Turno del profesional con una seña pagada y un link vivo por el resto. */
  let kineBooking: string;
  const ids: Record<string, string> = {};

  const token = () => randomBytes(16).toString("base64url");

  async function booking(practitionerId: string, copagoCents = 20_000_00) {
    const b = await db.booking.create({
      data: {
        tenantId: S.tenantId,
        patientId: pat,
        practitionerId,
        serviceId: S.serviceId,
        scheduledFor: new Date(Date.now() + 2 * 86_400_000),
        durationMin: 45,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        copagoCents,
        idempotencyKey: randomUUID(),
      },
      select: { id: true },
    });
    return b.id;
  }

  async function charge(o: {
    origin: "TURNERO" | "LINK";
    kind: "FULL" | "DEPOSIT" | "FREE";
    practitionerId: string;
    accountId: string;
    bookingId: string | null;
    amountCents: number;
    createdAt?: Date;
  }) {
    const createdAt = o.createdAt ?? new Date();
    const c = await db.onlineCharge.create({
      data: {
        tenantId: S.tenantId,
        origin: o.origin,
        kind: o.kind,
        mpAccountId: o.accountId,
        practitionerId: o.practitionerId,
        patientId: pat,
        bookingId: o.bookingId,
        amountCents: o.amountCents,
        concept: o.origin === "LINK" ? "Sesión de octubre" : null,
        publicToken: o.origin === "LINK" ? token() : null,
        createdByUserId: o.origin === "LINK" ? S.userId : null,
        expiresAt: new Date(createdAt.getTime() + 7 * 86_400_000),
        idempotencyKey: `${o.origin === "LINK" ? "link" : "turnero"}:${randomUUID()}`,
        createdAt,
        // Lo que el webhook guarda: allow-list redactada + banderas. Nada de esto puede llegar al DTO.
        rawPayload: { attempts: [{ id: "SECRETO-RAW-1", status: "approved" }], payer: { email: "SECRETO@pagador.test" } },
      },
      select: { id: true },
    });
    return c.id;
  }

  async function pay(id: string, o: { paidAmountCents: number; approvedAt: Date; installments?: number }) {
    await db.onlineCharge.update({
      where: { id },
      data: {
        status: "PAID",
        mpPaymentId: String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 1000)).padStart(3, "0"),
        mpStatus: "approved",
        mpStatusDetail: "accredited",
        paymentMethodId: "visa",
        paymentTypeId: "credit_card",
        installments: o.installments ?? 3,
        paidAmountCents: o.paidAmountCents,
        approvedAt: o.approvedAt,
        settledAt: new Date(),
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    X = await createEphemeralTenant(db);
    kine = await addPractitioner(db, S, "PRACTITIONER");
    assistant = await addStaff(db, S, "ASSISTANT");
    billing = await addStaff(db, S, "BILLING");
    pat = await addPatient(db, S);
    ownerAccount = (await connectFakeAccount(db, S, { seller: 1 })).accountId;
    kineAccount = (await connectFakeAccount(db, S, { seller: 2, practitionerId: kine.practitionerId })).accountId;

    paidBooking = await booking(S.practitionerId);
    ids.turneroPaid = await charge({ origin: "TURNERO", kind: "FULL", practitionerId: S.practitionerId, accountId: ownerAccount, bookingId: paidBooking, amountCents: 20_000_00 });
    // 23:30 AR del 20/10 = 02:30 UTC del 21/10: el comprobante tiene que decir 20/10 aunque el host corra en UTC.
    await pay(ids.turneroPaid, { paidAmountCents: 20_000_00, approvedAt: new Date("2026-10-21T02:30:00.000Z") });
    ids.lateLink = await charge({ origin: "LINK", kind: "FULL", practitionerId: S.practitionerId, accountId: ownerAccount, bookingId: paidBooking, amountCents: 20_000_00 });
    await db.onlineCharge.update({ where: { id: ids.lateLink }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: S.userId, cancelReason: "manual" } });
    await pay(ids.lateLink, { paidAmountCents: 19_000_00, approvedAt: new Date("2026-10-21T12:00:00.000Z"), installments: 1 });

    kineBooking = await booking(kine.practitionerId);
    ids.deposit = await charge({ origin: "TURNERO", kind: "DEPOSIT", practitionerId: kine.practitionerId, accountId: kineAccount, bookingId: kineBooking, amountCents: 6_000_00 });
    await pay(ids.deposit, { paidAmountCents: 6_000_00, approvedAt: new Date("2026-10-20T15:00:00.000Z") });
    ids.liveLink = await charge({ origin: "LINK", kind: "FULL", practitionerId: kine.practitionerId, accountId: kineAccount, bookingId: kineBooking, amountCents: 14_000_00 });
    // Link sin turno del Titular, vencido.
    ids.expiredFree = await charge({ origin: "LINK", kind: "FREE", practitionerId: S.practitionerId, accountId: ownerAccount, bookingId: null, amountCents: 5_000_00 });
    await db.onlineCharge.update({ where: { id: ids.expiredFree }, data: { status: "EXPIRED" } });
  });

  afterAll(async () => {
    await S?.cleanup();
    await X?.cleanup();
    await db?.$disconnect();
  });

  it("[TP-2h] drawer: los cobros del turno con comprobante (datos crudos para las 7 filas en hora AR) y sin token suelto, rawPayload ni idempotencyKey", async () => {
    asUser(assistant.userId);
    const r = await getBookingOnlineCharges({ bookingId: paidBooking });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((c) => c.id).sort()).toEqual([ids.turneroPaid, ids.lateLink].sort());
    const turnero = r.data.find((c) => c.id === ids.turneroPaid)!;
    expect(turnero).toMatchObject({
      origin: "TURNERO",
      kind: "FULL",
      status: "PAID",
      statusLabel: "Pagado",
      amountCents: 20_000_00,
      concept: null,
      accountKind: "PRACTITIONER",
      link: null,
      notices: [],
    });
    expect(turnero.receipt).toMatchObject({
      approvedAtLabel: "20/10/2026, 23:30",
      paidAmountCents: 20_000_00,
      methodLabel: "Tarjeta de crédito Visa",
      paymentMethodId: "visa",
      paymentTypeId: "credit_card",
      installments: 3,
      mpStatus: "approved",
      account: { kind: "PRACTITIONER" },
    });
    expect(turnero.practitionerName).toBeTruthy();
    expect(turnero.receipt!.account.practitionerName).toBe(turnero.practitionerName);
    // Lo que va a hacer TP-3c con el DTO: 7 filas con «Cuotas» y «Acreditado en».
    const rc = turnero.receipt!;
    const built = buildMpReceipt({ mpPaymentId: rc.operationId, ...rc });
    expect(built?.rows.map((x) => x.key)).toEqual(["operation", "date", "amount", "method", "installments", "status", "account"]);

    // El link anulado y pagado después: aviso de pago tardío, duplicado (el turno ya estaba pagado) y monto distinto.
    const late = r.data.find((c) => c.id === ids.lateLink)!;
    expect(late.status).toBe("PAID");
    expect(late.notices.sort()).toEqual(["amount-mismatch", "duplicate", "late-after-cancel"]);
    expect(late.concept).toBe("Sesión de octubre");
    // Pagado: la URL se puede re-compartir para ver el comprobante, pero ya no se anula ni se reenvía.
    expect(late.link).toMatchObject({ canCancel: false, canResend: false });
    expect(late.link!.url).toMatch(/\/pagar\/[A-Za-z0-9_-]{22}$/);

    const json = JSON.stringify(r);
    expect(json).not.toMatch(/SECRETO|idempotencyKey|rawPayload|publicToken|preferenceId|checkoutUrl|turnero:|link:/);
  });

  it("[TP-2h] link vivo: URL con Copiar/Reenviar/Anular para quien cobra; el profesional ve lo suyo (collectOwn) y no lo del Titular", async () => {
    asUser(kine.userId);
    const own = await getBookingOnlineCharges({ bookingId: kineBooking });
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    const live = own.data.find((c) => c.id === ids.liveLink)!;
    expect(live).toMatchObject({ status: "ACTIVE", statusLabel: "Pendiente de pago", link: { canCancel: true, canResend: true } });
    expect(own.data.find((c) => c.id === ids.deposit)).toMatchObject({ kind: "DEPOSIT", status: "PAID", link: null });

    expect(await getBookingOnlineCharges({ bookingId: paidBooking })).toEqual({
      ok: false,
      error: "No tenés permiso para ver los cobros online.",
    });

    const mine = await listPatientOnlineCharges({ patientId: pat });
    expect(mine.ok && mine.data.map((c) => c.id).sort()).toEqual([ids.deposit, ids.liveLink].sort());
    const list = await listOnlineCharges({});
    expect(list.ok && list.data.rows.map((c) => c.id).sort()).toEqual([ids.deposit, ids.liveLink].sort());
    // Pedir el filtro de otro profesional no muestra nada ajeno.
    const foreign = await listOnlineCharges({ practitionerId: S.practitionerId });
    expect(foreign).toEqual({ ok: true, data: { rows: [], nextCursor: null, summary: { paidCents: 0, liveCount: 0, liveCents: 0 } } });
  });

  it("[TP-2h] otro consultorio: turno y paciente ajenos → «no encontrado», nunca una lista vacía", async () => {
    asUser(X.userId);
    expect(await getBookingOnlineCharges({ bookingId: paidBooking })).toEqual({ ok: false, error: "No encontramos el turno." });
    expect(await listPatientOnlineCharges({ patientId: pat })).toEqual({ ok: false, error: "No encontramos al paciente." });
    const list = await listOnlineCharges({});
    expect(list.ok && list.data.rows).toEqual([]);
  });

  it("[TP-2h] /cobros: filtros de origen y estado, resumen del período sin el estado y el mes AR", async () => {
    asUser(billing.userId);
    const all = await listOnlineCharges({});
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.data.rows.map((c) => c.id).sort()).toEqual(Object.values(ids).sort());
    // Cobrado = turnero 20.000 + tardío 20.000 (el monto del cobro, no lo acreditado) + seña 6.000; vivo = link 14.000.
    expect(all.data.summary).toEqual({ paidCents: 46_000_00, liveCount: 1, liveCents: 14_000_00 });

    const links = await listOnlineCharges({ origin: "LINK" });
    expect(links.ok && links.data.rows.map((c) => c.id).sort()).toEqual([ids.lateLink, ids.liveLink, ids.expiredFree].sort());
    expect(links.ok && links.data.summary).toEqual({ paidCents: 20_000_00, liveCount: 1, liveCents: 14_000_00 });

    const live = await listOnlineCharges({ status: "live" });
    expect(live.ok && live.data.rows.map((c) => c.id)).toEqual([ids.liveLink]);
    const expired = await listOnlineCharges({ status: "EXPIRED" });
    expect(expired.ok && expired.data.rows.map((c) => c.id)).toEqual([ids.expiredFree]);
    // El resumen no se va a 0 por filtrar un estado.
    expect(expired.ok && expired.data.summary.paidCents).toBe(46_000_00);

    expect(await listOnlineCharges({ status: "PAGADO" })).toEqual({ ok: false, error: "Filtro inválido." });
    expect(await listOnlineCharges({ period: "2026-13" })).toEqual({ ok: false, error: "Filtro inválido." });
    expect(await listOnlineCharges({ cursor: "no-es-un-cursor" })).toEqual({ ok: false, error: "Filtro inválido." });
  });

  it("[TP-2h] período por mes AR (TZ=UTC): un cobro de las 23:30 AR del 30/09 es de septiembre, no de octubre", async () => {
    const Y = await createEphemeralTenant(db);
    try {
      const yPat = await addPatient(db, Y);
      const acc = (await connectFakeAccount(db, Y, { seller: 1 })).accountId;
      const createdAt = new Date("2026-10-01T02:30:00.000Z"); // 30/09 23:30 AR
      const c = await db.onlineCharge.create({
        data: {
          tenantId: Y.tenantId,
          origin: "LINK",
          kind: "FREE",
          mpAccountId: acc,
          practitionerId: Y.practitionerId,
          patientId: yPat,
          amountCents: 1_000_00,
          concept: "Sesión suelta",
          publicToken: token(),
          createdByUserId: Y.userId,
          expiresAt: new Date(createdAt.getTime() + 86_400_000),
          idempotencyKey: `link:${randomUUID()}`,
          createdAt,
        },
        select: { id: true },
      });
      asUser(Y.userId);
      const sep = await listOnlineCharges({ period: "2026-09" });
      const oct = await listOnlineCharges({ period: "2026-10" });
      expect(sep.ok && sep.data.rows.map((r) => r.id)).toEqual([c.id]);
      expect(sep.ok && sep.data.summary.liveCount).toBe(1);
      expect(oct.ok && oct.data.rows).toEqual([]);
      expect(oct.ok && oct.data.summary).toEqual({ paidCents: 0, liveCount: 0, liveCents: 0 });
    } finally {
      await Y.cleanup();
    }
  });

  it("[TP-2h] /cobros pagina de a 50 con cursor (createdAt desc, id desc), sin repetir ni saltear", async () => {
    const Z = await createEphemeralTenant(db);
    try {
      const zPat = await addPatient(db, Z);
      const acc = (await connectFakeAccount(db, Z, { seller: 1 })).accountId;
      const base = Date.now() - 3_600_000;
      // 53 links sin turno, dos con el MISMO createdAt (el desempate es por id).
      await db.onlineCharge.createMany({
        data: Array.from({ length: 53 }, (_, i) => {
          const createdAt = new Date(base + Math.min(i, 51) * 1000);
          return {
            tenantId: Z.tenantId,
            origin: "LINK" as const,
            kind: "FREE" as const,
            mpAccountId: acc,
            practitionerId: Z.practitionerId,
            patientId: zPat,
            amountCents: 100 + i,
            concept: `Cobro ${i}`,
            publicToken: token(),
            createdByUserId: Z.userId,
            expiresAt: new Date(createdAt.getTime() + 86_400_000),
            idempotencyKey: `link:${randomUUID()}`,
            createdAt,
          };
        }),
      });
      asUser(Z.userId);
      const p1 = await listOnlineCharges({});
      expect(p1.ok).toBe(true);
      if (!p1.ok) return;
      expect(p1.data.rows).toHaveLength(50);
      expect(p1.data.nextCursor).toBeTruthy();
      const p2 = await listOnlineCharges({ cursor: p1.data.nextCursor! });
      expect(p2.ok).toBe(true);
      if (!p2.ok) return;
      expect(p2.data.rows).toHaveLength(3);
      expect(p2.data.nextCursor).toBeNull();
      const seen = [...p1.data.rows, ...p2.data.rows].map((r) => r.id);
      expect(new Set(seen).size).toBe(53);
      expect(p1.data.summary).toEqual({ paidCents: 0, liveCount: 53, liveCents: Array.from({ length: 53 }, (_, i) => 100 + i).reduce((a, b) => a + b, 0) });
    } finally {
      await Z.cleanup();
    }
  });
});
