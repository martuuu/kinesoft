"use server";

/**
 * Public booking — server actions used by the unauthenticated turnero
 * at `/c/[slug]/booking`. Everything reachable from a stranger lives
 * here, with explicit tenant resolution by slug (no actor context).
 *
 * Security model:
 *   - All inputs are rate-limited (per IP).
 *   - Switch del turnero (EV0, `Tenant.publicBookingEnabled`, opt-in) Y acceso
 *     del consultorio (BO2-D, `publicSurfacesOpen`: suspendido/baja cierran): cerrado,
 *     `getPublicClinic`/`listPublicSlots`/`findFirstPublicSlot` responden como
 *     un slug inexistente y `submitPublicBooking` rechaza antes de escribir.
 *     `getPublicBookingStatus` NO se gatea (turnos ya reservados, retorno de MP).
 *   - `submitPublicBooking` NEVER writes to an existing Patient row (H4):
 *     it matches by normalized DNI and puts a differing contact on the
 *     booking snapshot (`guest*`) for the kine to review.
 *   - `getPublicBookingStatus` returns only initials + non-PHI fields
 *     even though the booking id is a 25-char CUID.
 *   - The PII prefill lookup (`findPatientByEmail`) is NOT exported from
 *     this file — it lives in `lib/public-booking-internal.ts` and is
 *     only callable from a server context that has already validated a
 *     Supabase session.
 */
import { headers } from "next/headers";
// No-Actor surface (anonymous turnero) → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { NotificationKind, Prisma } from "@prisma/client";
import { prismaService as prisma } from "@/lib/db";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import {
  publicOnlineChargeView,
  publicStatusAmountCents,
  turneroChargeExpiresAt,
  turneroReplayStep,
} from "@/lib/public-booking-payment";
import { decideOnlineCharge, type OnlineChargeDecision } from "@/lib/online-charge-logic";
import {
  cancelTurneroChargeWithoutPreference,
  createTurneroChargeInTx,
  loadPublicChargeContext,
  loadPublicOnlinePayment,
  openTurneroPreference,
  resolvePublicCopagoCents,
} from "@/lib/public-booking-charge-internal";
import { isHoldingCapacity } from "@/lib/booking-capacity";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
import { logger } from "@/lib/logger";
import { getParticularCopagoCents } from "@/lib/billing-internal";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { toARDateKey } from "@/lib/datetime-ar";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { capacityKeysForWindow, hourKeyForStart, lockAgendaKeysMany } from "@/lib/booking-cap-lock";
import { lockActiveRoomInTx } from "@/lib/booking-rooms-internal";
import { defaultRoomFor } from "@/lib/availability/rooms";
import { acceptsInsurer, addDays, eligiblePractitioners, isDayKey, resolvePractitionerService } from "@/lib/availability";
import {
  PUBLIC_FIRST_FREE_HORIZON_DAYS,
  PUBLIC_MAX_AHEAD_DAYS,
  PUBLIC_WINDOW_SCAN_DAYS,
  checkPublicSlot,
  firstPublicSlotAcross,
  publicDaySlots,
  publicSlotWindow,
  resolvePublicOffer,
} from "@/lib/public-booking-slots";
import {
  PUBLIC_BOOKING_SWITCH_SELECT,
  PUBLIC_PARTICULAR_CHARGE_NOTE,
  isPublicTurneroOpen,
  promoteHeldPublicBookingInTx,
  releaseOwnExpiredPublicHold,
  resolvePublicPatient,
  turneroWhatsAppActive,
} from "@/lib/public-booking-internal";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import type { ActionResult } from "@/lib/validation";
import { publicPractitionerName } from "@/lib/display-name";
import { publicOpeningRanges, summarizeOpeningHours } from "@/lib/opening-hours-summary";
import {
  FirstPublicSlotSchema,
  ListPublicSlotWindowSchema,
  ListPublicSlotsSchema,
  SubmitSchema,
  normalizeDocumentId,
  type FirstPublicSlotInput,
  type ListPublicSlotWindowInput,
  type ListPublicSlotsInput,
  type PublicClinic,
  type PublicFirstSlot,
  type PublicSlot,
  type PublicSlotWindow,
  type PublicBookingStatus,
  type SubmitPublicBookingInput,
  type SubmitPublicBookingResult,
  type TurneroWaConsentOutcome,
} from "@/lib/public-booking-types";
import { decideTurneroWaConsent, turneroConsentFitsFicha } from "@/lib/public-booking-wa-consent";

function callerIp(): string {
  const h = headers();
  return clientIp(h);
}

// ──────────────────────────────────────────────────────────────────────
// Public reads
// ──────────────────────────────────────────────────────────────────────

/**
 * Profesionales que el público puede ver/reservar: membresía ACEPTADA (mismo
 * criterio que `listPractitioners` y el loader). Antes `getPublicClinic`
 * listaba toda fila Practitioner, incluso la de un miembro dado de baja
 * (`removeMember` deja la fila por historial) y se le podía reservar.
 */
function publicPractitionerWhere(tenantId: string) {
  // IAM-2e: + rol clínico y sin suspender. La Secretaria y Facturación tienen
  // fila Practitioner (hasta IAM-4) y se les podía reservar desde el turnero.
  // PL-2f (§20.5.12, H-TURN, decisión 20 de Martin): + el switch POR PROFESIONAL
  // (`Practitioner.publicBookingEnabled`, opt-in). El del consultorio ya lo
  // miran los callers (`isPublicTurneroOpen`); este se suma en el MISMO where,
  // así que `getPublicClinic`, `listPublicSlots` (`resolvePublicTarget`) y el
  // submit lo aplican sin sentencias nuevas: un profesional apagado no aparece,
  // no tiene horarios y un submit armado a mano con su id se rechaza antes de
  // escribir (ni ficha ni turno).
  return { ...bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }), publicBookingEnabled: true };
}

/**
 * Datos del wizard público. Desde B3.2 solo lo que se ofrece ONLINE (motor de
 * disponibilidad, `eligiblePractitioners` con `publicOnly`):
 *   • servicios que al menos un profesional tiene habilitados y PUBLIC
 *     (`PractitionerService`; sin fila = default de Configuración);
 *   • profesionales con membresía aceptada que ofrecen al menos uno;
 *   • nuevos opcionales para B5.6: sedes activas, coberturas activas (sin
 *     montos), sedes y coberturas aceptadas por profesional, quién ofrece cada
 *     servicio y con qué duración. Ver `PublicClinic` (public-booking-types).
 */
