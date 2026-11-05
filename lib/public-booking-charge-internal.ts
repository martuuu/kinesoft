import "server-only";
import type { Prisma } from "@prisma/client";
// Turnero público: sin Actor → canal de servicio (BYPASSRLS), `tenantId` A MANO en cada where. Ver lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { mpConnectMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getParticularCopagoCents, getPractitionerPriceCentsInTx, resolveBookingCopagoCents } from "@/lib/billing-internal";
import type { PaymentPolicyInput } from "@/lib/booking-payment-policy-types";
import type { MpAccountKind } from "@/lib/online-payments-types";
import type { PublicClinicOnlinePayment } from "@/lib/public-booking-types";
import { mpCreatePreference, mpExpirePreference, type MpAccountRef } from "@/lib/mp-connect/account-client";
import { buildChargePreference, connectNotificationUrl } from "@/lib/mp-connect/preference";
import { mpAppUrl } from "@/lib/mp-connect/http";

/**
 * Cobro online del turnero público (T5, C-TP8 del plan §25.5): contexto, copago y cobro TURNERO. Sin Actor
 * (`prismaService` y `tenantId` a mano, como el resto del turnero).
 *
 *   - `loadPublicChargeContext`: con modo `off` o política OFF no hace más lecturas; cuenta = la del profesional ACTIVE →
 *     la del consultorio con `useClinicAccount`; **nunca la de la plataforma** (H-TP1: el checkout de TP-0 cobraba con
 *     `MP_ACCESS_TOKEN`, la cuenta de la plataforma, y la plata de un turno caía en la cuenta equivocada).
 *   - `resolvePublicCopagoCents`: mismos insumos que `lib/bookings.ts:1917-1937` (paridad con la agenda, AUDIT §5.5); con
 *     contacto distinto → particular (TP-D22).
 *   - el cobro nace EN LA MISMA tx que `booking.create` (`idempotencyKey = turnero:<bookingId>`) y la preferencia se crea
 *     después del commit con CAS (`preferenceId IS NULL AND status = ACTIVE`): llamar a MP con la tx abierta retendría
 *     los locks de cupo y de hora hasta 8 s (timeout de `mpFetch`) y frenaría a la agenda.
 *   - `releaseOwnExpiredPublicHold` vence su cobro en la misma tx (`expireOwnHoldChargeInTx`).
 */

export type PublicChargeContext = {
  connectMode: "off" | "fake" | "sandbox" | "live";
  policy: PaymentPolicyInput | null;
  account: { id: string; kind: MpAccountKind; webhookRef: string } | null;
};

const POLICY_SELECT = {
  mode: true,
  chargeKind: true,
  fixedCents: true,
  percentBps: true,
  useClinicAccount: true,
  cancellationNote: true,
} satisfies Prisma.BookingPaymentPolicySelect;

/** Política del consultorio, o null si no hay fila o está en OFF (= sin cobro: 0 lecturas más). */
async function readActivePolicy(tenantId: string): Promise<PaymentPolicyInput | null> {
  const p = await prisma.bookingPaymentPolicy.findUnique({ where: { tenantId }, select: POLICY_SELECT });
  if (!p || p.mode === "OFF") return null;
  return p;
}

/**
 * Cuentas que pueden cobrar turnos del consultorio: ACTIVE (REAUTH_REQUIRED no puede crear preferencias y una
 * DISCONNECTED no tiene credencial). Una sola sentencia para el profesional y la del consultorio.
 */
async function liveAccounts(tenantId: string, o: { practitionerIds: string[] | null; clinic: boolean }) {
  const or: Prisma.MpAccountWhereInput[] = [
    { kind: "PRACTITIONER", ...(o.practitionerIds ? { practitionerId: { in: o.practitionerIds } } : {}) },
  ];
  if (o.clinic) or.push({ kind: "CLINIC" });
  return prisma.mpAccount.findMany({
    where: { tenantId, status: "ACTIVE", OR: or },
    select: { id: true, kind: true, webhookRef: true, practitionerId: true },
  });
}

