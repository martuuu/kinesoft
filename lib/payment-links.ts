"use server";

/**
 * Links de pago (T5, contrato C-TP9 del plan §25.7; decisión 3 del 19-oct: siempre a nombre de un paciente, desde el
 * turno o sin turno). Implementación de TP-2d sobre las firmas congeladas de TP-K2.
 *
 * Orden de `createPaymentLink` (Anexo B, literal):
 *   1. Soporte → rechazo.
 *   2. zod; rate limit de 30 cada 10 minutos por usuario.
 *   3. `runWithRls`: paciente; turno con FOR UPDATE (del paciente y del profesional; PENDING sin hold público,
 *      CONFIRMED o COMPLETED; UNPAID/FAILED; sin cobro TURNERO vivo).
 *   4. `canCollectCopago`.
 *   5. Cuenta + delegación (salvo el dueño).
 *   6. Monto por `purpose`.
 *   7. INSERT ACTIVE (`publicToken = randomBytes(16).base64url`). P2002 del parcial → `liveLinkExists`; replay por la key.
 *   8. Audit `paymentLink.create` (sin concepto).
 *   9. Después del commit: preferencia (vence con el link; `back_urls` `/pagar/<token>?r=ok|failed|pending`). Si falla →
 *      CANCELLED(`preference_failed`).
 *
 * Permisos (§25.7, TP-D12, TP-UI-D8): `canCollectCopago` (Secretaría, Admin, Facturación y Titular con
 * `billing.collect`; el profesional con `collectOwn` solo lo suyo) y, sobre la cuenta que cobra, la delegación
 * `linksDelegated` salvo que el actor sea su dueño — también el Titular sobre la cuenta de otro profesional: la plata
 * entra a la cuenta de otra persona. Soporte nunca (ni crea, ni anula, ni comparte).
 *
 * El turno se toma FOR UPDATE antes de mirar sus cobros, igual que el webhook (`Booking FOR UPDATE` → cobro) y el cobro
 * a mano (§25.3 «Locks»): dos Secretarías generando a la vez esperan una a la otra y la segunda ve el link de la
 * primera («un link vivo por turno»); el único parcial de M18 queda de red.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { getActor } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { auditInTx } from "@/lib/audit";
import { MEMBER_ACCESS_SELECT, canCollectCopago, capabilitiesForMembership, type Capability } from "@/lib/capabilities";
import { patientAccessFor } from "@/lib/visibility";
import { isPublicReservation, isUnpaidPublicPending } from "@/lib/booking-capacity";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { mpConnectMode } from "@/lib/env";
import { normalizeArMobile } from "@/lib/phone-e164";
import { whatsAppShareUrl, type ShareContact } from "@/lib/booking-share";
import "@/lib/email/log";
import { sendEmail } from "@/lib/email";
import { maskEmail } from "@/lib/email/transport";
import { paymentLinkEmail } from "@/lib/email/templates-payments";
import { expirePreferencesBestEffort } from "@/lib/mp-connect/account-client";
import { resolveChargeAccount } from "@/lib/mp-connect/accounts-internal";
import { PAYMENT_LINK_COPY } from "@/lib/online-payments-copy";
import { ONLINE_PAYMENTS_AUDIT } from "@/lib/online-payments-types";
import { CreatePaymentLinkSchema, type CreatePaymentLinkInput, type CreatePaymentLinkResult } from "@/lib/payment-links-types";
import {
  PAYMENT_LINK_EXTRA_COPY as X,
  bookingLinkBlock,
  linkAccountGate,
  linkAmountFor,
  linkExpiresAt,
  paymentLinkShareText,
  type LinkBookingFacts,
} from "@/lib/payment-links-logic";
import {
  newPaymentLinkToken,
  openPaymentLinkPreference,
  paymentLinkUrl,
  resolveLinkCopagoInTx,
} from "@/lib/payment-links-internal";
import type { ActionResult } from "@/lib/validation";

type Tx = Prisma.TransactionClient;

/**
 * Capabilities del actor leídas DENTRO de la tx (misma lectura que `actorCapsInTx` de `lib/bookings-core.ts`). No se
 * importa de ahí a propósito: el guard de realtime (`scripts/guard-realtime.mjs` (c)) trata a todo importador de
 * `bookings-core` como write-path de Booking que debe emitir `afterBookingsCommitted`, y un link de pago no cambia el
 * turno (TP-UI-D4: la card no muestra «link enviado»). `getMembershipRole` abriría otra tx (dos conexiones a la vez).
 */