export async function getPublicClinic(slug: string): Promise<PublicClinic | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      legalName: true,
      palette: true,
      // VX2-d1: red de seguridad del horario resumido (profesional sin franjas = horario del consultorio).
      businessHoursStart: true,
      businessHoursEnd: true,
      ...PUBLIC_BOOKING_SWITCH_SELECT,
    },
  });
  // Turnero apagado (EV0, EV-D2 opt-in) = mismo resultado que un slug que no
  // existe: el wizard no recibe profesionales, servicios ni sedes. La página
  // distingue los dos casos con `getPublicBookingGate` (cerrado ≠ 404).
  if (!tenant || !isPublicTurneroOpen(tenant)) return null;
  const tenantId = tenant.id;

  const [practitioners, services, psRows, insurers, ppRows, locations, schedules] = await Promise.all([
    prisma.practitioner.findMany({
      where: publicPractitionerWhere(tenantId),
      // DIR-0: sin `email`; el nombre público nunca cae al email (`publicPractitionerName`).
      include: { user: { select: { fullName: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.service.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.practitionerService.findMany({
      where: { tenantId },
      select: {
        practitionerId: true,
        serviceId: true,
        enabled: true,
        visibility: true,
        durationMin: true,
        minLeadMinutes: true,
        maxLeadDays: true,
        concurrencyOverride: true,
        maxConcurrent: true,
      },
    }),
    prisma.insurer.findMany({
      where: { tenantId, active: true },
      select: { id: true, name: true, isParticular: true },
      orderBy: [{ isParticular: "desc" }, { name: "asc" }],
    }),
    prisma.practitionerPayer.findMany({
      where: { tenantId },
      select: { practitionerId: true, insurerId: true, active: true },
    }),
    prisma.location.findMany({
      where: { tenantId, active: true },
      select: {
        id: true,
        name: true,
        address: true,
        addressLine2: true,
        city: true,
        province: true,
        isPrimary: true,
      },
      orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    }),
    // VX2-d1: TODAS las franjas (también de sedes inactivas y con cualquier vigencia), como el motor
    // (`availability-loader`): «tiene alguna franja» decide si cae a la red de seguridad. Las sedes del
    // profesional (`locationIds`) siguen saliendo solo de las activas.
    prisma.practitionerSchedule.findMany({
      where: { tenantId },
      select: {
        practitionerId: true,
        locationId: true,
        dow: true,
        startMin: true,
        endMin: true,
        validFrom: true,
        validUntil: true,
        location: { select: { active: true } },
      },
    }),
  ]);

  const pracIds = practitioners.map((p) => p.id);
  const serviceInfos = services.map((s) => ({
    id: s.id,
    durationMin: s.durationMin,
    maxConcurrent: s.maxConcurrent,
    practitionerId: s.practitionerId,
  }));

  const offered = services
    .map((s, i) => {
      const offeredBy = eligiblePractitioners({
        practitionerIds: pracIds,
        serviceId: s.id,
        practitionerServices: psRows,
        services: serviceInfos,
        publicOnly: true,
      });
      const durationByPractitioner: Record<string, number> = {};
      for (const pid of offeredBy) {
        const rule = psRows.find((r) => r.practitionerId === pid && r.serviceId === s.id);
        durationByPractitioner[pid] = resolvePractitionerService(rule, serviceInfos[i], pid).durationMin;
      }
      return { s, offeredBy, durationByPractitioner };
    })
    .filter((o) => o.offeredBy.length > 0);

  const offering = new Set(offered.flatMap((o) => o.offeredBy));
  // T5 (C-TP8): cobro online con la cuenta del vendedor. Con `MP_CONNECT_MODE=off` o la política en OFF no lee más.
  // WA-S8: la casilla de WhatsApp, en paralelo; con `WHATSAPP_MODE=off` no lee nada (y con la cuenta cacheada, nada
  // en caliente).
  const [policyPayment, whatsappNotices] = await Promise.all([
    loadPublicOnlinePayment(
      tenantId,
      pracIds.filter((id) => offering.has(id))
    ),
    turneroWhatsAppActive(tenantId),
  ]);
  // PEND-a (enmienda C-TP8): el copago de Particular, para que el wizard cotice lo que el server va a cobrar a un
  // paciente sin obra social (antes cotizaba el precio del servicio, hallazgo «particular-en-cero-cotiza» de T5-Z).
  // Solo con el cobro online prendido: con modo `off` o la política OFF `policyPayment` es null y no se lee nada.
  // Serial a propósito: en paralelo con `loadPublicOnlinePayment` sería una lectura más en TODO turnero sin cobro,
  // para ahorrar un viaje solo en los que cobran. Misma lectura que el submit (`getParticularCopagoCents`, AUDIT §5.5):
  // la fila Particular aunque esté inactiva, igual que `resolvePublicCopagoCents`.
  const onlinePayment = policyPayment && {
    ...policyPayment,
    particularCopagoCents: await getParticularCopagoCents(tenantId, prisma),
  };
  const primary = locations.find((l) => l.isPrimary) ?? null;
  const locationOrder = locations.map((l) => l.id);
  // VX2-d1: el nav del turnero decía «lun-sáb 8 a 19hs» fijo. Ahora sale de las franjas de los profesionales
  // que el turnero ofrece (null = no se muestra). Reloj: hoy AR adentro de `summarizeOpeningHours`.
  const openingSummary = summarizeOpeningHours(
    publicOpeningRanges({
      practitionerIds: pracIds.filter((id) => offering.has(id)),
      rows: schedules.map((r) => ({ ...r, locationActive: r.location.active })),
      tenant,
    }),
    new Date()
  );

  return {
    slug: tenant.slug,
    name: tenant.name,
    legalName: tenant.legalName,
    palette: tenant.palette,
    // EV1-C2: ya viene en PUBLIC_BOOKING_SWITCH_SELECT; el wizard la usa para el copy.
    vertical: tenant.vertical,
    openingSummary,
    practitioners: practitioners
      .filter((p) => offering.has(p.id))
      .map((p) => {
        const own = new Set(
          schedules.filter((r) => r.practitionerId === p.id && r.location.active).map((r) => r.locationId)
        );
        // Sin franjas = red de seguridad del motor (horario del tenant en la principal).
        const locationIds = own.size > 0 ? locationOrder.filter((id) => own.has(id)) : primary ? [primary.id] : [];
        return {
          id: p.id,
          name: publicPractitionerName(p.user.fullName),
          specialty: p.specialty,
          licenseNumber: p.licenseNumber,
          yearsExp: p.yearsExp,
          locationIds,
          acceptedInsurerIds: insurers
            .filter((ins) => ins.isParticular || acceptsInsurer(ppRows, p.id, ins.id))
            .map((ins) => ins.id),
        };
      }),
    services: offered.map(({ s, offeredBy, durationByPractitioner }) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      durationMin: offeredBy.length === 1 ? durationByPractitioner[offeredBy[0]] : s.durationMin,
      priceCents: s.priceCents,
      // Compat con el filtro del wizard actual (ver `PublicClinic.services`).
      practitionerId: offeredBy.length === 1 ? offeredBy[0] : null,
      practitionerIds: offeredBy,
      durationByPractitioner,
    })),
    locations,
    insurers,
    // Solo el copy del wizard (cotiza con `quoteOnlineCharge` sobre `particularCopagoCents`); cada submit lo decide
    // `decideOnlineCharge` con el copago real.
    onlinePayment,
    whatsappNotices,
  };
}

/**
 * Tenant por slug + profesional con membresía aceptada (o null). Con el
 * turnero apagado también null (EV0): cubre `listPublicSlots` y
 * `findFirstPublicSlot`, que si no seguían exponiendo la densidad de agenda de
 * un consultorio que no toma turnos online.
 */
async function resolvePublicTarget(tenantSlug: string, practitionerId: string | null) {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, ...PUBLIC_BOOKING_SWITCH_SELECT },
  });
  if (!tenant || !isPublicTurneroOpen(tenant)) return null;
  if (practitionerId) {
    const p = await prisma.practitioner.findFirst({
      where: { id: practitionerId, ...publicPractitionerWhere(tenant.id) },
      select: { id: true },
    });
    if (!p) return null;
  }
  return tenant;
}

/**
 * Horarios de un día AR para (profesional, servicio[, sede]). Motor de B3.2:
 * franjas del profesional, excepciones, bloqueos (duros), PractitionerService
 * (solo habilitado + PUBLIC; duración, cupo, anticipación y horizonte propios).
 * Misma función que valida el submit (`publicDaySlots`).
 */