export async function loadPublicChargeContext(tenantId: string, practitionerId: string): Promise<PublicChargeContext> {
  const connectMode = mpConnectMode();
  if (connectMode === "off") return { connectMode, policy: null, account: null };
  const policy = await readActivePolicy(tenantId);
  if (!policy) return { connectMode, policy: null, account: null };
  const rows = await liveAccounts(tenantId, { practitionerIds: [practitionerId], clinic: policy.useClinicAccount });
  // La propia primero: la plata del turno es de quien atiende; la del consultorio solo si él no tiene y el titular lo
  // eligió (`useClinicAccount`).
  const own = rows.find((a) => a.kind === "PRACTITIONER" && a.practitionerId === practitionerId);
  const clinic = policy.useClinicAccount ? rows.find((a) => a.kind === "CLINIC") : undefined;
  const pick = own ?? clinic ?? null;
  return {
    connectMode,
    policy,
    account: pick ? { id: pick.id, kind: pick.kind, webhookRef: pick.webhookRef } : null,
  };
}

/**
 * `PublicClinic.onlinePayment` (C-TP8): la política y QUIÉNES cobran online (cuenta propia ACTIVE, o todos con la del
 * consultorio si `useClinicAccount`). null = el wizard no ofrece pagar (modo off, política OFF o nadie con cuenta
 * usable). Nunca trae nada de la cuenta (es público).
 */
export async function loadPublicOnlinePayment(
  tenantId: string,
  practitionerIds: string[]
): Promise<PublicClinicOnlinePayment | null> {
  if (mpConnectMode() === "off" || practitionerIds.length === 0) return null;
  const policy = await readActivePolicy(tenantId);
  if (!policy) return null;
  const rows = await liveAccounts(tenantId, { practitionerIds, clinic: policy.useClinicAccount });
  const clinic = policy.useClinicAccount && rows.some((a) => a.kind === "CLINIC");
  const own = new Set(rows.filter((a) => a.kind === "PRACTITIONER").map((a) => a.practitionerId));
  const charging = practitionerIds.filter((id) => clinic || own.has(id));
  if (charging.length === 0) return null;
  return {
    mode: policy.mode as "OPTIONAL" | "REQUIRED",
    chargeKind: policy.chargeKind,
    fixedCents: policy.fixedCents,
    percentBps: policy.percentBps,
    cancellationNote: policy.cancellationNote,
    practitionerIds: charging,
  };
}

/**
 * Copago del turno que se va a cobrar online, con la MISMA precedencia que la agenda (`resolveBookingCopagoCents`,
 * AUDIT §5.5: turno → cobertura del paciente → obra social / precio del profesional → Particular → precio) y la misma
 * cobertura (la última por id, como `listAgendaBookings` y el congelado de `lib/bookings.ts`). El turno recién nace: no
 * tiene copago propio.
 *
 * TP-D22: si el DNI matcheó una ficha existente pero el contacto tipeado es otro, se cobra como PARTICULAR (no se lee
 * la cobertura): cobrar el copago de la ficha le revelaría a quien tipeó el DNI de otro cuál es su obra social. Como
 * particular, sí con el precio del profesional (es lo que el turnero le mostró: `particularQuoteCents`).
 *
 * CF3 PR-C2 (D-CF3-1): `practitionerId` + `serviceId` son obligatorios a propósito: el precio del profesional del par
 * entra a la escalera y suma `insurerRef.isParticular` (sin él, la fila «Particular» le ganaría al profesional y el
 * turnero cobraría distinto que la agenda). El servicio ya lo validó el que llama contra el tenant; la lectura del
 * precio filtra por `tenantId` igual.
 */
export async function resolvePublicCopagoCents(
  tx: Prisma.TransactionClient,
  o: {
    tenantId: string;
    patientId: string;
    practitionerId: string;
    serviceId: string;
    servicePriceCents: number;
    contactMismatch: boolean;
  }
): Promise<number> {
  const [coverage, particularCopago, practitionerPriceCents] = await Promise.all([
    o.contactMismatch
      ? Promise.resolve(null)
      : tx.coverage.findFirst({
          where: { patientId: o.patientId, patient: { tenantId: o.tenantId } },
          orderBy: { id: "desc" },
          select: { copagoCents: true, insurerRef: { select: { copagoCents: true, isParticular: true } } },
        }),
    getParticularCopagoCents(o.tenantId, tx),
    getPractitionerPriceCentsInTx(tx, o.tenantId, o.practitionerId, o.serviceId),
  ]);
  return resolveBookingCopagoCents({
    bookingOverride: null,
    coverageOverride: coverage?.copagoCents ?? null,
    hasCoverage: !!coverage,
    insurerCopago: coverage?.insurerRef ? coverage.insurerRef.copagoCents : null,
    particularCopago,
    servicePriceCents: o.servicePriceCents,
    practitionerPriceCents,
    insurerIsParticular: coverage?.insurerRef?.isParticular === true,
  });
}