async function actorCapsInTx(tx: Tx, actor: { userId: string; tenantId: string }): Promise<ReadonlySet<Capability>> {
  const m = await tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: MEMBER_ACCESS_SELECT,
  });
  return capabilitiesForMembership(m);
}
type Fail = { ok: false; error: string; fieldErrors?: Record<string, string[]> };
const fail = (error: string): Fail => ({ ok: false, error });

/** Tope de creación (Anexo B, paso 2): 30 cada 10 minutos por usuario. */
const CREATE_RATE = { limit: 30, windowMs: 10 * 60_000 } as const;
/** Tope del mail (C-TP9): 3 por hora por cobro. El buzón que se protege es el del paciente. */
const EMAIL_RATE = { limit: 3, windowMs: 60 * 60_000 } as const;

const ChargeIdSchema = z.object({ chargeId: z.string().min(1).max(40) });
const BookingIdSchema = z.object({ bookingId: z.string().min(1).max(40) });

/** Lo que importa del turno para decidir un link, en UNA lectura (estado, plata, cobros vivos o pagados). */
const BOOKING_FOR_LINK_SELECT = {
  id: true,
  patientId: true,
  practitionerId: true,
  serviceId: true,
  status: true,
  paymentStatus: true,
  copagoCents: true,
  onlineDepositCents: true,
  idempotencyKey: true,
  payment: { select: { status: true } },
} satisfies Prisma.BookingSelect;

type BookingForLink = Prisma.BookingGetPayload<{ select: typeof BOOKING_FOR_LINK_SELECT }>;

async function loadBookingForLink(tx: Tx, tenantId: string, bookingId: string) {
  const b = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: BOOKING_FOR_LINK_SELECT });
  if (!b) return null;
  const charges = await tx.onlineCharge.findMany({
    where: { tenantId, bookingId, status: { in: ["ACTIVE", "AUTHORIZED", "PAID"] } },
    select: { origin: true, kind: true, status: true },
  });
  return { b, charges };
}

function bookingFacts(b: BookingForLink, charges: LinkBookingFacts["charges"]): LinkBookingFacts {
  return {
    status: b.status,
    paymentStatus: b.paymentStatus,
    publicHold: isUnpaidPublicPending({
      status: b.status,
      paymentStatus: b.paymentStatus,
      publicReservation: isPublicReservation({ idempotencyKey: b.idempotencyKey, patientId: b.patientId }),
    }),
    legacyPaid: b.payment?.status === "PAID" || b.payment?.status === "AUTHORIZED",
    charges,
  };
}

/** Copy del rechazo de `canCollectCopago`: `collectOwn` con un turno ajeno vs. un rol que no cobra (como C-AS2). */
function forbiddenCopy(caps: ReadonlySet<Capability>): string {
  return caps.has("billing.collectOwn") && !caps.has("billing.collect") ? X.forbiddenOwn : X.forbidden;
}

/**
 * La cuenta que cobra (la del profesional ACTIVE → la del consultorio si `useClinicAccount` → ninguna; TP-2b) y si el
 * actor la puede usar. Sin cuenta viva distingue «necesita reconectarse» (REAUTH_REQUIRED) de «no tiene» para que la
 * Secretaría sepa a quién pedirle qué.
 */
async function accountForLink(
  tx: Tx,
  o: {
    tenantId: string;
    tenantName: string;
    practitionerId: string;
    practitionerName: string;
    actorPractitionerId: string | null;
    caps: ReadonlySet<Capability>;
  }
): Promise<
  | { ok: true; account: { id: string; kind: "PRACTITIONER" | "CLINIC" } }
  | { ok: false; error: string; kind: "PRACTITIONER" | "CLINIC" | null }