export async function listPublicSlots(raw: ListPublicSlotsInput): Promise<PublicSlot[]> {
  // Rate-limit slot polling so an attacker can't enumerate booking density.
  const rl = await rateLimit(`pub:slots:${callerIp()}`, {
    limit: 60,
    windowMs: 60_000,
  });
  // Signal the throttle distinctly instead of returning [] — otherwise the
  // wizard renders "no atiende este día" when the real cause is "esperá un
  // momento". Leaks no agenda density (no per-slot info in the message).
  if (!rl.ok) throw new Error("RATE_LIMITED");

  const parsed = ListPublicSlotsSchema.safeParse(raw);
  if (!parsed.success || !isDayKey(parsed.data.date)) return [];
  const input = parsed.data;

  const tenant = await resolvePublicTarget(input.tenantSlug, input.practitionerId);
  if (!tenant) return [];

  // Día anclado a la pared AR (no al host: en Vercel es UTC). Ids ajenos al
  // tenant (servicio, sede) el loader los descarta → lista vacía.
  const availability = await loadAvailabilityInputs(prisma, {
    tenantId: tenant.id,
    practitionerIds: [input.practitionerId],
    serviceId: input.serviceId,
    locationId: input.locationId,
    from: input.date,
    to: input.date,
  });
  return publicDaySlots(availability, {
    practitionerId: input.practitionerId,
    serviceId: input.serviceId,
    dayKey: input.date,
    locationId: input.locationId ?? null,
    now: new Date(),
  });
}

/**
 * TP-1 (plan §22.5, TP-D2): los 5 días HÁBILES del profesional desde `from` (default hoy AR), con solo sus horarios
 * libres y «Completo» para los hábiles sin lugar; si los 5 están completos, avanza sola (`skippedFrom`). Reemplaza en
 * el wizard a `listPublicSlots` día por día (que queda como legado).
 *
 * Costo: UN hit de rate limit (mismo bucket `pub:slots:<ip>` que la lista: es la misma lectura de densidad de agenda)
 * y UNA carga del loader sobre `[from, min(from + 41, hoy + 90)]`: el loader hace las mismas queries para un día que
 * para 42 (el rango solo cambia los `where`), y el recorrido de días es puro (`publicSlotWindow`). Antes el wizard
 * pagaba un request + ~14 queries por cada día que el paciente miraba.
 *
 * Mismas compuertas que `listPublicSlots` (turnero del consultorio abierto, profesional público con
 * `resolvePublicTarget`, servicio ofrecido online por el motor) y misma grilla que valida el submit. Input inválido,
 * consultorio cerrado o servicio ajeno → ventana vacía (como el `[]` de la lista); el throttle tira `RATE_LIMITED`.
 */
export async function listPublicSlotWindow(raw: ListPublicSlotWindowInput): Promise<PublicSlotWindow> {
  const rl = await rateLimit(`pub:slots:${callerIp()}`, { limit: 60, windowMs: 60_000 });
  if (!rl.ok) throw new Error("RATE_LIMITED");

  const empty: PublicSlotWindow = { days: [], nextFrom: null, reachedEnd: true, skippedFrom: null };
  const parsed = ListPublicSlotWindowSchema.safeParse(raw);
  if (!parsed.success || (parsed.data.from != null && !isDayKey(parsed.data.from))) return empty;
  const input = parsed.data;

  // Hoy AR (no el del host: en Vercel es UTC y un sábado 22:30 ya sería domingo). Un `from` pasado arranca hoy.
  const now = new Date();
  const today = toARDateKey(now);
  const fromDay = input.from && input.from > today ? input.from : today;
  const maxDay = addDays(today, PUBLIC_MAX_AHEAD_DAYS);
  if (fromDay > maxDay) return empty;
  const scanEnd = addDays(fromDay, PUBLIC_WINDOW_SCAN_DAYS - 1);
  const lastDay = scanEnd < maxDay ? scanEnd : maxDay;

  const tenant = await resolvePublicTarget(input.tenantSlug, input.practitionerId);
  if (!tenant) return empty;

  const availability = await loadAvailabilityInputs(prisma, {
    tenantId: tenant.id,
    practitionerIds: [input.practitionerId],
    serviceId: input.serviceId,
    locationId: input.locationId,
    from: fromDay,
    to: lastDay,
  });
  return publicSlotWindow(availability, {
    practitionerId: input.practitionerId,
    serviceId: input.serviceId,
    fromDay,
    lastDay,
    locationId: input.locationId ?? null,
    now,
  });
}

/**
 * "Cualquier profesional" (B3.2): el primer horario libre de la grilla
 * pública entre quienes ofrecen el servicio online (y aceptan la cobertura,
 * si viene), desde `fromDate` (default hoy AR) por
 * `PUBLIC_FIRST_FREE_HORIZON_DAYS` días. null = nadie tiene lugar (o el
 * servicio/cobertura no es del consultorio). El wizard actual NO la usa; es
 * para B5.6. Lo devuelto se reserva con `submitPublicBooking` usando el
 * `practitionerId` y el `iso` (mismo motor: no puede salir "off-grid").
 */
