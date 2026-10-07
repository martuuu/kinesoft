"use server";

/**
 * Public booking — server actions used by the unauthenticated turnero
 * at `/c/[slug]/booking`. Everything reachable from a stranger lives
 * here, with explicit tenant resolution by slug (no actor context).
 *
 * Security model:
 *   - All inputs are rate-limited (per IP).
 *   - Switch del turnero (EV0, `Tenant.publicBookingEnabled`, opt-in): apagado,
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
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
// No-Actor surface (anonymous turnero) → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { Prisma } from "@prisma/client";
import { prismaService as prisma } from "@/lib/db";
import { createCheckoutPreference } from "@/lib/mercadopago";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { toARDateKey } from "@/lib/datetime-ar";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { lockCapacityWindow } from "@/lib/booking-cap-lock";
import { acceptsInsurer, addDays, eligiblePractitioners, isDayKey, resolvePractitionerService } from "@/lib/availability";
import {
  PUBLIC_FIRST_FREE_HORIZON_DAYS,
  checkPublicSlot,
  firstPublicSlotAcross,
  publicDaySlots,
  resolvePublicOffer,
} from "@/lib/public-booking-slots";
import {
  PUBLIC_BOOKING_SWITCH_SELECT,
  releaseOwnExpiredPublicHold,
  resolvePublicPatient,
} from "@/lib/public-booking-internal";
import { isPublicBookingOpen } from "@/lib/tenant-modules";
import type { ActionResult } from "@/lib/validation";
import {
  FirstPublicSlotSchema,
  ListPublicSlotsSchema,
  SubmitSchema,
  normalizeDocumentId,
  type FirstPublicSlotInput,
  type ListPublicSlotsInput,
  type PublicClinic,
  type PublicFirstSlot,
  type PublicSlot,
  type PublicBookingStatus,
  type SubmitPublicBookingInput,
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
  return { tenantId, user: { memberships: { some: { tenantId, acceptedAt: { not: null } } } } };
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
    select: { id: true, slug: true, name: true, legalName: true, palette: true, ...PUBLIC_BOOKING_SWITCH_SELECT },
  });
  // Turnero apagado (EV0, EV-D2 opt-in) = mismo resultado que un slug que no
  // existe: el wizard no recibe profesionales, servicios ni sedes. La página
  // distingue los dos casos con `getPublicBookingGate` (cerrado ≠ 404).
  if (!tenant || !isPublicBookingOpen(tenant)) return null;
  const tenantId = tenant.id;

  const [practitioners, services, psRows, insurers, ppRows, locations, schedules] = await Promise.all([
    prisma.practitioner.findMany({
      where: publicPractitionerWhere(tenantId),
      include: { user: { select: { fullName: true, email: true } } },
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
    prisma.practitionerSchedule.findMany({
      where: { tenantId, location: { active: true } },
      select: { practitionerId: true, locationId: true },
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

  return {
    slug: tenant.slug,
    name: tenant.name,
    legalName: tenant.legalName,
    palette: tenant.palette,
    practitioners: practitioners
      .filter((p) => offering.has(p.id))
      .map((p) => {
        const own = new Set(schedules.filter((r) => r.practitionerId === p.id).map((r) => r.locationId));
        // Sin franjas = red de seguridad del motor (horario del tenant en la principal).
        const locationIds = own.size > 0 ? locationOrder.filter((id) => own.has(id)) : primary ? [primary.id] : [];
        return {
          id: p.id,
          name: p.user.fullName ?? p.user.email,
          specialty: p.specialty,
          licenseNumber: p.licenseNumber,
          yearsExp: p.yearsExp,
          rating: p.rating,
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
  if (!tenant || !isPublicBookingOpen(tenant)) return null;
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

  // Sin `practitionerIds`: el loader trae los de membresía aceptada (= los públicos).
  const availability = await loadAvailabilityInputs(prisma, {
    tenantId: tenant.id,
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
 *   - Mercado Pago: preferencia de Checkout Pro; se devuelve `init_point`.
 */
export async function submitPublicBooking(
  raw: SubmitPublicBookingInput
): Promise<ActionResult<{ bookingId: string; initPoint: string }>> {
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
  if (!isPublicBookingOpen(tenant)) return { ok: false, error: PUBLIC_BOOKING_CLOSED_ERROR };

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
  let patientId: string | null;
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
    if (prior.status === "CANCELLED") {
      return { ok: false, error: "Ese turno fue cancelado. Recargá la página para reservar de nuevo." };
    }
    bookingId = prior.id;
    patientId = prior.patientId;
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
            notes: notes || null,
            title: data.patient.title || null,
            description: data.patient.description || null,
            guestName: resolution.contactSnapshot?.guestName ?? null,
            guestEmail: resolution.contactSnapshot?.guestEmail ?? null,
            guestPhone: resolution.contactSnapshot?.guestPhone ?? null,
            idempotencyKey,
          },
          select: { id: true, patientId: true },
        });
        return { ...row, released };
      });
      bookingId = created.id;
      patientId = created.patientId;
      if (created.released) {
        // Auditado acá (no tras MP): la cancelación ya se commiteó aunque la
        // preferencia falle después.
        await audit({
          tenantId: tenant.id,
          action: "booking.public.expired_replaced",
          entity: "Booking",
          entityId: created.released,
          payload: { replacedBy: created.id, patientId: created.patientId },
        });
      }
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
          select: { id: true, status: true, patientId: true },
        });
        if (twin && twin.status !== "CANCELLED") {
          bookingId = twin.id;
          patientId = twin.patientId;
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

  let pref: Awaited<ReturnType<typeof createCheckoutPreference>>;
  try {
    pref = await createCheckoutPreference({
      bookingId,
      title: `${service.name} · ${tenant.name}`,
      amountCents: service.priceCents,
      currency: tenant.currency,
      payer: { email: data.patient.email, name: data.patient.firstName },
    });
  } catch (e) {
    // El turno queda PENDING/UNPAID: retiene el cupo 30 min y un reintento con
    // la misma key lo reencuentra (no duplica).
    logger.error("booking.public.preference_failed", {
      bookingId,
      err: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: "No pudimos iniciar el pago. Probá de nuevo en unos segundos." };
  }

  await audit({
    tenantId: tenant.id,
    action: "booking.public.create",
    entity: "Booking",
    entityId: bookingId,
    payload: {
      patientId,
      preferenceId: pref.preferenceId,
      amountCents: service.priceCents,
      replay: !!prior,
    },
  });
  logger.info("booking.public.create", { bookingId, tenant: tenant.slug, replay: !!prior });


  revalidatePath("/agenda");
  revalidatePath("/dashboard");

  return {
    ok: true,
    data: { bookingId, initPoint: pref.initPoint },
  };
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
          user: { select: { fullName: true, email: true } },
        },
      },
      patient: { select: { firstName: true, lastName: true } },
      payment: { select: { amountCents: true } },
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
    practitionerName: b.practitioner.user.fullName ?? b.practitioner.user.email,
    scheduledFor: b.scheduledFor.toISOString(),
    durationMin: b.durationMin,
    patientInitials,
    amountCents: b.payment?.amountCents ?? b.service.priceCents,
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
  const b = await prisma.booking.findUnique({ where: { id }, select: { id: true, tenantId: true } });
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
  return { ok: true, data: undefined };
}