/**
 * El cobro TURNERO, en la tx del alta del turno. Nace ACTIVE y sin preferencia (lo exige el guard de M18). El guard
 * también rechaza una cuenta que dejó de estar ACTIVE entre la lectura del contexto y este INSERT (desconectar en el
 * medio): la tx entera vuelve atrás y el submit responde el error genérico, sin turno a medias.
 * `copagoBasisCents` solo con FULL (CHECK `OnlineCharge_basis_check`): es el copago con el que se calculó, lo que el
 * webhook congela en `Booking.copagoCents` al marcar el turno pagado.
 */
export async function createTurneroChargeInTx(
  tx: Prisma.TransactionClient,
  o: {
    tenantId: string;
    bookingId: string;
    patientId: string;
    practitionerId: string;
    mpAccountId: string;
    kind: "FULL" | "DEPOSIT";
    amountCents: number;
    copagoBasisCents: number | null;
    expiresAt: Date;
  }
): Promise<{ chargeId: string }> {
  const row = await tx.onlineCharge.create({
    data: {
      tenantId: o.tenantId,
      origin: "TURNERO",
      kind: o.kind,
      mpAccountId: o.mpAccountId,
      practitionerId: o.practitionerId,
      patientId: o.patientId,
      bookingId: o.bookingId,
      amountCents: o.amountCents,
      copagoBasisCents: o.kind === "FULL" ? o.copagoBasisCents : null,
      expiresAt: o.expiresAt,
      idempotencyKey: `turnero:${o.bookingId}`,
    },
    select: { id: true },
  });
  return { chargeId: row.id };
}

/** `checkoutUrl` que acepta el CHECK `OnlineCharge_preference_check` (http(s), ≤500). Otra cosa = respuesta rota de MP. */
function storableCheckoutUrl(u: string): boolean {
  return /^https?:\/\//.test(u) && u.length <= 500;
}

/**
 * Crea (o devuelve) la preferencia del cobro con el token del VENDEDOR. Fuera de cualquier tx.
 *   - Ya tiene preferencia → la misma (`initPoint` del replay, C-TP8).
 *   - Escritura con CAS (`preferenceId IS NULL AND status = ACTIVE`): dos reintentos simultáneos crean dos preferencias
 *     en MP, pero solo una queda en el cobro y las dos llevan `oc:<id>` (un pago por cualquiera se imputa igual); la
 *     perdedora se vence best effort.
 *   - `buildChargePreference` tira ante un input inválido (bug, no caso): el cobro pasa a CANCELLED(`preference_failed`)
 *     para que no quede un cobro vivo que bloquee el cobro a mano (handoff de TP-P3).
 *   - MP caído / reauth / respuesta rota → `preference_failed` SIN tocar el cobro: el caller decide (REQUIRED reintenta
 *     con el mismo cobro, TP-D29; OPTIONAL lo anula y reserva sin cobro).
 * `mode`: REQUIRED = `binary_mode` y sin efectivo (TP-D15); OPTIONAL = sin esas restricciones (el turno ya está
 * reservado, un pago pendiente no retiene nada).
 */