> {
  const policy = await tx.bookingPaymentPolicy.findUnique({ where: { tenantId: o.tenantId }, select: { useClinicAccount: true } });
  const useClinicAccount = policy?.useClinicAccount ?? false;
  const account = await resolveChargeAccount({ tenantId: o.tenantId, practitionerId: o.practitionerId, useClinicAccount });
  if (!account || account.status !== "ACTIVE") {
    const stale = await tx.mpAccount.findFirst({
      where: {
        tenantId: o.tenantId,
        status: "REAUTH_REQUIRED",
        OR: [{ practitionerId: o.practitionerId }, ...(useClinicAccount ? [{ practitionerId: null }] : [])],
      },
      select: { kind: true },
    });
    if (stale) {
      const name = stale.kind === "CLINIC" ? o.tenantName : o.practitionerName;
      return { ok: false, error: PAYMENT_LINK_COPY.reauth(name), kind: null };
    }
    return { ok: false, error: PAYMENT_LINK_COPY.noAccount(o.practitionerName), kind: null };
  }
  const ownerName = account.kind === "CLINIC" ? o.tenantName : o.practitionerName;
  const gate = linkAccountGate(
    { kind: account.kind, practitionerId: account.practitionerId, linksDelegated: account.linksDelegated },
    { practitionerId: o.actorPractitionerId, isAccountOwner: o.caps.has("account.owner") },
    ownerName
  );
  if (!gate.ok) return { ok: false, error: gate.error, kind: account.kind };
  return { ok: true, account: { id: account.id, kind: account.kind } };
}

function practitionerDisplayName(p: { user: { fullName: string | null; email: string } } | null): string {
  return p?.user.fullName?.trim() || "El profesional";
}

// ── Crear ───────────────────────────────────────────────────────────────────────────────────────────────────────────

type CreateOutcome =
  | Fail
  | { ok: true; replay: boolean; chargeId: string; tokenUrl: string; amountCents: number; expiresAt: Date; accountKind: "PRACTITIONER" | "CLINIC"; status: string; cancelReason: string | null };

async function replayByKey(tx: Tx, tenantId: string, userId: string, key: string): Promise<CreateOutcome | null> {
  const prev = await tx.onlineCharge.findFirst({
    where: { tenantId, idempotencyKey: key, origin: "LINK" },
    select: {
      id: true,
      publicToken: true,
      amountCents: true,
      expiresAt: true,
      status: true,
      cancelReason: true,
      createdByUserId: true,
      mpAccount: { select: { kind: true } },
    },
  });
  if (!prev) return null;
  // La key es del drawer de ESE usuario: otra persona con la misma key no recibe el link ajeno.
  if (prev.createdByUserId !== userId || !prev.publicToken) return fail(X.invalid);
  return {
    ok: true,
    replay: true,
    chargeId: prev.id,
    tokenUrl: paymentLinkUrl(prev.publicToken),
    amountCents: prev.amountCents,
    expiresAt: prev.expiresAt,
    accountKind: prev.mpAccount.kind,
    status: prev.status,
    cancelReason: prev.cancelReason,
  };
}

function zodFail(err: z.ZodError): Fail {
  const fieldErrors: Record<string, string[]> = {};
  for (const i of err.issues) {
    const k = String(i.path[0] ?? "_");
    (fieldErrors[k] ??= []).push(i.message);
  }
  if (fieldErrors.amountCents) return { ok: false, error: PAYMENT_LINK_COPY.amountRange, fieldErrors };
  return { ok: false, error: X.invalid, fieldErrors };
}

