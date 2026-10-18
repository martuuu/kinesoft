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
import { env, turneroCheckout } from "@/lib/env";
import { createCheckoutPreference } from "@/lib/mercadopago";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import { decidePublicCheckout, isOnlineCheckoutAvailable, publicStatusAmountCents } from "@/lib/public-booking-payment";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { toARDateKey } from "@/lib/datetime-ar";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { lockCapacityWindow } from "@/lib/booking-cap-lock";
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
  isPublicTurneroOpen,
  promoteHeldPublicBookingInTx,
  releaseOwnExpiredPublicHold,
  resolvePublicPatient,
} from "@/lib/public-booking-internal";
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
} from "@/lib/public-booking-types";

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
    // TP-0: solo el copy del wizard («Confirmar turno» vs pagar); cada submit lo decide `decidePublicCheckout`.
    onlineCheckout: isOnlineCheckoutAvailable({ mode: turneroCheckout(), mpConfigured: !!env.MP_ACCESS_TOKEN }),
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
const SAME_SLOT_ERROR = "Ya tenés un turno reservado en ese horario.";
const GENERIC_SUBMIT_ERROR = "No pudimos registrar la reserva. Probá de nuevo en unos minutos.";
const CANCELLED_REPLAY_ERROR = "Ese turno fue cancelado. Recargá la página para reservar de nuevo.";
/** TP-0: el reintento de un PENDING cuyo plazo de 30 min ya pasó (el cupo se pudo dar a otro). */
const HOLD_EXPIRED_ERROR = "Tu reserva venció. Volvé a elegir el horario.";
/** TP-0: hay un pago AUTHORIZED en curso sobre ese turno; lo resuelve el webhook, no un reintento del wizard. */
const PAYMENT_IN_FLIGHT_ERROR = "Ya hay un pago en proceso para este turno. Esperá la confirmación de Mercado Pago.";

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
 * Crea (o reencuentra, si es un reintento) el turno público + la preferencia
 * de Mercado Pago.
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
 *     profesional; la duración es la de su PractitionerService.
 *   - Sede: la de la franja del slot (el cliente no la elige ni la manda);
 *     se valida activa bajo el lock compartido de sedes dentro de la tx.
 *   - Re-reserva del propio slot vencido: si el paciente ya tenía en ese
 *     instante SU reserva pública impaga vencida, se cancela y se crea la nueva
 *     en la misma tx (`releaseOwnExpiredPublicHold`, revisión A2).
 *   - Ficha: `resolvePublicPatient` (H4): match por DNI normalizado, nunca
 *     parchea una ficha existente; el contacto distinto va al snapshot
 *     `guest*` del turno + nota para el kine.
 *   - Cobro (TP-0, H-TP0): `decidePublicCheckout` (lib/public-booking-payment.ts). Solo con `TURNERO_CHECKOUT=platform`,
 *     MP configurado y precio ≥ $1 el turno nace PENDING y se devuelve el `init_point` de Checkout Pro
 *     (`next: "checkout"`). Si no, nace CONFIRMED/UNPAID sin `Payment` (`next: "reserved"`, se paga en el
 *     consultorio): retiene el cupo siempre, porque `isHoldingCapacity` solo libera PENDING. Antes se mandaba SIEMPRE
 *     a pagar con el precio crudo: con servicios de $0 o sin token MP fallaba y nadie podía terminar una reserva.
 *   - Replay sin checkout: CONFIRMED → `reserved` sin escribir ni avisar. PENDING vigente (nació con el checkout o
 *     antes de TP-0) → se promueve una vez (`promoteHeldPublicBookingInTx`); vencido → «Tu reserva venció».
 *   - Preferencia caída → se degrada a reservado con la misma promoción (`booking.public.checkout_degraded`): el
 *     consultorio nunca eligió el pago obligatorio (eso llega con TP-2), no se le traba la reserva al paciente.
 *   - Aviso `BOOKING_CREATED` (H-TP3) una vez, después del commit que lo dejó CONFIRMED; nunca en replay.
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
  // TP-0: monto = precio del servicio (TP-2 lo cambia por la política del consultorio y `resolveBookingCopagoCents`).
  // `TURNERO_CHECKOUT` default `off` (HF-1a): la única cuenta MP de hoy es la de la plataforma (H-TP1).
  const checkout = decidePublicCheckout({
    amountCents: service.priceCents,
    mode: turneroCheckout(),
    mpConfigured: !!env.MP_ACCESS_TOKEN,
  });
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
  /** Estado de la fila al salir de este bloque: el alta de esta llamada, el replay o el twin del P2002. */
  let rowStatus: string;
  /** Esta llamada escribió el turno (no es replay ni twin): es la única que puede avisar del alta. */
  let createdHere = false;
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
    rowStatus = prior.status;
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
    if (verdict === "off-grid") {
      return { ok: false, error: "Ese horario no está disponible para reservar online. Elegí otro." };
    }
    if (verdict === "unavailable") return { ok: false, error: SLOT_UNAVAILABLE_ERROR };
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

    const notes = [...resolution.reviewNotes, data.patient.notes || ""]
      .filter((l) => l.trim() !== "")
      .join("\n");
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
        // en lib/bookings.ts (cupo → sedes): sin ciclos.
        await lockCapacityWindow(tx, {
          tenantId: tenant.id,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          start: scheduledFor,
          end: new Date(scheduledFor.getTime() + offer.durationMin * 60_000),
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
        // medio también sacan el slot de la grilla.
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
            // TP-0: sin checkout nace reservado (se paga en el consultorio). PENDING solo si se va a mandar a pagar:
            // es el único estado que vence a los 30 min (`isHoldingCapacity`).
            status: checkout.kind === "checkout" ? "PENDING" : "CONFIRMED",
            paymentStatus: "UNPAID",
          },
          select: { id: true, status: true, practitionerId: true, scheduledFor: true, roomId: true },
        });
        return { ...row, released };
      });
      bookingId = created.id;
      rowStatus = created.status;
      createdHere = true;
      // SV06a · Sala de Espera realtime: una sola llamada por commit, JUSTO
      // después de la tx y ANTES de `createCheckoutPreference`. Por qué ahí:
      //   - fuera de la tx (contrato del hook): adentro, un rollback dejaba un
      //     evento publicado de un turno que no existe;
      //   - antes de MP: la preferencia puede fallar (red, token) y el turno
      //     igual quedó escrito y reteniendo cupo; si el aviso fuera
      //     después, la agenda no se enteraba hasta el polling de 60 s. (TP-0:
      //     si falla, la promoción de abajo es otro commit y avisa aparte.)
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
        return { ok: false, error: SLOT_UNAVAILABLE_ERROR };
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
          select: { id: true, status: true },
        });
        if (twin && twin.status !== "CANCELLED") {
          // El otro submit escribió y avisa; este solo devuelve su turno (sin checkout, el twin ya nació CONFIRMED).
          bookingId = twin.id;
          rowStatus = twin.status;
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

  const logDone = (next: SubmitPublicBookingResult["next"]) =>
    // VX2-d1 (AUDIT `turnero-revalidatepath-doble`): sin `revalidatePath("/agenda", "/dashboard")`. La invalidación
    // la hace `afterBookingsCommitted` (tags `bookingDays` + `dashboard`) justo después de cada commit; los replays no
    // escribieron nada y no tienen qué invalidar.
    logger.info("booking.public.create", {
      bookingId,
      tenant: tenant.slug,
      replay: !createdHere,
      next,
      checkout: checkout.kind === "checkout" ? "checkout" : checkout.reason,
    });
  const reserved = (): ActionResult<SubmitPublicBookingResult> => {
    logDone("reserved");
    return { ok: true, data: { bookingId, next: "reserved", initPoint: null } };
  };

  // ── Ya reservado (alta CONFIRMED de esta llamada, o replay/twin que ya no está PENDING: lo promovió otro submit, lo
  // pagó el webhook, lo confirmó la recepción). El replay no escribe ni avisa; tampoco arma una preferencia nueva
  // sobre un turno que ya no espera pago.
  if (rowStatus !== "PENDING") {
    if (createdHere) {
      await notifyPublicReservation(tenant.id, {
        practitionerId: data.practitionerId,
        scheduledFor,
        serviceName: service.name,
        who,
      });
    }
    return reserved();
  }

  // ── PENDING con checkout: la preferencia, como antes de TP-0.
  if (checkout.kind === "checkout") {
    try {
      const pref = await createCheckoutPreference({
        bookingId,
        title: `${service.name} · ${tenant.name}`,
        amountCents: checkout.amountCents,
        currency: tenant.currency,
        payer: { email: data.patient.email, name: data.patient.firstName },
      });
      logDone("checkout");
      return { ok: true, data: { bookingId, next: "checkout", initPoint: pref.initPoint } };
    } catch (e) {
      // Antes: el turno quedaba PENDING 30 min y cada reintento volvía a fallar (H-TP0). Ahora se degrada a reservado
      // (promoción de abajo): el consultorio no eligió el pago obligatorio. warn, no error: es un camino previsto.
      logger.warn("booking.public.checkout_degraded", {
        bookingId,
        tenant: tenant.slug,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── PENDING sin checkout (replay de un hold del checkout, o la preferencia cayó): se promueve una sola vez.
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
      // Otro commit: su propio evento realtime (el del alta PENDING, si lo hubo, ya salió arriba) y el aviso.
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
    },
  });
  if (!b) return null;

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
    // H-TP2: antes `payment?.amountCents ?? price`, y `amountCents` vale 0 hasta que acredita («$ 0» pendiente).
    amountCents: publicStatusAmountCents({ priceCents: b.service.priceCents, payment: b.payment }),
    onlinePayment: !!b.payment,
  };
}