export async function openTurneroPreference(o: {
  tenantId: string;
  chargeId: string;
  mode: "REQUIRED" | "OPTIONAL";
}): Promise<{ ok: true; initPoint: string } | { ok: false; error: "preference_failed" }> {
  const fail = { ok: false as const, error: "preference_failed" as const };
  const c = await prisma.onlineCharge.findFirst({
    where: { id: o.chargeId, tenantId: o.tenantId, origin: "TURNERO" },
    select: {
      id: true,
      status: true,
      amountCents: true,
      expiresAt: true,
      preferenceId: true,
      checkoutUrl: true,
      bookingId: true,
      booking: { select: { scheduledFor: true } },
      tenant: { select: { name: true } },
      mpAccount: { select: { id: true, tenantId: true, kind: true, status: true, mpUserId: true, webhookRef: true } },
    },
  });
  if (!c || !c.bookingId) return fail;
  if (c.preferenceId && c.checkoutUrl) return { ok: true, initPoint: c.checkoutUrl };
  if (c.status !== "ACTIVE" || c.mpAccount.status !== "ACTIVE") return fail;
  const account: MpAccountRef = c.mpAccount;

  const app = mpAppUrl().replace(/\/+$/, "");
  let body: ReturnType<typeof buildChargePreference>;
  try {
    body = buildChargePreference({
      charge: { id: c.id, amountCents: c.amountCents, scheduledFor: c.booking?.scheduledFor ?? null },
      tenantName: c.tenant.name,
      mode: o.mode,
      notificationUrl: connectNotificationUrl(app, account.webhookRef),
      // Las mismas páginas de resultado del turnero que el checkout legado (`/booking/<id>/ok|failed|pending`).
      backUrls: {
        success: `${app}/booking/${c.bookingId}/ok`,
        failure: `${app}/booking/${c.bookingId}/failed`,
        pending: `${app}/booking/${c.bookingId}/pending`,
      },
      expiresAt: c.expiresAt,
    });
  } catch (e) {
    logger.error("booking.public.charge_preference_invalid", {
      chargeId: c.id,
      err: e instanceof Error ? e.message : String(e),
    });
    await prisma.onlineCharge.updateMany({
      where: { id: c.id, tenantId: o.tenantId, status: "ACTIVE", preferenceId: null },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "preference_failed" },
    });
    return fail;
  }

  const created = await mpCreatePreference(account, body as unknown as Record<string, unknown>);
  if (!created.ok || !created.preferenceId || !storableCheckoutUrl(created.initPoint)) {
    logger.warn("booking.public.charge_preference_failed", {
      chargeId: c.id,
      error: created.ok ? "bad_response" : created.error,
    });
    return fail;
  }
  const preferenceId = created.preferenceId.slice(0, 100);
  const cas = await prisma.onlineCharge.updateMany({
    where: { id: c.id, tenantId: o.tenantId, status: "ACTIVE", preferenceId: null },
    data: { preferenceId, checkoutUrl: created.initPoint },
  });
  if (cas.count === 1) return { ok: true, initPoint: created.initPoint };

  // Perdimos la carrera: otro reintento ya guardó su preferencia (se devuelve esa) o el cobro dejó de estar vivo.
  const now = await prisma.onlineCharge.findFirst({
    where: { id: c.id, tenantId: o.tenantId },
    select: { preferenceId: true, checkoutUrl: true, status: true },
  });
  if (now?.preferenceId !== preferenceId) {
    const expired = await mpExpirePreference(account, preferenceId);
    if (!expired.ok) logger.warn("booking.public.charge_orphan_preference", { chargeId: c.id, error: expired.error });
  }
  if (now?.preferenceId && now.checkoutUrl && now.status === "ACTIVE") return { ok: true, initPoint: now.checkoutUrl };
  return fail;
}

/**
 * OPTIONAL con MP caído: el «Pagar ahora» no se pudo abrir y el turno queda reservado sin cobro online. El cobro se anula
 * (`preference_failed`) para que no quede vivo: un cobro TURNERO ACTIVE bloquea el link de pago y el cobro a mano
 * («Hay un pago en proceso»). CAS sobre ACTIVE sin preferencia: si en el medio otro reintento la creó, no se toca.
 */
export async function cancelTurneroChargeWithoutPreference(o: { tenantId: string; chargeId: string }): Promise<{ cancelled: boolean }> {
  const res = await prisma.onlineCharge.updateMany({
    where: { id: o.chargeId, tenantId: o.tenantId, origin: "TURNERO", status: "ACTIVE", preferenceId: null },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "preference_failed" },
  });
  return { cancelled: res.count === 1 };
}

/**
 * La reserva vencida que `releaseOwnExpiredPublicHold` cancela se lleva su cobro: ACTIVE → EXPIRED en la misma tx. La
 * preferencia ya venció en MP con el hold (`expiration_date_to`); si igual llega un pago, el webhook lo registra como
 * «reserva vencida» (EXPIRED → PAID, TP-D24). Un cobro AUTHORIZED/PAID no llega acá: el caller no libera ese turno.
 */
export async function expireOwnHoldChargeInTx(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; bookingId: string }
): Promise<{ expired: boolean }> {
  const res = await tx.onlineCharge.updateMany({
    where: { tenantId: o.tenantId, bookingId: o.bookingId, origin: "TURNERO", status: "ACTIVE" },
    data: { status: "EXPIRED" },
  });
  return { expired: res.count > 0 };
}