export async function findFirstPublicSlot(raw: FirstPublicSlotInput): Promise<PublicFirstSlot | null> {
  // Mismo bucket que la lista: es otra forma de leer densidad de agenda.
  const rl = await rateLimit(`pub:slots:${callerIp()}`, { limit: 60, windowMs: 60_000 });
  if (!rl.ok) throw new Error("RATE_LIMITED");

  const parsed = FirstPublicSlotSchema.safeParse(raw);
  if (!parsed.success) return null;
  const input = parsed.data;
  const now = new Date();
  const today = toARDateKey(now);
  const fromDay = input.fromDate && isDayKey(input.fromDate) && input.fromDate > today ? input.fromDate : today;

  const tenant = await resolvePublicTarget(input.tenantSlug, null);
  if (!tenant) return null;
  if (input.insurerId) {
    // Una cobertura ajena/inactiva no filtra nada en el motor (sin fila =
    // aceptada): mejor no ofrecer que ofrecer a quien no la acepta.
    const ins = await prisma.insurer.findFirst({
      where: { id: input.insurerId, tenantId: tenant.id, active: true },
      select: { id: true },
    });
    if (!ins) return null;
  }

  // Sin `practitionerIds`: el loader trae los reservables; PL-2f: solo los
  // prendidos en el turnero (`publicBookingOnly`, mismo where que `publicPractitionerWhere`).
  const availability = await loadAvailabilityInputs(prisma, {
    tenantId: tenant.id,
    publicBookingOnly: true,
    serviceId: input.serviceId,
    locationId: input.locationId,
    from: fromDay,
    to: addDays(fromDay, PUBLIC_FIRST_FREE_HORIZON_DAYS - 1),
  });
  return firstPublicSlotAcross(availability, {
    serviceId: input.serviceId,
    practitionerIds: availability.templates.map((t) => t.practitionerId),
    insurerId: input.insurerId ?? null,
    locationId: input.locationId ?? null,
    fromDay,
    now,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Submit booking
// ──────────────────────────────────────────────────────────────────────

const PUBLIC_BOOKING_CLOSED_ERROR = "Este consultorio no toma turnos online.";
const SLOT_UNAVAILABLE_ERROR ="Ese horario se acaba de ocupar o ya no se puede reservar online. Elegí otro.";
const SLOT_OFF_GRID_ERROR = "Ese horario no está disponible para reservar online. Elegí otro.";
/**
 * T3 (AS-D9 / C-AS3): los rechazos «el horario ya no es reservable» llevan `fieldErrors.scheduledFor` además del copy,
 * para que el wizard los distinga sin comparar textos y vuelva a pedir la ventana. Casos: el paso de la grilla cambió
 * con el deploy (un asistente abierto con la grilla de 45 manda un 10:45 que en la de 30 es off-grid), se llenó el
 * tope por intervalo o el cupo, o un bloqueo/sede nuevo sacó el horario. El copy no cambia.
 */
const slotGone = (error: string) => ({ ok: false as const, error, fieldErrors: { scheduledFor: [error] } });
const SAME_SLOT_ERROR = "Ya tenés un turno reservado en ese horario.";
const GENERIC_SUBMIT_ERROR = "No pudimos registrar la reserva. Probá de nuevo en unos minutos.";
const CANCELLED_REPLAY_ERROR = "Ese turno fue cancelado. Recargá la página para reservar de nuevo.";
/** TP-0: el reintento de un PENDING cuyo plazo de 30 min ya pasó (el cupo se pudo dar a otro). */
const HOLD_EXPIRED_ERROR = "Tu reserva venció. Volvé a elegir el horario.";
/** TP-0: hay un pago AUTHORIZED en curso sobre ese turno; lo resuelve el webhook, no un reintento del wizard. */
const PAYMENT_IN_FLIGHT_ERROR = "Ya hay un pago en proceso para este turno. Esperá la confirmación de Mercado Pago.";
/** T5 (§25.5, TP-D29): REQUIRED con MP caído. El turno queda PENDING con su cobro; el reintento usa el mismo cobro. */
const PAYMENT_UNAVAILABLE_ERROR = "No pudimos abrir Mercado Pago. Probá de nuevo en unos minutos.";

/**
 * TP-0 (H-TP3): una reserva online sin cobro no le avisaba a nadie (el único aviso era el del webhook al acreditar).
 * Al titular/administradores, al profesional del turno y a quien opera la agenda (la Secretaria). Lo llama el caller
 * UNA vez, después del commit que dejó el turno CONFIRMED (alta o promoción con count 1), nunca en un replay.
 */
async function notifyPublicReservation(
  tenantId: string,
  b: { practitionerId: string; scheduledFor: Date; serviceName: string; who: string }
) {
  await notifyTenantOwners({
    tenantId,
    kind: NotificationKind.BOOKING_CREATED,
    title: "Turno online reservado",
    body: `${b.serviceName} · ${b.who} · ${b.scheduledFor.toLocaleString("es-AR", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "America/Argentina/Buenos_Aires",
    })}`,
    link: `/agenda?date=${toARDateKey(b.scheduledFor)}`,
    alsoPractitionerId: b.practitionerId,
    alsoAgendaOperators: true,
  });
}

/** La sede de la franja se archivó entre la validación y el INSERT (B3.2). */
class PublicLocationGoneError extends Error {}
/** El slot se ocupó (o se bloqueó) entre la lista/pre-chequeo y el INSERT (B4.1). */
class PublicSlotGoneError extends Error {}

/**
 * Crea (o reencuentra, si es un reintento) el turno público y, si corresponde, su
 * cobro online con la cuenta de Mercado Pago del profesional.
 *
 *   - Idempotencia: key POR INSTANCIA del wizard (UUID del cliente), con
 *     prefijo `pub:<tenant>:` para que nunca choque con una key de la agenda
 *     ni de otro tenant. Mismo intento (doble click, reintento tras un error
 *     de MP) → el mismo turno. Un turno CANCELLED nunca se revive: una reserva
 *     nueva trae otra key y crea otro turno.
 *   - Horario (B3.2, motor de disponibilidad): tiene que ser un slot de
 *     `publicDaySlots`, la MISMA grilla que lista el wizard: franjas del
 *     profesional (o el horario del tenant si no tiene), excepción del día,
 *     bloqueos duros (un slot bloqueado no se ofrece ni se acepta),
 *     anticipación `minLeadMinutes ?? 60`, tope `maxLeadDays` y cupo
 *     profesional + servicio contando solo lo que sigue reteniendo
 *     (`isHoldingCapacity`). Solo servicios habilitados y PUBLIC para ese
 *     profesional; la duración es la de su PractitionerService. T3: paso
 *     `publicSlotStepFor(duración)` (AS-D9) y tope «N turnos cada X min» del
 *     profesional DURO (un intervalo lleno no se ofrece ni se acepta, C-AS3).
 *   - Sede: la de la franja del slot (el cliente no la elige ni la manda);
 *     se valida activa bajo el lock compartido de sedes dentro de la tx.
 *   - Re-reserva del propio slot vencido: si el paciente ya tenía en ese
 *     instante SU reserva pública impaga vencida, se cancela y se crea la nueva
 *     en la misma tx (`releaseOwnExpiredPublicHold`, revisión A2).
 *   - Ficha: `resolvePublicPatient` (H4): match por DNI normalizado, nunca
 *     parchea una ficha existente; el contacto distinto va al snapshot
 *     `guest*` del turno + nota para el kine.
 *   - Cobro online (T5, C-TP8; antes TP-0 con la cuenta de la plataforma, H-TP1): `decideOnlineCharge`
 *     (lib/online-charge-logic.ts) con la política del consultorio, `MP_CONNECT_MODE`, la cuenta del profesional (o
 *     la del consultorio con `useClinicAccount`), el «Pagar ahora» del paciente y el copago resuelto como la agenda.
 *       · sin cobro (OFF, modo off, sin cuenta, < $1, OPTIONAL sin «Pagar ahora») → CONFIRMED/UNPAID, `reserved`;
 *       · REQUIRED → PENDING (hold de 30 min) + cobro ACTIVE en la misma tx + preferencia después del commit →
 *         `checkout`; MP caído → error y el reintento usa el MISMO cobro (TP-D29: no se degrada);
 *       · OPTIONAL «Pagar ahora» → CONFIRMED + cobro → `checkout`; MP caído → reservado sin cobro +
 *         `notice: "payment-unavailable"`.
 *     `TURNERO_CHECKOUT`/`MP_ACCESS_TOKEN` ya no se leen: la cuenta de la plataforma no cobra turnos.
 *   - Replay (misma key) o gemelo del P2002: `turneroReplayStep` por la fila; el mismo `initPoint` si ya hay
 *     preferencia; nunca otro turno ni otro cobro. PENDING SIN cobro de T5 (checkout legado o anterior a TP-0) → la
 *     promoción de TP-0 (`promoteHeldPublicBookingInTx`), que no toca un PENDING con cobro vivo.
 *   - Aviso `BOOKING_CREATED` (H-TP3) una vez, después del commit que lo dejó CONFIRMED; nunca en replay. Un REQUIRED
 *     lo avisa el webhook al confirmarse con el pago.
 */
export async function submitPublicBooking(
  raw: SubmitPublicBookingInput
): Promise<ActionResult<SubmitPublicBookingResult>> {
  // Aggressive rate limit — a single visitor submitting twice in a few
  // seconds is almost always a bot.
  const ip = callerIp();
  const rl = await rateLimit(`pub:submit:${ip}`, {
    limit: 5,
    windowMs: 5 * 60_000,
  });
  if (!rl.ok) {
    return { ok: false, error: "Demasiados intentos. Probá de nuevo en unos minutos." };
  }

  const parsed = SubmitSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  if (normalizeDocumentId(data.patient.documentId).length < 4) {
    return { ok: false, error: "Datos inválidos", fieldErrors: { documentId: ["DNI inválido"] } };
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: data.tenantSlug } });
  if (!tenant) return { ok: false, error: "Centro no encontrado." };
  // Turnero apagado (EV0): se corta ACÁ, antes del replay idempotente (que
  // armaría una preferencia nueva de MP sobre un turno viejo) y antes de
  // `resolvePublicPatient` (que crea fichas). Un request armado a mano contra
  // un consultorio cerrado no deja nada escrito. El estado de un turno ya
  // reservado (`getPublicBookingStatus`) y el webhook de MP no se gatean.
  // BO2-D: también con el consultorio suspendido / dado de baja (o en solo lectura con `enforce`): mismo corte,
  // mismo lugar, mismo copy.
  if (!isPublicTurneroOpen(tenant)) return { ok: false, error: PUBLIC_BOOKING_CLOSED_ERROR };

  const service = await prisma.service.findFirst({
    where: { id: data.serviceId, tenantId: tenant.id },
  });
  // Si ESTE profesional lo ofrece online lo decide el motor más abajo
  // (`resolvePublicOffer`): reemplaza el viejo "servicio atado a otro
  // profesional", que no veía PractitionerService (un servicio compartido
  // deshabilitado o PRIVATE para él se podía reservar armando el request).
  if (!service) return { ok: false, error: "Servicio no encontrado." };

  const practitioner = await prisma.practitioner.findFirst({
    where: { id: data.practitionerId, ...publicPractitionerWhere(tenant.id) },
    select: { id: true },
  });
  if (!practitioner) return { ok: false, error: "Profesional no encontrado." };

  const scheduledFor = new Date(data.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    return { ok: false, error: "Horario inválido." };
  }

  const idempotencyKey = `pub:${tenant.id}:${data.idempotencyKey}`;
  const who = `${data.patient.firstName} ${data.patient.lastName}`.trim();

  // ── Reintento del MISMO intento (doble click, error de MP) → mismo turno.
  const prior = await prisma.booking.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      tenantId: true,
      practitionerId: true,
      serviceId: true,
      scheduledFor: true,
      status: true,
      patientId: true,
    },
  });
  let bookingId: string;
  /** Esta llamada escribió el turno (no es replay ni twin): es la única que puede avisar del alta. */
  let createdHere = false;
  /** Lo que decidió el alta de ESTA llamada sobre el cobro online (null en replay/twin: lo dice la fila). */
  let born: { decision: OnlineChargeDecision; chargeId: string | null } | null = null;
  /** WA-S8: qué decidió ESTA llamada sobre la casilla de WhatsApp (null = no la mandó). En replay se recalcula abajo. */
  let waConsent: ReturnType<typeof decideTurneroWaConsent> = null;
  /** ZF2: lo que se le dice a la UI. `saved` de la decisión baja a `not_saved` si la ficha no admitió la escritura. */
  let waOutcome: TurneroWaConsentOutcome | null = null;
  /** ZF2: la ficha del replay / gemelo, para recalcular el flag con lo que quedó escrito. */
  let replayPatientId: string | null = null;
  if (prior) {
    const sameAttempt =
      prior.tenantId === tenant.id &&
      prior.practitionerId === data.practitionerId &&
      prior.serviceId === service.id &&
      prior.scheduledFor.getTime() === scheduledFor.getTime();
    if (!sameAttempt) {
      return { ok: false, error: "Tu reserva cambió. Recargá la página e intentá de nuevo." };
    }
    // Un CANCELLED no se revive (antes el upsert devolvía el turno cancelado y
    // el paciente pagaba un turno que la agenda ya no mostraba como activo).
    if (prior.status === "CANCELLED") return { ok: false, error: CANCELLED_REPLAY_ERROR };
    bookingId = prior.id;
    replayPatientId = prior.patientId;
  } else {
    // ── Horario: tiene que ser de la grilla y tener cupo (misma función que
    // la lista del wizard). Antes se aceptaba cualquier instante futuro.
    const dateKey = toARDateKey(scheduledFor);
    if (!isDayKey(dateKey)) return { ok: false, error: "Horario inválido." };
    const availability = await loadAvailabilityInputs(prisma, {
      tenantId: tenant.id,
      practitionerIds: [data.practitionerId],
      serviceId: service.id,
      from: dateKey,
      to: dateKey,
    });
    const offer = resolvePublicOffer(availability, data.practitionerId, service.id);
    if (!offer) return { ok: false, error: "Servicio no encontrado." };
    const slots = publicDaySlots(availability, {
      practitionerId: data.practitionerId,
      serviceId: service.id,
      dayKey: dateKey,
      now: new Date(),
    });
    const verdict = checkPublicSlot(scheduledFor, slots);
    if (verdict === "off-grid") return slotGone(SLOT_OFF_GRID_ERROR);
    if (verdict === "unavailable") return slotGone(SLOT_UNAVAILABLE_ERROR);
    const slotLocationId = slots.find((s) => s.iso === scheduledFor.toISOString())?.locationId ?? null;

    let resolution: Awaited<ReturnType<typeof resolvePublicPatient>>;
    try {
      resolution = await resolvePublicPatient(
        tenant.id,
        {
          firstName: data.patient.firstName,
          lastName: data.patient.lastName,
          email: data.patient.email,
          phone: data.patient.phone,
          documentId: data.patient.documentId,
          dateOfBirth: new Date(data.patient.dateOfBirth),
          coverageInsurer: data.patient.coverageInsurer || undefined,
          coveragePlan: data.patient.coveragePlan || undefined,
          emergencyName: data.patient.emergencyName || undefined,
          emergencyPhone: data.patient.emergencyPhone || undefined,
        },
        { practitionerId: data.practitionerId }
      );
    } catch (e) {
      logger.error("booking.public.patient_failed", {
        tenant: tenant.slug,
        err: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, error: GENERIC_SUBMIT_ERROR };
    }

    // WA-S8 (§26.5): consentimiento de WhatsApp, decidido FUERA de la tx (lectura de configuración, cacheada; sin la
    // casilla o con modo `off`, 0 sentencias). Se escribe ADENTRO de la tx del alta, más abajo.
    waConsent = decideTurneroWaConsent({
      requested: data.waConsent,
      accountActive: data.waConsent === true && (await turneroWhatsAppActive(tenant.id)),
      phone: data.patient.phone,
    });
    waOutcome = waConsent?.outcome ?? null;

    // T5 (C-TP8): política + cuenta del vendedor, FUERA de la tx (son lecturas de configuración; con modo `off` o
    // política OFF es una sola o ninguna). Nunca la cuenta de la plataforma (H-TP1).
    const chargeCtx = await loadPublicChargeContext(tenant.id, data.practitionerId);
    // Sin política activa, sin cuenta o con OPTIONAL sin «Pagar ahora» no puede haber cobro: no se lee la cobertura.
    const chargeable =
      chargeCtx.policy !== null &&
      chargeCtx.account !== null &&
      (chargeCtx.policy.mode === "REQUIRED" || data.payNow === true);
    try {
      // Una reserva pública VENCIDA del mismo paciente en este instante se
      // cancela en la misma tx (ver `releaseOwnExpiredPublicHold`): si no, el
      // índice único parcial rechazaba su propio re-intento.
      const created = await prisma.$transaction(async (tx) => {
        // B4.1 (TOCTOU de cupo, handoff de B3.2): el veredicto de arriba se
        // calculó FUERA de esta tx y antes de `resolvePublicPatient`; dos
        // pacientes distintos en un slot de cupo 1 lo leían "libre" los dos y
        // escribían los dos (test "[B4.1] cupo 1: tres submits concurrentes").
        // Primero el lock de cupo de (profesional, servicio, días AR) — la MISMA
        // clave que toman create/update/batch de la agenda, así que el turnero
        // y la agenda también se serializan entre sí — y recién después se
        // recarga y re-chequea la grilla con este tx: en READ COMMITTED la
        // recarga ya ve la fila del que entró antes. Orden de locks igual que
        // en lib/bookings.ts (cupo → hora → sedes): sin ciclos.
        //
        // T3 (C-AS3, enmienda C2 (1c)): además del cupo, la HORA AR del inicio
        // del profesional (`kinesoft:phour:…`), en la MISMA sentencia
        // (`lockAgendaKeysMany`: 0 sentencias nuevas). El tope por intervalo
        // cruza servicios y el lock de cupo lleva el servicio: sin la clave de
        // hora, una reserva online y un alta de la agenda de servicios
        // distintos en el mismo intervalo leían «0 de 1» las dos y entraban
        // las dos. La clave de hora es la misma que toman los write-paths de
        // la agenda, así que turnero y staff se serializan por el tope. Se
        // toma SIEMPRE (con o sin tope): la clave no depende de la config, y
        // un tope prendido en el medio no deja una ventana sin lock.
        await lockAgendaKeysMany(tx, {
          cap: capacityKeysForWindow({
            tenantId: tenant.id,
            practitionerId: data.practitionerId,
            serviceId: service.id,
            start: scheduledFor,
            end: new Date(scheduledFor.getTime() + offer.durationMin * 60_000),
          }),
          hour: [hourKeyForStart({ tenantId: tenant.id, practitionerId: data.practitionerId, start: scheduledFor })],
        });
        const fresh = await loadAvailabilityInputs(tx, {
          tenantId: tenant.id,
          practitionerIds: [data.practitionerId],
          serviceId: service.id,
          from: dateKey,
          to: dateKey,
        });
        const freshVerdict = checkPublicSlot(
          scheduledFor,
          publicDaySlots(fresh, {
            practitionerId: data.practitionerId,
            serviceId: service.id,
            dayKey: dateKey,
            now: new Date(),
          })
        );
        // "ok" es el único veredicto aceptable (PublicSlotVerdict = "ok" |
        // "off-grid" | "unavailable"): un bloqueo o un cambio de franja en el
        // medio también sacan el slot de la grilla. T3: la recarga trae el
        // tope (`intervalCaps`) y TODOS los turnos del profesional, así que
        // este mismo recuento con el motor rechaza el intervalo que se llenó
        // mientras esperábamos el lock (`tope-intervalo` → "unavailable").
        if (freshVerdict !== "ok") throw new PublicSlotGoneError();
        if (slotLocationId) {
          // Lock compartido de sedes y RECIÉN DESPUÉS validar (lib/location-lock.ts):
          // un archivado no puede intercalarse entre el chequeo y el INSERT.
          await lockTenantLocationsShared(tx, tenant.id);
          const loc = await tx.location.findFirst({
            where: { id: slotLocationId, tenantId: tenant.id, active: true },
            select: { id: true },
          });
          if (!loc) throw new PublicLocationGoneError();
        }
        // SR (SR2b, SR-D3): la sala por defecto de la franja del slot, con la
        // grilla FRESCA (la de esta tx) y en la sede del slot. Se valida
        // DESPUÉS del lock compartido de sedes (`archiveRoom` toma el
        // exclusivo): archivada → el turno queda sin sala, no es error (el
        // paciente no la eligió). Sin chequeo de ocupación ni lock de sala:
        // el turnero no la toma (la barrera es la validación de Configuración).
        // Sin sala en la franja → 0 statements nuevos. `slotLocationId` null =
        // el tenant no tiene sedes → tampoco salas.
        const defaultRoomId = slotLocationId
          ? defaultRoomFor(fresh, data.practitionerId, scheduledFor, offer.durationMin, slotLocationId)
          : null;
        const roomId =
          defaultRoomId && slotLocationId
            ? ((await lockActiveRoomInTx(tx, { tenantId: tenant.id, roomId: defaultRoomId, locationId: slotLocationId }))?.id ??
              null)
            : null;
        const released = await releaseOwnExpiredPublicHold(tx, {
          tenantId: tenant.id,
          patientId: resolution.patientId,
          scheduledFor,
          now: new Date(),
        });
        // T5 (C-TP8): cuánto se cobra online. COPAGO = el del paciente identificado con la precedencia de la agenda
        // (AUDIT §5.5), no el precio crudo del servicio (TP-0 cobraba `Service.priceCents` aunque el paciente tuviera
        // obra social). Contacto distinto → particular (TP-D22). Sin cobro posible, `copagoCents` no se usa.
        const copagoCents = chargeable
          ? await resolvePublicCopagoCents(tx, {
              tenantId: tenant.id,
              patientId: resolution.patientId,
              servicePriceCents: service.priceCents,
              contactMismatch: resolution.contactMismatch,
            })
          : service.priceCents;
        const decision = decideOnlineCharge({
          connectMode: chargeCtx.connectMode,
          policy: chargeCtx.policy,
          account: chargeCtx.account,
          payNow: data.payNow,
          copagoCents,
        });
        const charging = decision.kind === "charge" && chargeCtx.account !== null;
        const notes = [
          ...resolution.reviewNotes,
          ...(charging && resolution.contactMismatch ? [PUBLIC_PARTICULAR_CHARGE_NOTE] : []),
          data.patient.notes || "",
        ]
          .filter((l) => l.trim() !== "")
          .join("\n");
        const row = await tx.booking.create({
          data: {
            tenantId: tenant.id,
            practitionerId: data.practitionerId,
            serviceId: service.id,
            patientId: resolution.patientId,
            scheduledFor,
            // Override del profesional (PractitionerService.durationMin) o la del servicio.
            durationMin: offer.durationMin,
            locationId: slotLocationId,
            // Con sala, `slotLocationId` es explícito (CHECK SR-D6).
            roomId,
            notes: notes || null,
            title: data.patient.title || null,
            description: data.patient.description || null,
            guestName: resolution.contactSnapshot?.guestName ?? null,
            guestEmail: resolution.contactSnapshot?.guestEmail ?? null,
            guestPhone: resolution.contactSnapshot?.guestPhone ?? null,
            idempotencyKey,
            // PENDING solo con cobro OBLIGATORIO (REQUIRED): es el único estado que vence a los 30 min
            // (`isHoldingCapacity`). Sin cobro, o con OPTIONAL «Pagar ahora» (TP-D16), nace reservado.
            status: decision.kind === "charge" && decision.required ? "PENDING" : "CONFIRMED",
            paymentStatus: "UNPAID",
          },
          select: { id: true, status: true, practitionerId: true, scheduledFor: true, roomId: true, createdAt: true },
        });
        // El cobro nace en la MISMA tx que el turno: un turno PENDING sin su cobro sería un hold que nadie puede pagar,
        // y un cobro sin turno, plata sin imputar. Si el INSERT falla (cuenta desconectada en el medio: guard de M18)
        // vuelve todo.
        let chargeId: string | null = null;
        if (decision.kind === "charge" && chargeCtx.account) {
          ({ chargeId } = await createTurneroChargeInTx(tx, {
            tenantId: tenant.id,
            bookingId: row.id,
            patientId: resolution.patientId,
            practitionerId: data.practitionerId,
            mpAccountId: chargeCtx.account.id,
            kind: decision.chargeKind,
            amountCents: decision.amountCents,
            copagoBasisCents: decision.chargeKind === "FULL" ? copagoCents : null,
            expiresAt: turneroChargeExpiresAt({ required: decision.required, createdAt: row.createdAt, scheduledFor }),
          }));
        }
        // WA-S8 (§26.5, WA-D3/WA-D17): el consentimiento en la MISMA tx del alta (si el turno no entra, no queda un
        // consentimiento de una reserva que no existe) y ANTES del commit, así el hook post-commit del aviso
        // (`afterBookingsCommitted`, C-WA8) ya lo ve. Sobre la ficha que usa la reserva, nueva o existente por DNI:
        // H4 prohíbe pisar el contacto de una ficha existente y acá NO se toca `phone` ni `email`; el consentimiento
        // queda anclado al número TIPEADO (`waPhoneE164`).
        // ZF2 (hallazgo 2): sobre una ficha EXISTENTE (match por DNI) solo si su celular ES el número tipeado
        // (`turneroConsentFitsFicha`). Antes se escribía siempre: el aviso no se desviaba (el canal quedaba
        // `phone_changed`), pero un anónimo con el DNI de otro le pisaba el consentimiento y le cortaba los avisos.
        // La ficha nueva (creada por esta reserva) sí: el número es el de quien la creó.
        let waSaved = false;
        if (waConsent?.outcome === "saved") {
          const fits =
            resolution.created ||
            turneroConsentFitsFicha({
              createdHere: false,
              fichaPhone:
                (await tx.patient.findFirst({ where: { id: resolution.patientId, tenantId: tenant.id }, select: { phone: true } }))?.phone ?? null,
              e164: waConsent.e164,
            });
          // WA-S8 H-1: el turnero anónimo no revierte una BAJA (REVOKED): eso queda para ALTA, el portal o la
          // Secretaría. OR explícito: un NOT REVOKED en SQL también dejaría afuera a los NULL (nunca respondió). ZF2: si
          // no escribió (REVOKED), el flag dice `not_saved` (antes decía `saved` y la UI prometía avisos).
          const n = !fits ? { count: 0 } : await tx.patient.updateMany({
            where: { id: resolution.patientId, tenantId: tenant.id, OR: [{ waConsent: null }, { waConsent: "GRANTED" }] },
            data: {
              waConsent: "GRANTED",
              waConsentAt: new Date(),
              waConsentSource: "TURNERO",
              waConsentByUserId: null,
              waConsentVersion: WA_CONSENT_VERSION,
              waPhoneE164: waConsent.e164,
            },
          });
          waSaved = n.count > 0;
        }
        return { ...row, released, decision, chargeId, waSaved };
      });
      bookingId = created.id;
      createdHere = true;
      born = { decision: created.decision, chargeId: created.chargeId };
      if (waOutcome === "saved" && !created.waSaved) waOutcome = "not_saved";
      // SV06a · Sala de Espera realtime: una sola llamada por commit, JUSTO
      // después de la tx y ANTES de crear la preferencia. Por qué ahí:
      //   - fuera de la tx (contrato del hook): adentro, un rollback dejaba un
      //     evento publicado de un turno que no existe;
      //   - antes de MP: la preferencia puede fallar (red, token) y el turno
      //     igual quedó escrito y reteniendo cupo; si el aviso fuera
      //     después, la agenda no se enteraba hasta el polling de 60 s.
      // Superficie sin Actor: el tenant sale del slug ya resuelto (`tenant.id`).
      // La reserva vencida que se canceló en la misma tx va como 2.º ref.
      // Los dos caminos de replay (key ya existente arriba y el twin del
      // P2002 abajo) NO pasan por acá: no escribieron nada, no avisan.
      const refs: BookingChangeRef[] = [
        {
          bookingId: created.id,
          practitionerId: created.practitionerId,
          scheduledFor: created.scheduledFor,
          roomId: created.roomId,
          kind: "booking",
        },
      ];
      if (created.released) {
        refs.push({
          bookingId: created.released.id,
          practitionerId: created.released.practitionerId,
          scheduledFor: created.released.scheduledFor,
          roomId: created.released.roomId,
          kind: "booking",
        });
      }
      await afterBookingsCommitted(tenant.id, refs);
      // PL-A (plan §20.5.9): las reservas públicas (y el reemplazo de un hold
      // vencido) dejaron de auditarse: ruido operativo; queda el log de abajo.
    } catch (e) {
      if (e instanceof PublicLocationGoneError || e instanceof PublicSlotGoneError) {
        return slotGone(SLOT_UNAVAILABLE_ERROR);
      }
      // P2002 distinguido por los DATOS, no por `meta.target` (que llega null
      // bajo RLS, ver `resolveUniqueViolation` en lib/bookings.ts):
      //   - hay una fila viva con ESTA key → dos submits del mismo intento se
      //     cruzaron → éxito idempotente con esa fila;
      //   - si no → índice parcial paciente+instante: ya tiene un turno activo
      //     que arranca a esa hora (reservado desde la agenda u otra pestaña).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const twin = await prisma.booking.findUnique({
          where: { idempotencyKey },
          select: { id: true, status: true, patientId: true },
        });
        if (twin && twin.status !== "CANCELLED") {
          // El otro submit escribió (turno y cobro) y avisa; este sigue como un replay de su fila.
          bookingId = twin.id;
          replayPatientId = twin.patientId;
        } else {
          return { ok: false, error: SAME_SLOT_ERROR };
        }
      } else {
        logger.error("booking.public.create_failed", {
          tenant: tenant.slug,
          err: e instanceof Error ? e.message : String(e),
        });
        return { ok: false, error: GENERIC_SUBMIT_ERROR };
      }
    }
  }

  // WA-S8: en replay / gemelo no se escribe nada (lo escribió el alta original, misma key = misma instancia del
  // wizard = misma casilla); el flag se recalcula con la misma regla para que la UI diga lo mismo que la primera vez.
  // ZF2: `saved` solo si la ficha quedó GRANTED con ESE número (lo que escribió, o no, el alta original).
  if (!createdHere && data.waConsent === true) {
    waConsent = decideTurneroWaConsent({
      requested: true,
      accountActive: await turneroWhatsAppActive(tenant.id),
      phone: data.patient.phone,
    });
    waOutcome = waConsent?.outcome ?? null;
    if (waConsent?.outcome === "saved") {
      const p = replayPatientId
        ? await prisma.patient.findFirst({ where: { id: replayPatientId, tenantId: tenant.id }, select: { waConsent: true, waPhoneE164: true } })
        : null;
      if (!(p?.waConsent === "GRANTED" && p.waPhoneE164 === waConsent.e164)) waOutcome = "not_saved";
    }
  }
  const waFlag = waOutcome ? { whatsappConsent: waOutcome } : {};

  const logDone = (next: SubmitPublicBookingResult["next"], extra: Record<string, unknown> = {}) =>
    // VX2-d1 (AUDIT `turnero-revalidatepath-doble`): sin `revalidatePath("/agenda", "/dashboard")`. La invalidación
    // la hace `afterBookingsCommitted` (tags `bookingDays` + `dashboard`) justo después de cada commit; los replays no
    // escribieron nada y no tienen qué invalidar.
    logger.info("booking.public.create", {
      bookingId,
      tenant: tenant.slug,
      replay: !createdHere,
      next,
      charge: born ? (born.decision.kind === "charge" ? (born.decision.required ? "required" : "optional") : born.decision.reason) : "replay",
      // WA-S8: solo el resultado (nunca el número).
      ...(waOutcome ? { wa: waOutcome } : {}),
      ...extra,
    });
  const reserved = (notice?: "payment-unavailable"): ActionResult<SubmitPublicBookingResult> => {
    logDone("reserved", notice ? { notice } : {});
    return {
      ok: true,
      data: { bookingId, next: "reserved", initPoint: null, amountCents: null, ...(notice ? { notice } : {}), ...waFlag },
    };
  };
  const checkout = (initPoint: string, amountCents: number): ActionResult<SubmitPublicBookingResult> => {
    logDone("checkout");
    return { ok: true, data: { bookingId, next: "checkout", initPoint, amountCents, ...waFlag } };
  };
  /** BOOKING_CREATED (H-TP3) del alta de esta llamada, cuando el turno quedó RESERVADO (nunca en un replay). */
  const notifyCreated = async () => {
    if (!createdHere) return;
    await notifyPublicReservation(tenant.id, {
      practitionerId: data.practitionerId,
      scheduledFor,
      serviceName: service.name,
      who,
    });
  };

  // ── Alta de esta llamada.
  if (born) {
    if (born.decision.kind !== "charge" || !born.chargeId) {
      await notifyCreated();
      return reserved();
    }
    const required = born.decision.required;
    const pref = await openTurneroPreference({ tenantId: tenant.id, chargeId: born.chargeId, mode: required ? "REQUIRED" : "OPTIONAL" });
    if (pref.ok) {
      // OPTIONAL: el turno ya está reservado (CONFIRMED) aunque no pague → se avisa ahora. REQUIRED: lo avisa el
      // webhook cuando el pago confirma el turno.
      if (!required) await notifyCreated();
      return checkout(pref.initPoint, born.decision.amountCents);
    }
    // TP-D29: REQUIRED no se degrada. El turno queda PENDING con su cobro vivo (sin preferencia) y el reintento del
    // paciente (misma key) vuelve a pedir la preferencia con EL MISMO cobro.
    if (required) return { ok: false, error: PAYMENT_UNAVAILABLE_ERROR };
    // OPTIONAL: el paciente eligió pagar ahora pero MP no responde → reservado sin cobro y aviso.
    await cancelTurneroChargeWithoutPreference({ tenantId: tenant.id, chargeId: born.chargeId });
    await notifyCreated();
    return reserved("payment-unavailable");
  }

  // ── Replay (misma key) o gemelo del P2002: se decide por la fila, sin crear otro turno ni otro cobro.
  const row = await prisma.booking.findFirst({
    where: { id: bookingId, tenantId: tenant.id },
    select: {
      status: true,
      paymentStatus: true,
      createdAt: true,
      patientId: true,
      idempotencyKey: true,
      onlineCharges: {
        where: { origin: "TURNERO" },
        select: { id: true, status: true, amountCents: true, checkoutUrl: true, cancelReason: true },
        take: 1,
      },
    },
  });
  if (!row) return { ok: false, error: GENERIC_SUBMIT_ERROR };
  const charge = row.onlineCharges[0] ?? null;
  const step = turneroReplayStep({
    bookingStatus: row.status,
    holdAlive: isHoldingCapacity(row, new Date()),
    charge: charge && { status: charge.status, hasPreference: !!charge.checkoutUrl, cancelReason: charge.cancelReason },
  });
  switch (step) {
    case "cancelled":
      return { ok: false, error: CANCELLED_REPLAY_ERROR };
    case "reserved":
      return reserved();
    case "reserved-notice":
      return reserved("payment-unavailable");
    case "checkout":
      // C-TP8: el MISMO `initPoint` (el paciente que vuelve atrás desde MP no genera otra preferencia).
      return checkout(charge!.checkoutUrl!, charge!.amountCents);
    case "open-preference": {
      const required = row.status === "PENDING";
      const pref = await openTurneroPreference({ tenantId: tenant.id, chargeId: charge!.id, mode: required ? "REQUIRED" : "OPTIONAL" });
      if (pref.ok) return checkout(pref.initPoint, charge!.amountCents);
      if (required) return { ok: false, error: PAYMENT_UNAVAILABLE_ERROR };
      await cancelTurneroChargeWithoutPreference({ tenantId: tenant.id, chargeId: charge!.id });
      return reserved("payment-unavailable");
    }
    case "hold-expired":
      return { ok: false, error: HOLD_EXPIRED_ERROR };
    case "payment-in-flight":
      return { ok: false, error: PAYMENT_IN_FLIGHT_ERROR };
    case "preference-error":
      return { ok: false, error: PAYMENT_UNAVAILABLE_ERROR };
    case "promote":
      break;
  }

  // ── PENDING SIN cobro de T5 (nació con el checkout legado o antes de TP-0): se promueve una sola vez.
  let promotion: Awaited<ReturnType<typeof promoteHeldPublicBookingInTx>>;
  try {
    promotion = await prisma.$transaction((tx) => promoteHeldPublicBookingInTx(tx, { tenantId: tenant.id, bookingId }));
  } catch (e) {
    logger.error("booking.public.promote_failed", {
      bookingId,
      tenant: tenant.slug,
      err: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: GENERIC_SUBMIT_ERROR };
  }
  switch (promotion.kind) {
    case "promoted":
      // Otro commit: su propio evento realtime y el aviso.
      await afterBookingsCommitted(tenant.id, [
        {
          bookingId: promotion.ref.id,
          practitionerId: promotion.ref.practitionerId,
          scheduledFor: promotion.ref.scheduledFor,
          roomId: promotion.ref.roomId,
          kind: "booking",
        },
      ]);
      await notifyPublicReservation(tenant.id, {
        practitionerId: promotion.ref.practitionerId,
        scheduledFor: promotion.ref.scheduledFor,
        serviceName: service.name,
        who,
      });
      return reserved();
    case "already-confirmed":
      return reserved();
    case "cancelled":
      return { ok: false, error: CANCELLED_REPLAY_ERROR };
    case "expired":
      return { ok: false, error: HOLD_EXPIRED_ERROR };
    case "payment-in-flight":
      return { ok: false, error: PAYMENT_IN_FLIGHT_ERROR };
    case "not-public":
      return { ok: false, error: GENERIC_SUBMIT_ERROR };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Public status polling
// ──────────────────────────────────────────────────────────────────────

function initials(...parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .map((s) => s!.trim()[0]?.toUpperCase() ?? "")
    .join("");
}

export async function getPublicBookingStatus(
  id: string
): Promise<PublicBookingStatus | null> {
  // Rate-limit status polling — the success page already polls every 3s,
  // attacker scrape attempts should be cheap to reject.
  const rl = await rateLimit(`pub:status:${callerIp()}`, {
    limit: 120,
    windowMs: 60_000,
  });
  if (!rl.ok) return null;

  const b = await prisma.booking.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      scheduledFor: true,
      durationMin: true,
      tenant: { select: { slug: true, name: true } },
      service: { select: { name: true, priceCents: true } },
      practitioner: {
        select: {
          user: { select: { fullName: true } },
        },
      },
      patient: { select: { firstName: true, lastName: true } },
      payment: { select: { amountCents: true, expectedAmountCents: true, status: true } },
      guestName: true,
      // T5 (C-TP8): el cobro online del turnero, con su comprobante. Misma sentencia (relación).
      tenantId: true,
      patientId: true,
      notes: true,
      copagoCents: true,
      onlineDepositCents: true,
      onlineCharges: {
        where: { origin: "TURNERO" },
        take: 1,
        select: {
          kind: true,
          status: true,
          amountCents: true,
          mpPaymentId: true,
          approvedAt: true,
          paidAmountCents: true,
          paymentMethodId: true,
          paymentTypeId: true,
          installments: true,
          mpStatus: true,
          refundedAt: true,
        },
      },
    },
  });
  if (!b) return null;

  const c = b.onlineCharges[0];
  let onlineCharge: PublicBookingStatus["onlineCharge"] = null;
  if (c && (c.kind === "FULL" || c.kind === "DEPOSIT")) {
    // Lo que falta pagar con una seña = copago − señas pagadas. El copago del turno se resuelve como en el alta
    // (`copagoCents` propio si ya lo tiene; si no, la precedencia de la agenda, y particular si el cobro se calculó así
    // por TP-D22: la nota lo marca). Solo con DEPOSIT: un FULL lleva el monto completo y no lee nada más.
    const copago =
      c.kind === "DEPOSIT"
        ? (b.copagoCents ??
          (b.patientId
            ? await resolvePublicCopagoCents(prisma, {
                tenantId: b.tenantId,
                patientId: b.patientId,
                servicePriceCents: b.service.priceCents,
                contactMismatch: (b.notes ?? "").includes(PUBLIC_PARTICULAR_CHARGE_NOTE),
              })
            : b.service.priceCents))
        : 0;
    onlineCharge = publicOnlineChargeView({
      kind: c.kind,
      status: c.status,
      amountCents: c.amountCents,
      copagoCents: copago,
      onlineDepositCents: b.onlineDepositCents,
      receipt: c,
    });
  }

  const patientInitials =
    initials(b.patient?.firstName, b.patient?.lastName) ||
    initials(...(b.guestName?.split(/\s+/) ?? [])) ||
    null;

  return {
    bookingId: b.id,
    status: b.status,
    paymentStatus: b.paymentStatus,
    tenantSlug: b.tenant.slug,
    tenantName: b.tenant.name,
    serviceName: b.service.name,
    // DIR-0: página pública; sin nombre → «Profesional», nunca el email.
    practitionerName: publicPractitionerName(b.practitioner.user.fullName),
    scheduledFor: b.scheduledFor.toISOString(),
    durationMin: b.durationMin,
    patientInitials,
    // Con cobro de T5, su monto (≥ $1 por CHECK). Legado (H-TP2): antes `payment?.amountCents ?? price`, y
    // `amountCents` vale 0 hasta que acredita («$ 0» pendiente).
    amountCents: onlineCharge
      ? onlineCharge.amountCents
      : publicStatusAmountCents({ priceCents: b.service.priceCents, payment: b.payment }),
    onlinePayment: !!b.payment || !!onlineCharge,
    onlineCharge,
  };
}
