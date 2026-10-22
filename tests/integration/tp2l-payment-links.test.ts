/**
 * T5 · [TP-2l] Links de pago (plan §25.7, contrato C-TP9).
 *
 * Nació en TP-K2 (tanda T5c) con las filas del camino feliz como `it.fails` (stubs). TP-2d implementó
 * `lib/payment-links.ts`, `lib/payment-links-internal.ts` y `lib/public-payment-link.ts`, las dio vuelta y sumó los
 * rechazos (sin delegación — también el Titular, TP-D12 —, `collectOwn` ajeno, soporte, montos fuera de rango, turno
 * cobrado/cancelado/en hold, links concurrentes, preferencia caída) con setup real: cuenta conectada contra el
 * Mercado Pago FALSO (`installFakeMp` + `connectFakeAccount`, regla de T5: nada de Mercado Pago real ni sandbox) y la
 * preferencia creada de verdad en el fake con el token del vendedor.
 *
 * Actions reales contra Postgres, en los dos roles. Se mockea la sesión de Supabase, `next/cache`, `next/headers`
 * (integration-setup), la red (`installFakeMp`) y el despacho del mail (`__setEmailTransportForTests`).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import {
  createPaymentLink,
  cancelPaymentLink,
  sendPaymentLinkEmail,
  getPaymentLinkShare,
  getPaymentLinkSuggestions,
} from "@/lib/payment-links";
import { getPublicPaymentLink } from "@/lib/public-payment-link";
import { cancelLiveLinksForBookingInTx } from "@/lib/payment-links-internal";
import { runWithRls } from "@/lib/rls";
import { __setEmailTransportForTests, type SendEmailInput } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { PAYMENT_LINK_COPY } from "@/lib/online-payments-copy";
import { PAYMENT_LINK_EXTRA_COPY as X } from "@/lib/payment-links-logic";
import type { CreatePaymentLinkInput } from "@/lib/payment-links-types";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { connectFakeAccount, fakeMpGetPreference, installFakeMp, type InstalledFakeMp } from "@/tests/helpers/mp-connect-fake";

// Abrir la sesión de soporte pide step-up de 2FA (frontera externa: TOTP/cookie). Se mockea SOLO eso, como
// authz-matrix: los links no piden step-up, así que la barrera bajo test (soporte → rechazo) queda real.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

describe.skipIf(!RUN)("[TP-2l] links de pago", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let Other: EphemeralTenant;
  let H: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let assistant: { userId: string; membershipId: string };
  let pat: string;
  let patNoEmail: string;
  let kineAccountId = "";
  let fake: InstalledFakeMp;
  let supportCookie = "";
  let mails: SendEmailInput[] = [];

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    Other = await createEphemeralTenant(db);
    H = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addStaff(db, T, "ASSISTANT");
    pat = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId, email: `paciente-${uniqueSuffix()}@test.local`, phone: "1155554444" });
    patNoEmail = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
    // Red del Mercado Pago falso ANTES de conectar (el reset vacía el store); la cuenta queda con sus tokens.
    fake = installFakeMp();
    kineAccountId = (await connectFakeAccount(db, T, { practitionerId: kine.practitionerId, linksDelegated: true })).accountId;
    // Sesión de soporte REAL (BO), como la matriz: un superadmin de H entra a T.
    await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    asUser(H.userId);
    const s = await startSupport(T.tenantId, "Links de pago TP-2l");
    if (!s.ok) throw new Error(`startSupport: ${s.error}`);
    supportCookie = cookies().get(SUPPORT_COOKIE)?.value ?? "";
    cookies().delete(SUPPORT_COOKIE);
  }, 60_000);

  afterAll(async () => {
    fake?.uninstall();
    __setEmailTransportForTests(null);
    cookies().delete(SUPPORT_COOKIE);
    if (db) {
      await db.supportSession.updateMany({ where: { superadminId: H?.userId, endedAt: null }, data: { endedAt: new Date(), endedReason: "test" } });
      await T?.cleanup();
      await Other?.cleanup();
      await H?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(async () => {
    __rateLimitInternals.reset();
    cookies().delete(SUPPORT_COOKIE);
    mails = [];
    __setEmailTransportForTests(async (i) => {
      mails.push(i);
      return { ok: true, transport: "resend", providerId: "fake" };
    });
    // Estado base: la cuenta del kine viva y delegada; sin política (useClinicAccount = false).
    await db.mpAccount.update({ where: { id: kineAccountId }, data: { linksDelegated: true } });
  });

  /** Turno del profesional (default: el kine), $20.000 de copago, sin cobrar. Sembrado con el owner client. */
  async function seedBooking(o: { practitionerId?: string; patientId?: string; status?: "PENDING" | "CONFIRMED" | "CANCELLED" | "COMPLETED"; paymentStatus?: "UNPAID" | "PAID"; idempotencyKey?: string } = {}) {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: o.patientId ?? pat,
        practitionerId: o.practitionerId ?? kine.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() + DAY),
        durationMin: 45,
        status: o.status ?? "CONFIRMED",
        paymentStatus: o.paymentStatus ?? "UNPAID",
        ...(o.paymentStatus === "PAID" ? { copagoPaidAt: new Date(), copagoPaymentMethod: "CASH" as const, copagoCollectedById: T.userId } : {}),
        copagoCents: 20_000_00,
        idempotencyKey: o.idempotencyKey ?? randomUUID(),
      },
    });
  }

  function linkInput(b: { id: string }, o: Partial<CreatePaymentLinkInput> = {}): CreatePaymentLinkInput {
    return {
      patientId: pat,
      bookingId: b.id,
      practitionerId: kine.practitionerId,
      purpose: "REST",
      concept: "Sesión de rodilla",
      idempotencyKey: randomUUID(),
      ...o,
    };
  }

  async function createRestLink(userId = assistant.userId) {
    const b = await seedBooking();
    asUser(userId);
    const r = await createPaymentLink(linkInput(b));
    return { booking: b, r };
  }

  const tokenOf = (url: string) => new URL(url).pathname.split("/").pop()!;
  const linkCount = (bookingId: string) => db.onlineCharge.count({ where: { bookingId, origin: "LINK" } });

  // ── Permisos ──────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2l] Secretaria con delegación → REST con el monto restante y URL `/pagar/<22>`", async () => {
    const { booking, r } = await createRestLink();
    asUser(assistant.userId);
    const s = await getPaymentLinkSuggestions({ bookingId: booking.id });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.amountCents).toBe(20_000_00);
    expect(r.data.accountKind).toBe("PRACTITIONER");
    expect(new URL(r.data.url).pathname).toMatch(/^\/pagar\/[A-Za-z0-9_-]{22}$/);
    // Con el link vivo, el drawer lo dice (un link vivo por turno).
    expect(s).toMatchObject({ ok: true, data: { remainingCents: 20_000_00, depositPaidCents: 0, accountKind: null, blocked: PAYMENT_LINK_COPY.liveLinkExists } });

    const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: r.data.chargeId } });
    expect(row).toMatchObject({
      origin: "LINK",
      kind: "FULL",
      status: "ACTIVE",
      amountCents: 20_000_00,
      copagoBasisCents: 20_000_00,
      mpAccountId: kineAccountId,
      createdByUserId: assistant.userId,
      concept: "Sesión de rodilla",
    });
    expect(row.publicToken).toBe(tokenOf(r.data.url));
    // Preferencia creada EN EL FAKE con el token del vendedor: monto, `oc:`, `?acct=` y `back_urls` a /pagar.
    const pref = fakeMpGetPreference(row.preferenceId!);
    expect(pref).not.toBeNull();
    expect(pref!.amountCents).toBe(20_000_00);
    expect(pref!.externalReference).toBe(`oc:${row.id}`);
    expect(pref!.notificationUrl).toMatch(/\/api\/webhooks\/mercadopago\?acct=/);
    expect((pref!.backUrls as { success: string }).success).toBe(`${r.data.url}?r=ok`);
    // Audit sin concepto ni token.
    const audit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: T.tenantId, action: "paymentLink.create", entityId: row.id } });
    expect(JSON.stringify(audit.payload)).not.toContain("rodilla");
    expect(JSON.stringify(audit.payload)).not.toContain(row.publicToken!);
  });

  it("[TP-2l] sugerencias sin link vivo: lo que falta, el total y la cuenta", async () => {
    const b = await seedBooking();
    asUser(assistant.userId);
    const s = await getPaymentLinkSuggestions({ bookingId: b.id });
    expect(s).toEqual({
      ok: true,
      data: { remainingCents: 20_000_00, totalCents: 20_000_00, depositPaidCents: 0, canTotal: true, accountKind: "PRACTITIONER", blocked: null },
    });
  });

  it("[TP-2l] sin delegación → rechazo, también el Titular (TP-D12); el propio profesional sí", async () => {
    await db.mpAccount.update({ where: { id: kineAccountId }, data: { linksDelegated: false } });
    const b = await seedBooking();
    asUser(assistant.userId);
    const kineName = (await db.userProfile.findUniqueOrThrow({ where: { id: kine.userId } })).fullName!;
    expect(await createPaymentLink(linkInput(b))).toEqual({ ok: false, error: PAYMENT_LINK_COPY.notDelegated(kineName) });
    asUser(T.userId);
    expect(await createPaymentLink(linkInput(b))).toEqual({ ok: false, error: PAYMENT_LINK_COPY.notDelegated(kineName) });
    expect(await linkCount(b.id)).toBe(0);
    // El dueño de la cuenta (collectOwn, su turno) sin delegación.
    asUser(kine.userId);
    const own = await createPaymentLink(linkInput(b));
    expect(own.ok).toBe(true);
    expect(await linkCount(b.id)).toBe(1);
  });

  it("[TP-2l] `collectOwn` solo lo suyo: turno del Titular → rechazo", async () => {
    const b = await seedBooking({ practitionerId: T.practitionerId });
    asUser(kine.userId);
    const r = await createPaymentLink(linkInput(b, { practitionerId: T.practitionerId }));
    expect(r).toEqual({ ok: false, error: X.forbiddenOwn });
    expect(await linkCount(b.id)).toBe(0);
  });

  it("[TP-2l] soporte no crea ni anula", async () => {
    const b = await seedBooking();
    asUser(assistant.userId);
    const live = await createPaymentLink(linkInput(b));
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    asUser(H.userId);
    cookies().set(SUPPORT_COOKIE, supportCookie);
    const b2 = await seedBooking();
    expect(await createPaymentLink(linkInput(b2))).toEqual({ ok: false, error: X.support });
    expect(await cancelPaymentLink({ chargeId: live.data.chargeId })).toEqual({ ok: false, error: X.support });
    expect(await sendPaymentLinkEmail({ chargeId: live.data.chargeId })).toEqual({ ok: false, error: X.support });
    cookies().delete(SUPPORT_COOKIE);
    expect(await linkCount(b2.id)).toBe(0);
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: live.data.chargeId } })).status).toBe("ACTIVE");
  });

  it("[TP-2l] otro consultorio: paciente, turno y profesional ajenos → rechazo", async () => {
    const b = await seedBooking();
    asUser(Other.userId);
    expect(await createPaymentLink(linkInput(b))).toEqual({ ok: false, error: X.patientNotFound });
    expect(await linkCount(b.id)).toBe(0);
  });

  // ── Montos y vencimiento ─────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2l] Montos y vencimiento: fuera de rango, seña ≥ restante, TOTAL con seña → rechazo", async () => {
    const b = await seedBooking();
    asUser(assistant.userId);
    for (const amountCents of [0, 99, 100_000_001]) {
      const r = await createPaymentLink(linkInput(b, { purpose: "DEPOSIT", amountCents }));
      expect(r).toMatchObject({ ok: false, error: PAYMENT_LINK_COPY.amountRange });
    }
    expect(await createPaymentLink(linkInput(b, { purpose: "DEPOSIT", amountCents: 20_000_00 }))).toEqual({
      ok: false,
      error: PAYMENT_LINK_COPY.depositTooHigh,
    });
    expect(await createPaymentLink({ ...linkInput(b), purpose: "FREE", bookingId: undefined, amountCents: 100_000_001 })).toMatchObject({
      ok: false,
      error: PAYMENT_LINK_COPY.amountRange,
    });
    expect(await linkCount(b.id)).toBe(0);

    // TOTAL con una seña PAID → rechazo. La seña se siembra por el camino real del guard (ACTIVE → PAID) y el
    // trigger de M18 la suma en `onlineDepositCents`.
    const dep = await db.onlineCharge.create({
      data: {
        tenantId: T.tenantId,
        origin: "LINK",
        kind: "DEPOSIT",
        mpAccountId: kineAccountId,
        practitionerId: kine.practitionerId,
        patientId: pat,
        bookingId: b.id,
        amountCents: 5_000_00,
        concept: "Seña",
        publicToken: randomBytes(16).toString("base64url"),
        createdByUserId: assistant.userId,
        expiresAt: new Date(Date.now() + DAY),
        idempotencyKey: `link:${randomUUID()}`,
      },
    });
    await db.onlineCharge.update({
      where: { id: dep.id },
      data: { status: "PAID", mpPaymentId: "123456", mpStatus: "approved", paidAmountCents: 5_000_00, approvedAt: new Date(), settledAt: new Date() },
    });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).onlineDepositCents).toBe(5_000_00);
    expect(await createPaymentLink(linkInput(b, { purpose: "TOTAL" }))).toEqual({ ok: false, error: PAYMENT_LINK_COPY.depositAlreadyPaid });
    const s = await getPaymentLinkSuggestions({ bookingId: b.id });
    expect(s).toMatchObject({ ok: true, data: { remainingCents: 15_000_00, totalCents: 20_000_00, depositPaidCents: 5_000_00, canTotal: false, blocked: null } });
    // REST con seña = lo que falta.
    const rest = await createPaymentLink(linkInput(b));
    expect(rest).toMatchObject({ ok: true, data: { amountCents: 15_000_00 } });
  });

  it("[TP-2l] vencimiento default 7, máx. 30 (31 → rechazo) = `expiration_date_to`", async () => {
    asUser(assistant.userId);
    const b7 = await seedBooking();
    const before = Date.now();
    const r7 = await createPaymentLink(linkInput(b7));
    expect(r7.ok).toBe(true);
    if (!r7.ok) return;
    const exp7 = new Date(r7.data.expiresAt).getTime();
    expect(exp7 - before).toBeGreaterThanOrEqual(7 * DAY - 5_000);
    expect(exp7 - before).toBeLessThanOrEqual(7 * DAY + 5_000);
    const row7 = await db.onlineCharge.findUniqueOrThrow({ where: { id: r7.data.chargeId } });
    expect(row7.expiresAt.toISOString()).toBe(r7.data.expiresAt);
    const pref = fakeMpGetPreference(row7.preferenceId!);
    expect(new Date(String(pref!.body.expiration_date_to)).getTime()).toBe(row7.expiresAt.getTime());

    const b30 = await seedBooking();
    const r30 = await createPaymentLink(linkInput(b30, { expiresInDays: 30 }));
    expect(r30.ok).toBe(true);
    if (r30.ok) expect(new Date(r30.data.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * DAY);

    const b31 = await seedBooking();
    const r31 = await createPaymentLink(linkInput(b31, { expiresInDays: 31 as 30 }));
    expect(r31.ok).toBe(false);
    expect(await linkCount(b31.id)).toBe(0);
  });

  // ── Creación ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2l] un vivo por turno; concurrentes → uno", async () => {
    const b = await seedBooking();
    asUser(assistant.userId);
    const [a, c] = await Promise.all([createPaymentLink(linkInput(b)), createPaymentLink(linkInput(b))]);
    const oks = [a, c].filter((x) => x.ok);
    expect(oks).toHaveLength(1);
    expect([a, c].find((x) => !x.ok)).toEqual({ ok: false, error: PAYMENT_LINK_COPY.liveLinkExists });
    expect(await db.onlineCharge.count({ where: { bookingId: b.id, origin: "LINK", status: "ACTIVE" } })).toBe(1);
    // Anulado el vivo, se puede generar otro.
    const live = oks[0];
    if (!live.ok) return;
    expect((await cancelPaymentLink({ chargeId: live.data.chargeId })).ok).toBe(true);
    expect((await createPaymentLink(linkInput(b))).ok).toBe(true);
  });

  it("[TP-2l] FREE de un paciente propio; ajeno → rechazo", async () => {
    asUser(kine.userId);
    const free = await createPaymentLink({
      patientId: pat,
      practitionerId: kine.practitionerId,
      purpose: "FREE",
      amountCents: 3_500_00,
      concept: "Plantillas",
      idempotencyKey: randomUUID(),
    });
    expect(free).toMatchObject({ ok: true, data: { amountCents: 3_500_00, accountKind: "PRACTITIONER" } });
    if (free.ok) {
      const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: free.data.chargeId } });
      expect(row).toMatchObject({ kind: "FREE", bookingId: null, copagoBasisCents: null });
    }
    // Paciente del Titular (no asignado al kine, sin «Consultorio común»): con `collectOwn` no es suyo.
    const ajeno = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
    const r = await createPaymentLink({
      patientId: ajeno,
      practitionerId: kine.practitionerId,
      purpose: "FREE",
      amountCents: 3_500_00,
      concept: "Plantillas",
      idempotencyKey: randomUUID(),
    });
    expect(r).toEqual({ ok: false, error: X.forbiddenOwn });
    // Paciente de otro consultorio.
    const foreign = await addPatient(db, Other);
    asUser(assistant.userId);
    expect(
      await createPaymentLink({ patientId: foreign, practitionerId: kine.practitionerId, purpose: "FREE", amountCents: 100, concept: "Otro", idempotencyKey: randomUUID() })
    ).toEqual({ ok: false, error: X.patientNotFound });
    expect(await db.onlineCharge.count({ where: { patientId: { in: [ajeno, foreign] } } })).toBe(0);
  });

  it("[TP-2l] turno cobrado, cancelado o en hold → rechazo", async () => {
    asUser(assistant.userId);
    const paid = await seedBooking({ paymentStatus: "PAID" });
    expect(await createPaymentLink(linkInput(paid))).toEqual({ ok: false, error: PAYMENT_LINK_COPY.alreadyPaid });
    const cancelled = await seedBooking({ status: "CANCELLED" });
    expect(await createPaymentLink(linkInput(cancelled))).toEqual({ ok: false, error: X.bookingInactive });
    // Reserva del turnero todavía impaga: key `pub:<tenant>:<uuid>`, PENDING + UNPAID.
    const hold = await seedBooking({ status: "PENDING", idempotencyKey: `pub:${T.tenantId}:${randomUUID()}` });
    expect(await createPaymentLink(linkInput(hold))).toEqual({ ok: false, error: X.publicHold });
    const s = await getPaymentLinkSuggestions({ bookingId: hold.id });
    expect(s).toMatchObject({ ok: true, data: { blocked: X.publicHold, canTotal: false } });
    expect(await db.onlineCharge.count({ where: { bookingId: { in: [paid.id, cancelled.id, hold.id] } } })).toBe(0);
  });

  it("[TP-2l] idempotencia: la misma key devuelve el mismo link", async () => {
    const b = await seedBooking();
    asUser(assistant.userId);
    const input = linkInput(b);
    const a = await createPaymentLink(input);
    const again = await createPaymentLink(input);
    expect(a.ok).toBe(true);
    expect(again).toEqual(a);
    expect(await linkCount(b.id)).toBe(1);
  });

  it("[TP-2l] preferencia caída → CANCELLED", async () => {
    const b = await seedBooking();
    asUser(assistant.userId);
    // Mercado Pago no responde: la red del fake devuelve 500 en la creación de la preferencia.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/checkout/preferences") && (init?.method ?? "GET") === "POST") return new Response("{}", { status: 500 });
      return realFetch(input, init);
    }) as typeof fetch;
    let r;
    try {
      r = await createPaymentLink(linkInput(b));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(r).toEqual({ ok: false, error: PAYMENT_LINK_COPY.preferenceFailed });
    const row = await db.onlineCharge.findFirstOrThrow({ where: { bookingId: b.id, origin: "LINK" } });
    expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "preference_failed", preferenceId: null });
    // El turno no queda bloqueado: el reintento (otro drawer) genera uno nuevo.
    expect((await createPaymentLink(linkInput(b))).ok).toBe(true);
  });

  // ── Anular ───────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2l] Anular: ACTIVE (vence la preferencia); AUTHORIZED → rechazo.", async () => {
    const { r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = await cancelPaymentLink({ chargeId: r.data.chargeId });
    expect(c).toEqual({ ok: true, data: { status: "CANCELLED" } });
    const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: r.data.chargeId } });
    expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "manual", cancelledByUserId: assistant.userId });
    expect(fakeMpGetPreference(row.preferenceId!)!.expired).toBe(true);
    expect(await cancelPaymentLink({ chargeId: r.data.chargeId })).toEqual({ ok: false, error: X.notCancellable });

    // AUTHORIZED: Mercado Pago retiene el pago.
    const { r: r2 } = await createRestLink();
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    await db.onlineCharge.update({ where: { id: r2.data.chargeId }, data: { status: "AUTHORIZED", mpStatus: "authorized" } });
    expect(await cancelPaymentLink({ chargeId: r2.data.chargeId })).toEqual({ ok: false, error: PAYMENT_LINK_COPY.inFlight });
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: r2.data.chargeId } })).status).toBe("AUTHORIZED");
  });

  it("[TP-2l] `cancelLiveLinksForBookingInTx` (cobro a mano, TP-2e): anula SOLO los ACTIVE del turno, en una sentencia", async () => {
    const { booking, r } = await createRestLink();
    if (!r.ok) throw new Error(r.error);
    const other = await createRestLink();
    if (!other.r.ok) throw new Error(other.r.error);
    const t0 = Date.now();
    const out = await runWithRls(T.tenantId, (tx) =>
      cancelLiveLinksForBookingInTx(tx, { tenantId: T.tenantId, bookingId: booking.id, reason: "collected", byUserId: assistant.userId })
    );
    expect(out.cancelledChargeIds).toEqual([r.data.chargeId]);
    const row = await db.onlineCharge.findUniqueOrThrow({ where: { id: r.data.chargeId } });
    expect(row).toMatchObject({ status: "CANCELLED", cancelReason: "collected", cancelledByUserId: assistant.userId });
    // Fecha en UTC real (columna sin zona): a lo sumo unos segundos de diferencia con el reloj del test.
    expect(Math.abs(row.cancelledAt!.getTime() - t0)).toBeLessThan(10_000);
    expect((await db.onlineCharge.findUniqueOrThrow({ where: { id: other.r.data.chargeId } })).status).toBe("ACTIVE");
    // Sin links vivos: no anula nada (idempotente).
    const again = await runWithRls(T.tenantId, (tx) =>
      cancelLiveLinksForBookingInTx(tx, { tenantId: T.tenantId, bookingId: booking.id, reason: "collected", byUserId: null })
    );
    expect(again.cancelledChargeIds).toEqual([]);
  });

  // ── Página pública ───────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2l] Página pública: `getPublicPaymentLink` sin datos del paciente y con sus estados", async () => {
    const { booking, r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const token = tokenOf(r.data.url);
    const page = await getPublicPaymentLink(token);
    expect(page).toMatchObject({ status: "payable", amountCents: 20_000_00, concept: "Sesión de rodilla", receipt: null });
    expect(page!.checkoutUrl).toMatch(/\/api\/mp\/fake\/checkout\//);
    const patient = await db.patient.findUniqueOrThrow({ where: { id: pat } });
    const json = JSON.stringify(page);
    for (const s of [patient.firstName, patient.lastName, patient.documentId!, patient.email!, patient.phone!, booking.id]) {
      expect(json).not.toContain(s);
    }

    // Pagado (comprobante) → sin checkout.
    await db.onlineCharge.update({
      where: { id: r.data.chargeId },
      data: {
        status: "PAID",
        mpPaymentId: "987654321",
        mpStatus: "approved",
        paidAmountCents: 20_000_00,
        approvedAt: new Date("2026-10-23T02:30:00.000Z"),
        settledAt: new Date(),
        paymentTypeId: "credit_card",
        paymentMethodId: "visa",
      },
    });
    expect(await getPublicPaymentLink(token)).toMatchObject({
      status: "paid",
      checkoutUrl: null,
      receipt: { operationId: "987654321", approvedAtLabel: "22/10/2026, 23:30", methodLabel: "Tarjeta de crédito Visa" },
    });
  });

  it("[TP-2l] turno cancelado o cobrado → sin checkout; el GET no escribe (vencido sigue ACTIVE)", async () => {
    const { booking, r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const token = tokenOf(r.data.url);
    await db.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
    expect(await getPublicPaymentLink(token)).toMatchObject({ status: "cancelled", checkoutUrl: null });

    const { booking: b2, r: r2 } = await createRestLink();
    if (!r2.ok) throw new Error(r2.error);
    await db.booking.update({
      where: { id: b2.id },
      data: { paymentStatus: "PAID", copagoPaidAt: new Date(), copagoPaymentMethod: "CASH", copagoCollectedById: T.userId },
    });
    expect(await getPublicPaymentLink(tokenOf(r2.data.url))).toMatchObject({ status: "cancelled", checkoutUrl: null });

    // Un link ACTIVE vencido por reloj: la página dice «vencido» y la fila NO cambia (lo vence el cron).
    const b3 = await seedBooking();
    const expiredToken = randomBytes(16).toString("base64url");
    const exp = await db.onlineCharge.create({
      data: {
        tenantId: T.tenantId,
        origin: "LINK",
        kind: "FULL",
        mpAccountId: kineAccountId,
        practitionerId: kine.practitionerId,
        patientId: pat,
        bookingId: b3.id,
        amountCents: 20_000_00,
        concept: "Vencido",
        publicToken: expiredToken,
        createdByUserId: assistant.userId,
        createdAt: new Date(Date.now() - 3 * DAY),
        expiresAt: new Date(Date.now() - DAY),
        idempotencyKey: `link:${randomUUID()}`,
      },
    });
    const before = await db.onlineCharge.findUniqueOrThrow({ where: { id: exp.id } });
    const auditsBefore = await db.auditEvent.count({ where: { tenantId: T.tenantId } });
    expect(await getPublicPaymentLink(expiredToken)).toMatchObject({ status: "expired", checkoutUrl: null });
    const after = await db.onlineCharge.findUniqueOrThrow({ where: { id: exp.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId } })).toBe(auditsBefore);
  });

  it("[TP-2l] token inválido → null; rate limit 60/min/IP", async () => {
    expect(await getPublicPaymentLink("corto")).toBeNull();
    expect(await getPublicPaymentLink("../../etc/passwd/xxxxxx")).toBeNull();
    expect(await getPublicPaymentLink(randomBytes(16).toString("base64url"))).toBeNull();
    const { r } = await createRestLink();
    if (!r.ok) throw new Error(r.error);
    const token = tokenOf(r.data.url);
    __rateLimitInternals.reset();
    for (let i = 0; i < 60; i++) expect((await getPublicPaymentLink(token))?.status).toBe("payable");
    expect(await getPublicPaymentLink(token)).toBeNull();
  });

  it("[TP-2l] consultorio suspendido → unavailable (TP-D23)", async () => {
    const { r } = await createRestLink();
    if (!r.ok) throw new Error(r.error);
    await db.tenant.update({ where: { id: T.tenantId }, data: { status: "SUSPENDED", statusChangedAt: new Date() } });
    try {
      expect(await getPublicPaymentLink(tokenOf(r.data.url))).toMatchObject({ status: "unavailable", checkoutUrl: null });
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: { status: "ACTIVE", statusChangedAt: new Date() } });
    }
  });

  // ── Canales ──────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2l] email sin concepto, con `fromName` y `EmailLog`; sin email → error", async () => {
    const { r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = await sendPaymentLinkEmail({ chargeId: r.data.chargeId });
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    const patient = await db.patient.findUniqueOrThrow({ where: { id: pat } });
    expect(e.data.sentToMasked).not.toBe(patient.email);
    expect(e.data.sentToMasked).toMatch(/^p\*\*\*@test\.local$/);
    expect(mails).toHaveLength(1);
    const m = mails[0];
    const tenantName = (await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId } })).name;
    expect(m).toMatchObject({ kind: "payment_link", to: patient.email, fromName: tenantName, entity: "OnlineCharge", entityId: r.data.chargeId });
    expect(m.subject).toBe(`${tenantName}: tu link de pago`);
    expect(`${m.subject} ${m.text} ${m.html}`).not.toContain("rodilla");
    expect(m.text).toContain(r.data.url);
    const log = await db.emailLog.findFirst({ where: { entity: "OnlineCharge", entityId: r.data.chargeId } });
    expect(log).toMatchObject({ kind: "payment_link", tenantId: T.tenantId, status: "sent" });

    // 3 por hora por cobro.
    expect((await sendPaymentLinkEmail({ chargeId: r.data.chargeId })).ok).toBe(true);
    expect((await sendPaymentLinkEmail({ chargeId: r.data.chargeId })).ok).toBe(true);
    const fourth = await sendPaymentLinkEmail({ chargeId: r.data.chargeId });
    expect(fourth.ok).toBe(false);
    expect(mails).toHaveLength(3);

    // Sin email cargado → error con el nombre.
    const b = await seedBooking({ patientId: patNoEmail });
    asUser(assistant.userId);
    const r2 = await createPaymentLink(linkInput(b, { patientId: patNoEmail }));
    if (!r2.ok) throw new Error(r2.error);
    const noEmail = await sendPaymentLinkEmail({ chargeId: r2.data.chargeId });
    expect(noEmail.ok).toBe(false);
    if (!noEmail.ok) expect(noEmail.error).toMatch(/no tiene email cargado\.$/);
  });

  it("[TP-2l] WhatsApp: texto y `wa.me`.", async () => {
    const { r } = await createRestLink();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = await getPaymentLinkShare({ chargeId: r.data.chargeId });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.data.url).toBe(r.data.url);
    expect(s.data.waUrl).toMatch(/^https:\/\/wa\.me\/549\d+\?text=/);
    expect(s.data.contact).toMatchObject({ status: "ok" });
    // El WhatsApp sí lleva el concepto (TP-D27) y la URL.
    expect(s.data.text).toContain("Sesión de rodilla");
    expect(decodeURIComponent(s.data.waUrl!.split("?text=")[1])).toBe(s.data.text);
    // Anulado → ya no se comparte.
    await cancelPaymentLink({ chargeId: r.data.chargeId });
    expect(await getPaymentLinkShare({ chargeId: r.data.chargeId })).toEqual({ ok: false, error: X.notShareable });
  });
});