export async function createPaymentLink(raw: CreatePaymentLinkInput): Promise<ActionResult<CreatePaymentLinkResult>> {
  // 1. Soporte → rechazo (antes que nada: ni siquiera consume el cupo del rate limit).
  const actor = await getActor();
  if (actor.support) return fail(X.support);

  // 2. zod + rate limit.
  const parsed = CreatePaymentLinkSchema.safeParse(raw);
  if (!parsed.success) return zodFail(parsed.error);
  const input = parsed.data;
  const rl = await rateLimit(`payment-link:create:user:${actor.userId}`, CREATE_RATE);
  if (!rl.ok) return fail(rateLimitedMessage(rl.retryAfterMs));
  // Modo apagado: no hay con qué abrir el checkout. Se corta antes de escribir (un cobro ACTIVE sin preferencia se
  // anularía enseguida, pero dejaría una fila y un audit de algo que nunca pudo existir).
  if (mpConnectMode() === "off") return fail(X.connectOff);

  const key = `link:${input.idempotencyKey}`;
  const tenantId = actor.tenantId;

  let outcome: CreateOutcome;
  try {
    outcome = await runWithRls(tenantId, async (tx): Promise<CreateOutcome> => {
      // 3. Paciente y profesional del consultorio (las FK saltean RLS: se validan a mano).
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId }, select: { id: true } });
      if (!patient) return fail(X.patientNotFound);
      const practitioner = await tx.practitioner.findFirst({
        where: { id: input.practitionerId, tenantId },
        select: { id: true, user: { select: { fullName: true, email: true } } },
      });
      if (!practitioner) return fail(X.practitionerNotFound);
      const practitionerName = practitionerDisplayName(practitioner);

      let booking: { b: BookingForLink; charges: LinkBookingFacts["charges"] } | null = null;
      if (input.bookingId) {
        await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${input.bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
        booking = await loadBookingForLink(tx, tenantId, input.bookingId);
        // Turno de otro paciente: el mismo copy que inexistente (no confirma que el id existe).
        if (!booking || booking.b.patientId !== input.patientId) return fail(X.bookingNotFound);
        if (booking.b.practitionerId !== input.practitionerId) return fail(X.practitionerMismatch);
      }

      // 4. Permiso de cobro sobre el profesional imputado.
      const caps = await actorCapsInTx(tx, actor);
      if (!canCollectCopago(caps, actor.practitionerId, input.practitionerId)) return fail(forbiddenCopy(caps));
      // Sin turno, `collectOwn` además exige que el paciente sea suyo (TP-UI-D8: «sus turnos y pacientes»). Con turno
      // alcanza con que el turno sea suyo, como el cobro a mano (`toggleBilling`).
      if (!input.bookingId && !caps.has("billing.collect") && (await patientAccessFor(actor, input.patientId, tx)) !== "full") {
        return fail(X.forbiddenOwn);
      }

      // Replay (Anexo B, paso 7): ANTES de las reglas del turno, que ahora verían «ya hay un link activo» (el propio).
      const replay = await replayByKey(tx, tenantId, actor.userId, key);
      if (replay) return replay;

      if (booking) {
        const block = bookingLinkBlock(bookingFacts(booking.b, booking.charges));
        if (block) return fail(block);
      }

      // 5. Cuenta + delegación.
      const acc = await accountForLink(tx, {
        tenantId,
        tenantName: actor.tenantName,
        practitionerId: input.practitionerId,
        practitionerName,
        actorPractitionerId: actor.practitionerId,
        caps,
      });
      if (!acc.ok) return fail(acc.error);

      // 6. Monto por `purpose`.
      const resolvedCopagoCents = booking ? await resolveLinkCopagoInTx(tx, tenantId, booking.b) : null;
      const amount = linkAmountFor(input.purpose, {
        resolvedCopagoCents,
        onlineDepositCents: booking?.b.onlineDepositCents ?? 0,
        amountCents: input.amountCents ?? null,
      });
      if (!amount.ok) return fail(amount.error);

      // 7. INSERT ACTIVE. El guard de M18 vuelve a exigir cuenta ACTIVE del profesional (o del consultorio) y turno
      // de ese profesional.
      const token = await newPaymentLinkToken();
      const expiresAt = linkExpiresAt(new Date(), input.expiresInDays);
      const created = await tx.onlineCharge.create({
        data: {
          tenantId,
          origin: "LINK",
          kind: amount.kind,
          mpAccountId: acc.account.id,
          practitionerId: input.practitionerId,
          patientId: input.patientId,
          bookingId: input.bookingId ?? null,
          amountCents: amount.amountCents,
          copagoBasisCents: amount.copagoBasisCents,
          concept: input.concept.trim(),
          publicToken: token,
          expiresAt,
          idempotencyKey: key,
          createdByUserId: actor.userId,
        },
        select: { id: true },
      });

      // 8. Audit sin concepto (puede ser clínico) ni token (sirve para pagar).
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: ONLINE_PAYMENTS_AUDIT.paymentLinkCreate,
        entity: "OnlineCharge",
        entityId: created.id,
        payload: {
          purpose: input.purpose,
          kind: amount.kind,
          amountCents: amount.amountCents,
          bookingId: input.bookingId ?? null,
          patientId: input.patientId,
          practitionerId: input.practitionerId,
          accountKind: acc.account.kind,
          expiresInDays: input.expiresInDays ?? 7,
        },
      });

      return {
        ok: true,
        replay: false,
        chargeId: created.id,
        tokenUrl: paymentLinkUrl(token),
        amountCents: amount.amountCents,
        expiresAt,
        accountKind: acc.account.kind,
        status: "ACTIVE",
        cancelReason: null,
      };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = JSON.stringify(e.meta?.target ?? "");
      if (target.includes("idempotencyKey")) {
        // Dos requests con la misma key a la vez (doble click): el segundo devuelve el del primero.
        const again = await runWithRls(tenantId, (tx) => replayByKey(tx, tenantId, actor.userId, key));
        if (!again) return fail(X.invalid);
        outcome = again;
      } else {
        // El único parcial «un link vivo por turno» (el lock del turno lo hace casi imposible; queda de red).
        return fail(PAYMENT_LINK_COPY.liveLinkExists);
      }
    } else {
      throw e;
    }
  }
  if (!outcome.ok) return outcome;

  // Replay de un link que ya se cerró: CANCELLED por la preferencia caída devuelve el mismo error que la primera vez.
  if (outcome.replay && outcome.status !== "ACTIVE") {
    return fail(outcome.cancelReason === "preference_failed" ? PAYMENT_LINK_COPY.preferenceFailed : X.notShareable);
  }

  // 9. Preferencia DESPUÉS del commit (idempotente: en el replay devuelve la que ya estaba).
  const pref = await openPaymentLinkPreference({ tenantId, chargeId: outcome.chargeId });
  if (!pref.ok) return fail(PAYMENT_LINK_COPY.preferenceFailed);

  return {
    ok: true,
    data: {
      chargeId: outcome.chargeId,
      url: outcome.tokenUrl,
      amountCents: outcome.amountCents,
      expiresAt: outcome.expiresAt.toISOString(),
      accountKind: outcome.accountKind,
    },
  };
}