/**
 * Dev-only: pretend MP confirmed the payment so the success page works
 * without a real webhook. Only enabled outside production.
 */
export async function devMarkBookingPaid(id: string): Promise<ActionResult> {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, error: "Sólo disponible en desarrollo." };
  }
  const b = await prisma.booking.findUnique({
    where: { id },
    select: { id: true, tenantId: true, practitionerId: true, scheduledFor: true, roomId: true },
  });
  if (!b) return { ok: false, error: "Booking no encontrado." };
  await prisma.$transaction([
    prisma.booking.update({
      where: { id },
      data: { status: "CONFIRMED", paymentStatus: "PAID" },
    }),
    prisma.payment.upsert({
      where: { bookingId: id },
      create: {
        bookingId: id,
        provider: "dev-stub",
        status: "PAID",
        amountCents: 0,
        currency: "ARS",
      },
      update: { status: "PAID" },
    }),
  ]);
  // SV06a: simula el webhook, así que avisa igual que él (después del commit,
  // con el tenant del turno: no hay Actor). Sin esto, en dev la agenda abierta
  // no veía el pago hasta el polling y el QA del realtime daba falso rojo.
  await afterBookingsCommitted(b.tenantId, [
    { bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: b.roomId, kind: "booking" },
  ]);
  return { ok: true, data: undefined };
}