// ── Anular ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function cancelPaymentLink(raw: { chargeId: string }): Promise<ActionResult<{ status: "CANCELLED" }>> {
  const actor = await getActor();
  if (actor.support) return fail(X.support);
  const parsed = ChargeIdSchema.safeParse(raw);
  if (!parsed.success) return fail(X.linkNotFound);
  const { chargeId } = parsed.data;
  const tenantId = actor.tenantId;

  const r = await runWithRls(tenantId, async (tx): Promise<Fail | { ok: true; preferenceId: string | null }> => {
    const c = await tx.onlineCharge.findFirst({
      where: { id: chargeId, tenantId, origin: "LINK" },
      select: { id: true, bookingId: true, practitionerId: true, status: true, preferenceId: true },
    });
    if (!c) return fail(X.linkNotFound);
    const caps = await actorCapsInTx(tx, actor);
    if (!canCollectCopago(caps, actor.practitionerId, c.practitionerId)) return fail(forbiddenCopy(caps));
    // Mismo orden de locks que el webhook: el turno primero, después el cobro (el UPDATE condicional).
    if (c.bookingId) {
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${c.bookingId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    }
    const res = await tx.onlineCharge.updateMany({
      where: { id: c.id, tenantId, status: "ACTIVE" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: actor.userId, cancelReason: "manual" },
    });
    if (res.count === 0) {
      // AUTHORIZED: Mercado Pago retiene un pago que todavía puede acreditarse (el guard de M18 tampoco lo deja).
      const now = await tx.onlineCharge.findFirst({ where: { id: c.id, tenantId }, select: { status: true } });
      return fail(now?.status === "AUTHORIZED" ? PAYMENT_LINK_COPY.inFlight : X.notCancellable);
    }
    await auditInTx(tx, {
      tenantId,
      actorId: actor.userId,
      action: ONLINE_PAYMENTS_AUDIT.paymentLinkCancel,
      entity: "OnlineCharge",
      entityId: c.id,
      payload: { bookingId: c.bookingId, reason: "manual" },
    });
    return { ok: true, preferenceId: c.preferenceId };
  });
  if (!r.ok) return r;

  // Después del commit y best effort: si Mercado Pago no responde, el link igual quedó anulado (el consumidor del
  // webhook registra un pago tardío y avisa, §25.3).
  if (r.preferenceId) await expirePreferencesBestEffort(tenantId, [chargeId]);
  return { ok: true, data: { status: "CANCELLED" } };
}

// ── Compartir ───────────────────────────────────────────────────────────────────────────────────────────────────────

const SHARE_SELECT = {
  id: true,
  status: true,
  practitionerId: true,
  patientId: true,
  publicToken: true,
  checkoutUrl: true,
  amountCents: true,
  concept: true,
  expiresAt: true,
  mpAccount: { select: { kind: true } },
  practitioner: { select: { user: { select: { fullName: true, email: true } } } },
  patient: { select: { firstName: true, lastName: true, email: true, phone: true } },
  tenant: { select: { name: true, publicEmail: true } },
} satisfies Prisma.OnlineChargeSelect;

type ShareCharge = Prisma.OnlineChargeGetPayload<{ select: typeof SHARE_SELECT }>;

/** El cobro a compartir, si el actor cobra para ese profesional y el link sigue pagable. */
async function loadShareable(tx: Tx, actor: Awaited<ReturnType<typeof getActor>>, chargeId: string): Promise<Fail | { ok: true; c: ShareCharge }> {
  const c = await tx.onlineCharge.findFirst({ where: { id: chargeId, tenantId: actor.tenantId, origin: "LINK" }, select: SHARE_SELECT });
  if (!c) return fail(X.linkNotFound);
  const caps = await actorCapsInTx(tx, actor);
  if (!canCollectCopago(caps, actor.practitionerId, c.practitionerId)) return fail(forbiddenCopy(caps));
  if (c.status !== "ACTIVE" || !c.checkoutUrl || !c.publicToken || c.expiresAt.getTime() <= Date.now()) {
    return fail(X.notShareable);
  }
  return { ok: true, c };
}

export async function getPaymentLinkShare(raw: {
  chargeId: string;
}): Promise<ActionResult<{ url: string; text: string; waUrl: string | null; contact: ShareContact }>> {
  const actor = await getActor();
  if (actor.support) return fail(X.support);
  const parsed = ChargeIdSchema.safeParse(raw);
  if (!parsed.success) return fail(X.linkNotFound);

  return runWithRls(actor.tenantId, async (tx) => {
    const r = await loadShareable(tx, actor, parsed.data.chargeId);
    if (!r.ok) return r;
    const c = r.c;
    // Contacto con la misma regla que el drawer del turno (`getPatientShareContact`): `full` y `admin` lo ven.
    const access = await patientAccessFor(actor, c.patientId, tx);
    let contact: ShareContact = { status: "hidden" };
    if (access === "full" || access === "admin") {
      const m = normalizeArMobile(c.patient.phone);
      contact = m.ok ? { status: "ok", e164: m.e164 } : { status: "invalid", reason: m.reason };
    }
    const url = paymentLinkUrl(c.publicToken!);
    const text = paymentLinkShareText({
      patientFirstName: contact.status === "hidden" ? "" : c.patient.firstName,
      clinicName: c.tenant.name,
      amountCents: c.amountCents,
      concept: c.concept ?? "",
      url,
      expiresAt: c.expiresAt,
    });
    // `null` sin celular válido (contrato): la UI ofrece copiar el texto en vez de un WhatsApp sin destinatario.
    const waUrl = contact.status === "ok" ? whatsAppShareUrl(text, contact.e164) : null;
    return { ok: true as const, data: { url, text, waUrl, contact } };
  });
}

/** Contrato: 3 por hora por cobro; el mail va sin concepto ni datos clínicos (TP-D27). */
export async function sendPaymentLinkEmail(raw: { chargeId: string }): Promise<ActionResult<{ sentToMasked: string }>> {
  const actor = await getActor();
  if (actor.support) return fail(X.support);
  const parsed = ChargeIdSchema.safeParse(raw);
  if (!parsed.success) return fail(X.linkNotFound);
  const chargeId = parsed.data.chargeId;

  const r = await runWithRls(actor.tenantId, (tx) => loadShareable(tx, actor, chargeId));
  if (!r.ok) return r;
  const c = r.c;
  const email = c.patient.email?.trim();
  if (!email) return fail(PAYMENT_LINK_COPY.noEmail(`${c.patient.firstName} ${c.patient.lastName}`.trim()));

  const rl = await rateLimit(`payment-link:email:charge:${chargeId}`, EMAIL_RATE);
  if (!rl.ok) return fail(rateLimitedMessage(rl.retryAfterMs));

  const sent = await sendEmail({
    ...paymentLinkEmail({
      tenantName: c.tenant.name,
      practitionerName: c.mpAccount.kind === "PRACTITIONER" ? practitionerDisplayName(c.practitioner) : null,
      amountCents: c.amountCents,
      url: paymentLinkUrl(c.publicToken!),
      expiresAt: c.expiresAt,
    }),
    kind: "payment_link",
    to: email,
    tenantId: actor.tenantId,
    entity: "OnlineCharge",
    entityId: c.id,
    fromName: c.tenant.name,
    replyTo: c.tenant.publicEmail || null,
    actorId: actor.userId,
  });
  // `skipped` = el ENTORNO no manda (dev, Preview, Mailpit caído): queda en EmailLog como no enviado, pero no es una
  // falla del proveedor que la Secretaría pueda resolver reintentando (mismo criterio que `deliverPatientDocument`).
  if (!sent.ok && !sent.skipped) return fail(X.emailFailed);
  return { ok: true, data: { sentToMasked: maskEmail(email) } };
}

// ── Sugerencias del drawer ──────────────────────────────────────────────────────────────────────────────────────────

export async function getPaymentLinkSuggestions(raw: { bookingId: string }): Promise<
  ActionResult<{
    remainingCents: number;
    totalCents: number;
    depositPaidCents: number;
    canTotal: boolean;
    accountKind: "PRACTITIONER" | "CLINIC" | null;
    blocked: string | null;
  }>
> {
  const actor = await getActor();
  if (actor.support) return fail(X.support);
  const parsed = BookingIdSchema.safeParse(raw);
  if (!parsed.success) return fail(X.bookingNotFound);
  const tenantId = actor.tenantId;

  return runWithRls(tenantId, async (tx) => {
    const loaded = await loadBookingForLink(tx, tenantId, parsed.data.bookingId);
    if (!loaded || !loaded.b.patientId) return fail(X.bookingNotFound);
    const { b, charges } = loaded;
    const caps = await actorCapsInTx(tx, actor);
    if (!canCollectCopago(caps, actor.practitionerId, b.practitionerId)) return fail(forbiddenCopy(caps));

    const totalCents = await resolveLinkCopagoInTx(tx, tenantId, b);
    const depositPaidCents = Math.max(0, b.onlineDepositCents);
    const remainingCents = Math.max(0, totalCents - depositPaidCents);

    // Mismas reglas y mismo orden que `createPaymentLink`: lo que el drawer ofrece es lo que la action acepta.
    let blocked: string | null = bookingLinkBlock(bookingFacts(b, charges));
    let accountKind: "PRACTITIONER" | "CLINIC" | null = null;
    if (!blocked && mpConnectMode() === "off") blocked = X.connectOff;
    if (!blocked) {
      const practitioner = await tx.practitioner.findFirst({
        where: { id: b.practitionerId, tenantId },
        select: { user: { select: { fullName: true, email: true } } },
      });
      const acc = await accountForLink(tx, {
        tenantId,
        tenantName: actor.tenantName,
        practitionerId: b.practitionerId,
        practitionerName: practitionerDisplayName(practitioner),
        actorPractitionerId: actor.practitionerId,
        caps,
      });
      if (acc.ok) accountKind = acc.account.kind;
      else blocked = acc.error;
    }
    if (!blocked) {
      const rest = linkAmountFor("REST", { resolvedCopagoCents: totalCents, onlineDepositCents: depositPaidCents });
      if (!rest.ok) blocked = rest.error;
    }
    const canTotal =
      !blocked && linkAmountFor("TOTAL", { resolvedCopagoCents: totalCents, onlineDepositCents: depositPaidCents }).ok;
    return { ok: true as const, data: { remainingCents, totalCents, depositPaidCents, canTotal, accountKind, blocked } };
  });
}
