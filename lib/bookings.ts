"use server";

/**
 * Booking domain — server-only queries + Server Actions used by the
 * Agenda calendar.
 *
 * `listBookingsInRange` is the workhorse for week/day views — returns
 * everything between [from, to) for the active tenant with patient info
 * joined. Mutations are intentionally narrow: create, reschedule, change
 * status (confirm / cancel / mark no-show / complete).
 */
import { revalidatePath, unstable_cache } from "next/cache";
import { Prisma, type BookingStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { notify } from "@/lib/notifications-internal";
import { getParticularCopagoCents, resolveBookingCopagoCents } from "@/lib/billing-internal";
import { isPublicReservation, overlapBlocks } from "@/lib/booking-capacity";
import { toARDateKey } from "@/lib/datetime-ar";
import { lockPlanPatient } from "@/lib/plan-lock";
import { bookingHasMoney, priorPaidStamp } from "@/lib/plan-pricing";
import { formatARS } from "@/lib/format";
import { classifyBatchInstant, dayKeyOf, defaultRoomFor, expandDates, roomOccupancyAt } from "@/lib/availability";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import {
  capacityKeysForWindow,
  lockCapacityAndRoomsMany,
  lockCapacityWindow,
  roomKeysForWindow,
} from "@/lib/booking-cap-lock";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { countRoomOverlapsInTx, loadRoomBookingsInTx, lockActiveRoomInTx } from "@/lib/booking-rooms-internal";
import { bulkPatientAccess } from "@/lib/visibility";
import { ForbiddenError, type Actor } from "@/lib/session";
import { getMembershipRole, requireCapability } from "@/lib/authz";
import { canOperateBooking, canWriteClinical, capabilitiesFor, type Capability } from "@/lib/capabilities";
import { bookingFieldAccess } from "@/lib/booking-field-access";
import { applyReceptionAction, RECEPTION_ACTION_LABEL } from "@/lib/reception-state";
import type { ForceFlags } from "@/lib/booking-force-flags";
import { tags, ttl } from "@/lib/cache-tags";
import { NotificationKind } from "@prisma/client";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
// S07c (ES2b P2.0): los helpers de los write-paths y el cuerpo de la tx de
// `updateBooking` viven en el core server-only (`lib/bookings-core.ts`), para
// que Planes (P2.1) los llame dentro de su propia tx con los mismos gates y
// locks. Este archivo queda como wrapper de las actions: getActor → zod →
// runWithRls(core) → traducir el outcome → audit/notify/revalidate →
// `afterBookingsCommitted` (enmienda Realtime: una vez, después del commit y
// fuera de `runWithRls`; reemplaza a `invalidateBookingDerivedCaches`).
import {
  acceptClientKey,
  applyBookingUpdateInTx,
  bookingRefsError,
  buildBookingCreateData,
  checkPatientOverlap,
  classifyForWrite,
  countCapacityOverlaps,
  defaultLocationFor,
  guestOperable,
  hasFullAccess,
  liveBlocksInTx,
  loadInstantAvailability,
  lockActiveLocation,
  lockPlanReactivationInTx,
  notifyPlanNearingDischarge,
  activeForSession,
  planStampData,
  practitionerLabel,
  rangesForInput,
  resolveBookingUpdateUniqueViolation,
  resolveUniqueViolation,
  suggestNextFreeSlot,
  syncPlanSessionAfterBookingWriteInTx,
  validateBookingRefsInTx,
  writableFields,
  type PlanReactivationStamp,
  type PlanSyncResult,
} from "@/lib/bookings-core";
import { loadAgendaPlanProjection } from "@/lib/agenda-plan-projection-internal";
import {
  BASIC_ACCESS_ERROR,
  BAD_LOCATION_ERROR,
  BAD_ROOM_ERROR,
  BLOCKED_ERROR,
  CLINICAL_RELINK_ERROR,
  OUT_OF_HOURS_ERROR,
  PATIENT_OVERLAP_ERROR,
  PLAN_DELETE_ERROR,
  PLAN_PAID_CANCEL_ERROR,
  PLAN_PATIENT_CHANGE_ERROR,
  PLAN_SESSION_NOT_PENDING_ERROR,
  PLAN_SESSION_TAKEN_ERROR,
  SESSION_KEPT_DONE_NOTICE,
  RECEPTION_FORBIDDEN_ERROR,
  RECEPTION_OTHER_PRACTITIONER_ERROR,
  ROOM_BLOCKED_ERROR,
  ROOM_BUSY_ERROR,
  SAME_INSTANT_ERROR,
  STALE_ERROR,
  UPDATE_SAME_INSTANT_ERROR,
} from "@/lib/bookings-constants";
import {
  BookingBatchCreate,
  BookingCreate,
  BookingUpdate,
  type ActionResult,
  type BookingBatchCreateInput,
  type BookingCreateInput,
  type BookingUpdateInput,
} from "@/lib/validation";

import {
  AgendaBookingsQuery,
  ReceptionActionInput,
  type AgendaBookingRow,
  type AgendaBookingsQueryInput,
  type BatchDateOutcome,
  type BookingBlockedPrompt,
  type BookingOutOfHoursPrompt,
  type BookingRow,
  type ReceptionActionResult,
} from "@/lib/bookings-types";
import type { ReceptionAction } from "@/lib/reception-state";

export async function listBookingsInRange(opts: {
  from: Date;
  to: Date;
  practitionerId?: string;
}): Promise<BookingRow[]> {
  const actor = await getActor();
  // Sprint 16: agenda shows every booking in the tenant; per-row access
  // tier is resolved below. The diagnosis chip is hidden when the actor
  // only has BASIC access to that booking's patient.
  const rows = await runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      scheduledFor: { gte: opts.from, lt: opts.to },
      ...(opts.practitionerId ? { practitionerId: opts.practitionerId } : {}),
    },
    orderBy: { scheduledFor: "asc" },
    include: {
      service: true,
      patient: {
        include: {
          // Active coverage → insurer name + copago for the billing
          // subtitle/columns. `take: 1` mirrors the single-coverage model
          // (setPatientCoverage replaces rather than appends).
          coverages: {
            include: { insurerRef: true },
            orderBy: { id: "desc" },
            take: 1,
          },
          programs: {
            where: { status: "ACTIVE" },
            include: { case: { include: { diagnoses: { include: { condition: true }, take: 1, orderBy: { rank: "asc" } } } } },
            // S07k: con dos ACTIVE (legacy de prod; el único parcial llega con
            // M1) el chip mostraba el que Postgres devolviera primero. Gana el
            // más reciente, igual que el resto de las lecturas del plan activo.
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
    },
  }));

  const patientIds = rows
    .map((b) => b.patientId)
    .filter((id): id is string => !!id);
  const [accessMap, particularCopago, role] = await Promise.all([
    bulkPatientAccess(actor, patientIds),
    getParticularCopagoCents(actor.tenantId),
    getMembershipRole(actor),
  ]);
  // E0 (S07k): esta server action se puede llamar por RPC aunque la agenda ya
  // use `listAgendaBookings`. Gateaba solo full/basic, así que la Secretaria
  // (ASSISTANT, sin `clinical.read`) con `sharedPatientView` leía título,
  // descripción, notas y diagnóstico. Ahora: la misma regla que la agenda
  // (`bookingFieldAccess`) y el chip de diagnóstico solo con clinical + full.
  const clinical = capabilitiesFor(role).has("clinical.read");

  return rows.map((b): BookingRow => {
    const level = b.patientId ? (accessMap.get(b.patientId) ?? "basic") : "none";
    // `BookingRow.patientAccess` solo conoce full/basic/none: cualquier otro
    // nivel (el `admin` de PD-13, S02p) viaja como "basic" = sin link a la HC
    // (decisión de S07sb, ver el tipo en lib/bookings-types.ts). El gate de
    // campos usa el nivel real (`bookingFieldAccess` exige "full").
    const access: BookingRow["patientAccess"] = level === "full" || level === "none" ? level : "basic";
    const fields = bookingFieldAccess({ clinical, access: level, hasPatient: !!b.patientId });
    // Chip de diagnóstico = HC: solo clinical.read + full (= `canWriteClinical`
    // en lectura). Un guest no tiene plan.
    const cond =
      clinical && access === "full"
        ? b.patient?.programs[0]?.case?.diagnoses[0]?.condition?.name ?? null
        : null;
    const name = b.patient
      ? `${b.patient.firstName} ${b.patient.lastName}`
      : b.guestName ?? "Sin asignar";
    // Billing: resolve obra social + copago from the patient's active
    // coverage. Particular (no insurer / no coverage / guest) falls back
    // to "Particular" with the service price as the amount the patient
    // pays out of pocket. Gated to full access — basic-access rows hide
    // billing PHI (consistent with notes/condition above). PD-13 (S07sb):
    // el nivel `admin` (Secretaria/Facturación) ve obra social, cobertura y
    // estado de cobro — SOLO esto; título/descripción/notas siguen con
    // `bookingFieldAccess` y el diagnóstico con clinical + full.
    const seesBilling = level === "full" || level === "admin";
    const coverage = seesBilling ? b.patient?.coverages[0] : undefined;
    const insurer = coverage?.insurerRef;
    const obraSocial =
      seesBilling
        ? insurer?.name ?? coverage?.insurer ?? "Particular"
        : "Particular";
    // Copago precedence: per-turno override → per-patient override →
    // insurer → Particular → service price. Basic-access rows hide billing
    // and just show the service price.
    const copagoCents =
      seesBilling
        ? resolveBookingCopagoCents({
            bookingOverride: b.copagoCents,
            coverageOverride: coverage?.copagoCents ?? null,
            hasCoverage: !!coverage,
            insurerCopago: insurer ? insurer.copagoCents : null,
            particularCopago,
            servicePriceCents: b.service.priceCents,
          })
        : b.service.priceCents;
    return {
      id: b.id,
      scheduledFor: b.scheduledFor,
      durationMin: b.durationMin,
      status: b.status,
      serviceId: b.serviceId,
      serviceName: b.service.name,
      serviceColor: b.service.color,
      practitionerId: b.practitionerId,
      patientId: b.patientId,
      patientName: name,
      patientCondition: cond,
      obraSocial,
      copagoCents,
      updatedAt: b.updatedAt,
      // A2 integrador: la agenda los usa para "Pendiente de pago · vencida".
      paymentStatus: b.paymentStatus,
      createdAt: b.createdAt,
      // Revisión A2: la etiqueta "Pendiente de pago" es solo de la reserva
      // pública (por la key, no por tener paciente). La key no viaja al cliente.
      publicReservation: isPublicReservation(b),
      // Notes, title and description can carry clinical context — hidden on
      // basic (A2a-S06: title/description leaked before) and, since E0, also
      // without `clinical.read` (`bookingFieldAccess`, same rule as
      // `listAgendaBookings`). Guest rows keep their notes (the front desk
      // wrote them: administrative); title/description of a guest still need
      // `clinical.read`.
      notes: fields.notes === "rw" ? b.notes : null,
      title: fields.title === "rw" ? b.title : null,
      description: fields.description === "rw" ? b.description : null,
      patientAccess: access,
    };
  });
}

/**
 * Proyección LIVIANA de la agenda (B4.1 AV-bookings-2). La consume la agenda
 * multi-profesional (B4.3 la adopta en `app/(app)/agenda/page.tsx`; hasta
 * entonces `listBookingsInRange` sigue igual para quien la usa hoy) y la vista
 * Recepción (B4.5).
 *
 * Por qué una función nueva y no un flag en `listBookingsInRange`: la completa
 * incluye, POR FILA, paciente → coberturas → programas → caso → diagnósticos
 * (hecho 6 de bpre-design: el cuello de botella con 5+ profesionales en una
 * semana). Acá:
 *   - sin programa/caso/diagnóstico: `patientCondition` siempre null (el chip
 *     de la card lo cubre `title`, el mini-diagnóstico del turno);
 *   - la cobertura NO va por fila: UNA query plana para los pacientes
 *     distintos con acceso `full` o `admin` (los únicos a los que se les
 *     muestra billing; `admin` desde PD-13/S07sb), con la misma precedencia de copago (`resolveBookingCopagoCents`,
 *     AUDIT §5.5) — `obraSocial`/`copagoCents` dan igual que en la completa
 *     (lo afirma bookings-reception.test.ts);
 *   - service/patient con `select` de lo que se muestra, no `include` entero.
 *
 * Gate `clinical.read` (lib/capabilities.ts): sin ella (ASSISTANT, BILLING)
 * title/description van null y `notes` solo queda en turnos SIN paciente (la
 * carga el staff: es administrativa, p. ej. el teléfono de una reserva
 * externa). Se suma al gate por paciente de siempre (acceso `basic` →
 * title/description/notes null). `clinicalHidden` lo informa por fila, y
 * `canOperate` / `clinicalWritable` (S07sb) dicen qué puede hacer el actor
 * con el turno: son la fuente para la UI, calculadas con los mismos
 * predicados que los write-paths.
 * `agenda.viewAll` (hoy la tienen todos los roles): sin ella, solo la agenda
 * propia — falla cerrado si C0 crea un rol sin esa capability.
 *
 * Filtros: `practitionerIds[]` (vacío = todos) y `locationId` (la principal
 * incluye los turnos con `locationId` null, contrato de M-agenda; una sede que
 * no es del tenant → []). Rango ≤ 62 días; input inválido → tira ZodError
 * (server action de lectura, como `listBookingsInRange`).
 */
export async function listAgendaBookings(raw: AgendaBookingsQueryInput): Promise<AgendaBookingRow[]> {
  const actor = await getActor();
  const q = AgendaBookingsQuery.parse(raw);
  const caps = capabilitiesFor(await getMembershipRole(actor));
  const clinical = caps.has("clinical.read");
  let practitionerIds = q.practitionerIds?.length ? [...new Set(q.practitionerIds)] : undefined;
  if (!caps.has("agenda.viewAll")) {
    practitionerIds = (practitionerIds ?? [actor.practitionerId]).filter((id) => id === actor.practitionerId);
  }
  const tenantId = actor.tenantId;

  const loaded = await runWithRls(tenantId, async (tx) => {
    // Las sedes del tenant son pocas: una query sirve para el filtro (¿es la
    // principal?) y para `locationName` (null = principal).
    const locations = await tx.location.findMany({
      where: { tenantId },
      select: { id: true, name: true, isPrimary: true },
    });
    let locationWhere: Prisma.BookingWhereInput = {};
    if (q.locationId) {
      const loc = locations.find((l) => l.id === q.locationId);
      if (!loc) return null;
      locationWhere = loc.isPrimary
        ? { OR: [{ locationId: loc.id }, { locationId: null }] }
        : { locationId: loc.id };
    }
    const rows = await tx.booking.findMany({
      where: {
        tenantId,
        scheduledFor: { gte: q.from, lt: q.to },
        ...(practitionerIds ? { practitionerId: { in: practitionerIds } } : {}),
        ...(q.includeCancelled === false ? { status: { not: "CANCELLED" as const } } : {}),
        ...locationWhere,
        // SR: filtro de sala en el MISMO where (sin queries nuevas, techo +10 %):
        // "none" = solo sin sala; un id = esa sala (una ajena no matchea: el
        // tenantId de arriba va a mano); null/ausente = todas.
        ...(q.roomId === "none" ? { roomId: null } : q.roomId ? { roomId: q.roomId } : {}),
      },
      orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
      select: {
        id: true,
        scheduledFor: true,
        durationMin: true,
        status: true,
        serviceId: true,
        practitionerId: true,
        patientId: true,
        guestName: true,
        copagoCents: true,
        notes: true,
        title: true,
        description: true,
        updatedAt: true,
        paymentStatus: true,
        createdAt: true,
        idempotencyKey: true,
        isOverbooked: true,
        locationId: true,
        roomId: true, // SR: escalar, misma sentencia; el nombre lo resuelve el cliente
        isTelemedicine: true,
        telemedicineUrl: true,
        arrivedAt: true,
        attendingAt: true,
        // SV05 (M5): estado «Llamado» de la sala de espera. Escalar, misma sentencia.
        calledAt: true,
        // C9 (S12): vínculo con el plan, para la proyección de abajo.
        programId: true,
        sessionId: true,
        // `discipline` para C9: así la proyección no vuelve a leer Service.
        service: { select: { name: true, color: true, priceCents: true, discipline: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    const patientIds = [...new Set(rows.map((b) => b.patientId).filter((id): id is string => !!id))];
    const access = await bulkPatientAccess(actor, patientIds, tx);
    // C9 (Planes): chip del plan, disciplina y "Fuera de plan", con queries
    // planas sobre las filas ya filtradas por tenant (S12p; sin el módulo
    // `planes`, neutro y sin queries).
    const c9 = await loadAgendaPlanProjection(
      tx,
      actor,
      rows.map((r) => ({
        id: r.id,
        patientId: r.patientId,
        serviceId: r.serviceId,
        programId: r.programId,
        sessionId: r.sessionId,
        serviceDiscipline: r.service.discipline,
      })),
      caps
    );
    // PD-13 (S07sb): cobertura/copago también para `admin` (Secretaria y
    // Facturación ven obra social y estado de cobro); nunca para `basic`.
    const billingIds = patientIds.filter((id) => {
      const l = access.get(id);
      return l === "full" || l === "admin";
    });
    const [coverages, particularCopago] = await Promise.all([
      billingIds.length
        ? tx.coverage.findMany({
            where: { patientId: { in: billingIds }, patient: { tenantId } },
            // = `orderBy id desc, take 1` por paciente de la proyección completa.
            orderBy: { id: "desc" },
            select: {
              patientId: true,
              insurer: true,
              copagoCents: true,
              insurerRef: { select: { name: true, copagoCents: true } },
            },
          })
        : Promise.resolve([]),
      getParticularCopagoCents(tenantId, tx),
    ]);
    return { locations, rows, access, coverages, particularCopago, c9 };
  });
  if (!loaded) return [];

  const coverageOf = new Map<string, (typeof loaded.coverages)[number]>();
  for (const c of loaded.coverages) if (!coverageOf.has(c.patientId)) coverageOf.set(c.patientId, c);
  const locationName = new Map(loaded.locations.map((l) => [l.id, l.name]));
  const primaryName = loaded.locations.find((l) => l.isPrimary)?.name ?? null;

  return loaded.rows.map((b): AgendaBookingRow => {
    // PD-13: el nivel real puede ser `admin` (rol sin clinical.read). En la fila
    // viaja como basic; los campos de texto salen de `bookingFieldAccess` con el
    // nivel real (forma positiva `=== "full"`), así `admin` nunca ve HC.
    const level = b.patientId ? (loaded.access.get(b.patientId) ?? "basic") : "none";
    const access: "full" | "basic" | "none" = level === "full" || level === "none" ? level : "basic";
    const fields = bookingFieldAccess({ clinical, access: level, hasPatient: !!b.patientId });
    // S07sb (E1): permisos de la fila calculados acá, la UI no los deduce de
    // `patientAccess` (que manda `admin` como "basic"). Guest: `guestOperable`
    // (P0.Z: BILLING no), igual que en los write-paths (`bookingGateInTx`). `clinicalWritable` = el
    // título/descripción se escriben (= se leen): con paciente es
    // `canWriteClinical`; en un guest, `clinical.read`.
    const canOperate = b.patientId ? canOperateBooking(caps, level) : guestOperable(caps);
    const clinicalWritable = b.patientId ? canWriteClinical(caps, level) : fields.title === "rw";
    const seesBilling = level === "full" || level === "admin";
    const coverage = seesBilling && b.patientId ? coverageOf.get(b.patientId) : undefined;
    const insurer = coverage?.insurerRef;
    // Mismo cálculo que `listBookingsInRange` (precedencia §5.5; basic → precio).
    const obraSocial = seesBilling ? insurer?.name ?? coverage?.insurer ?? "Particular" : "Particular";
    const copagoCents =
      seesBilling
        ? resolveBookingCopagoCents({
            bookingOverride: b.copagoCents,
            coverageOverride: coverage?.copagoCents ?? null,
            hasCoverage: !!coverage,
            insurerCopago: insurer ? insurer.copagoCents : null,
            particularCopago: loaded.particularCopago,
            servicePriceCents: b.service.priceCents,
          })
        : b.service.priceCents;
    return {
      id: b.id,
      scheduledFor: b.scheduledFor,
      durationMin: b.durationMin,
      status: b.status,
      serviceId: b.serviceId,
      serviceName: b.service.name,
      serviceColor: b.service.color,
      practitionerId: b.practitionerId,
      patientId: b.patientId,
      patientName: b.patient ? `${b.patient.firstName} ${b.patient.lastName}` : b.guestName ?? "Sin asignar",
      patientCondition: null,
      obraSocial,
      copagoCents,
      notes: fields.notes === "rw" ? b.notes : null,
      title: fields.title === "rw" ? b.title : null,
      description: fields.description === "rw" ? b.description : null,
      updatedAt: b.updatedAt,
      patientAccess: access,
      paymentStatus: b.paymentStatus,
      createdAt: b.createdAt,
      publicReservation: isPublicReservation(b),
      isOverbooked: b.isOverbooked,
      locationId: b.locationId,
      locationName: b.locationId ? locationName.get(b.locationId) ?? null : primaryName,
      roomId: b.roomId,
      isTelemedicine: b.isTelemedicine,
      telemedicineUrl: b.telemedicineUrl,
      arrivedAt: b.arrivedAt,
      attendingAt: b.attendingAt,
      calledAt: b.calledAt,
      clinicalHidden: fields.title !== "rw",
      canOperate,
      clinicalWritable,
      // La proyección devuelve una entrada por cada fila que recibe.
      ...loaded.c9.get(b.id)!,
    };
  });
}

export async function getDayCounts(opts: { from: Date; to: Date }) {
  const actor = await getActor();
  // Day-strip dots show every booking in the tenant — counts don't leak
  // PHI so no access gating needed here.
  const rows = await runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
    where: {
      tenantId: actor.tenantId,
      scheduledFor: { gte: opts.from, lt: opts.to },
      status: { not: "CANCELLED" },
    },
    select: { scheduledFor: true },
  }));
  const counts = new Map<string, number>();
  for (const r of rows) {
    // Bucket by the AR calendar day, not the UTC slice — otherwise a late-night
    // turno lands on the wrong day's dot on a UTC host (Vercel).
    const k = toARDateKey(r.scheduledFor);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export async function listServices() {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string) =>
      runWithRls(tenantId, (tx) => tx.service.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
      })),
    ["services:list", actor.tenantId],
    { tags: [tags.services(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

/**
 * Profesionales del selector de la agenda. Solo los que tienen membresía
 * ACEPTADA en este tenant (A2b-S-cfg): `removeMember` borra la membresía pero
 * deja la fila Practitioner (historial), y antes el removido seguía
 * apareciendo como opción para dar turnos. El tag `practitioners` se invalida
 * al quitar/cambiar de rol (lib/invitations.ts) y al aceptar una invitación.
 */
export async function listPractitioners() {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string) =>
      runWithRls(tenantId, (tx) => tx.practitioner.findMany({
        where: {
          tenantId,
          user: { memberships: { some: { tenantId, acceptedAt: { not: null } } } },
        },
        include: { user: true },
        orderBy: { createdAt: "asc" },
      })),
    ["practitioners:list", actor.tenantId],
    { tags: [tags.practitioners(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

export async function createBooking(
  raw: BookingCreateInput & {
    allowOverbooking?: boolean;
    // Front-desk confirmed that a second turno the same day for this patient
    // is intentional (they don't overlap). Skips the same-patient-day prompt.
    allowSamePatientDay?: boolean;
    // Front-desk confirmed the new turno may overlap one the patient already
    // has (two services in parallel is normal in kinesiología). The exact same
    // instant is still refused by the DB unique index.
    allowPatientOverlap?: boolean;
    // B3.1 (decisión 2): el staff confirmó cargarlo fuera de la franja del
    // profesional (o un día que no atiende). Solo aviso, no sobreturno.
    allowOutOfHours?: boolean;
    // B3.1 (decisión 1): el staff confirmó cargarlo sobre un bloqueo de agenda.
    // Queda como sobreturno (`isOverbooked` + prefijo). El turnero y Planes no
    // lo pueden forzar (bloqueo duro allá).
    allowBlocked?: boolean;
    // SR (SR-D2): el staff confirmó "Cargar igual" con la sala llena u ocupada
    // (otro profesional o un bloqueo de sala). NO es sobreturno: no marca
    // `isOverbooked` ni el prefijo. Saltea la clave y el conteo de sala; la sala
    // igual se valida (tenant, sede, activa).
    allowRoomConflict?: boolean;
    // Stable per-attempt key from the client so a double-submit / retry
    // collapses to one row, while a deliberate new turno gets its own.
    idempotencyKey?: string;
  }
): Promise<
  ActionResult<{ id: string }> & {
    conflict?: {
      practitionerName: string;
      nextFreeISO: string | null;
    };
    // Soft prompt: the patient already has ≥1 non-overlapping turno today.
    samePatientDay?: { count: number; existingISO: string };
    // Soft prompt: the new turno overlaps one the patient already has.
    patientOverlap?: { existingISO: string };
    // B3.1: fuera del horario del profesional (re-llamar con allowOutOfHours).
    outOfHours?: BookingOutOfHoursPrompt;
    // B3.1: sobre un bloqueo de agenda (re-llamar con allowBlocked).
    blocked?: BookingBlockedPrompt;
    // SR: sala llena u ocupada (re-llamar con allowRoomConflict). Último aviso
    // del orden (FORCE_PROMPT_ORDER): sale después del cupo y del paciente.
    roomBusy?: { roomName: string; nextFreeISO: null; blocked?: { reason: string | null } | null };
  }
> {
  const actor = await getActor();
  const parsed = BookingCreate.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  const now = new Date();

  // Ids de entrada validados contra el tenant ANTES de escribir: las FK
  // saltean RLS y en prod la conexión tiene BYPASSRLS, así que un
  // `practitionerId` de otro consultorio se persistía tal cual (IDOR, A2a-S06).
  // El paciente además tiene que ser de acceso `full` (acceso básico = solo ver).
  // El diagnóstico por defecto del paciente auto-completa title/description
  // del turno cuando el caller no los envía (overridable por turno).
  // B3.1: en el mismo tx, la sede elegida (del tenant y activa; se re-valida
  // con lock al escribir), la regla del profesional para el servicio
  // (`PractitionerService`: habilitado + duración + cupo) y las entradas del
  // motor de disponibilidad para clasificar el horario.
  const pre = await runWithRls(actor.tenantId, async (tx) => {
    // Refs del tenant + gate E1 + regla del profesional (S07c: compartido con
    // el batch, `validateBookingRefsInTx`).
    const refs = await validateBookingRefsInTx(tx, actor, data);
    if (refs.kind !== "ok") return refs;
    // Duración: la explícita del caller gana; si no, la del profesional para
    // ese servicio (`PractitionerService.durationMin`) o la del servicio.
    const duration = data.durationMin ?? refs.rule.durationMin;
    const end = new Date(data.scheduledFor.getTime() + duration * 60_000);
    const input = await loadInstantAvailability(tx, {
      tenantId: actor.tenantId,
      practitionerId: refs.practitionerId,
      serviceId: refs.service.id,
      start: data.scheduledFor,
      end,
    });
    return { ...refs, duration, end, input };
  });
  if (pre.kind !== "ok") return { ok: false, error: bookingRefsError(pre) };
  const { service, rule, duration, end, input, gate } = pre;
  const patientDiag = pre.patient;
  // E1 (S07sb): lo que el actor no puede leer no lo escribe (título,
  // descripción y notas según `bookingFieldAccess`), y su `copagoCents` solo
  // vale con acceso full: sin full rige la precedencia de lib/copago.ts
  // (AUDIT §5.5) — la Secretaria no fija el precio de la sesión.
  const own = writableFields(data, gate.fields);
  const copagoCents = gate.full ? (data.copagoCents ?? null) : null;

  // Franjas y bloqueos del profesional en ese horario (motor puro). Con una
  // sede elegida se clasifica contra ESA sede; sin elegir, contra cualquiera
  // de sus franjas del día.
  const clsArgs = {
    when: data.scheduledFor,
    durationMin: duration,
    practitionerId: data.practitionerId,
    serviceId: service.id,
    locationId: data.locationId ?? null,
    cap: rule.cap,
    now,
  };
  const cls = classifyForWrite(input, clsArgs);
  const locationId = data.locationId ?? defaultLocationFor(input, data.practitionerId, data.scheduledFor, duration);
  // ── SR: sala del turno ────────────────────────────────────────────────────
  // Tres fuentes (lib/validation.ts `bookingRoomId`): ausente = la de la franja
  // que contiene el turno en la sede resuelta (`defaultRoomFor`, SR1a); null =
  // "Sin sala" explícito (no se estampa ni se chequea); un id = esa sala, que
  // tiene que ser de la sede final (elegir sala no cambia la sede, igual que
  // la edición de SR2a: el modal manda la sede de la sala).
  // La de por defecto sale de las franjas leídas en `pre`, igual que la sede
  // por defecto (`defaultLocationFor`): el alta nunca releyó franjas dentro del
  // lock (solo bloqueos, `liveBlocksInTx`). Por eso, a diferencia de la edición
  // (que lee franjas DESPUÉS del lock de cupo y toma la clave de sala en una
  // 2.ª sentencia), acá la sala ya se conoce antes de la tx de escritura y su
  // clave va FUSIONADA con el cupo en una sola sentencia: con sala, +1
  // statement (el conteo) y no +2.
  const roomPinned = typeof data.roomId === "string";
  const roomTarget: string | null =
    data.roomId === undefined
      ? defaultRoomFor(input, data.practitionerId, data.scheduledFor, duration, locationId)
      : data.roomId;
  // SR-D6: turno con sala ⇒ sede explícita (CHECK de M4). null = la principal,
  // que el loader ya trajo (`primaryLocationId`): sin query extra.
  const roomLocationId = roomTarget ? (locationId ?? input.primaryLocationId) : null;
  // SR-D1/D2: la ocupación se chequea (clave + conteo) salvo que el usuario ya
  // haya confirmado "Cargar igual".
  const roomCheck = !!roomTarget && !raw.allowRoomConflict;
  const suggest = () =>
    suggestNextFreeSlot(actor.tenantId, {
      practitionerId: data.practitionerId,
      serviceId: service.id,
      from: data.scheduledFor,
      durationMin: duration,
      cap: rule.cap,
      patientId: data.patientId ?? null,
      locationId: data.locationId ?? null,
    });
  const nameOf = () => runWithRls(actor.tenantId, (tx) => practitionerLabel(tx, actor.tenantId, data.practitionerId));

  // Stable idempotency key for THIS attempt (client-provided, else random).
  // Resolved up-front so the patient-day guard can EXCLUDE this attempt's own
  // row: an idempotent retry (lost response, same key) must not self-conflict.
  const clientKey = acceptClientKey(raw.idempotencyKey);

  // Patient-level guard, orthogonal to the professional's capacity below. Two
  // independent confirmations, each with its own flag: an OVERLAP with the
  // patient's own turno, and a second turno the SAME DAY. Both are prompts, not
  // hard errors (the kine asked for confirm modals). Scoped to the patient
  // across ALL professionals. Skipping the query entirely when both are already
  // confirmed keeps the retry path cheap (the unique index still backstops the
  // exact instant — see resolveUniqueViolation).
  const pat =
    data.patientId && !(raw.allowSamePatientDay && raw.allowPatientOverlap)
      ? await runWithRls(actor.tenantId, (tx) =>
          checkPatientOverlap(tx, {
            tenantId: actor.tenantId,
            patientId: data.patientId!,
            start: data.scheduledFor,
            end,
            excludeKey: clientKey,
          })
        )
      : null;
  // A turno at the EXACT same instant is structurally impossible — the
  // partial unique index (tenant, patient, scheduledFor) rejects it. Say so
  // up front instead of offering a confirmation that can never succeed
  // (the batch path reports this same case as "duplicado").
  if (pat?.sameInstant) return { ok: false, error: SAME_INSTANT_ERROR };

  // B3.1: avisos blandos de agenda, en la precedencia del motor (bloqueado >
  // fuera de horario) y ANTES de los del paciente/cupo: si el horario no se va
  // a usar, preguntar por el paciente o el cupo es ruido.
  if (cls.blocked && !raw.allowBlocked) {
    const [practitionerName, nextFreeISO] = await Promise.all([nameOf(), suggest()]);
    return {
      ok: false,
      error: BLOCKED_ERROR(cls.blockReason),
      blocked: { practitionerName, reason: cls.blockReason, nextFreeISO },
    };
  }
  if (cls.outOfHours && !raw.allowOutOfHours) {
    const [practitionerName, nextFreeISO] = await Promise.all([nameOf(), suggest()]);
    return { ok: false, error: OUT_OF_HOURS_ERROR, outOfHours: { practitionerName, nextFreeISO } };
  }

  if (pat) {
    if (!raw.allowPatientOverlap && pat.overlapISO) {
      return {
        ok: false,
        error: PATIENT_OVERLAP_ERROR,
        patientOverlap: { existingISO: pat.overlapISO },
      };
    }
    if (!raw.allowSamePatientDay && pat.sameDayStarts.length > 0) {
      return {
        ok: false,
        error: "El paciente ya tiene un turno hoy.",
        samePatientDay: {
          count: pat.sameDayStarts.length,
          existingISO: pat.sameDayStarts[0].toISOString(),
        },
      };
    }
  }

  // Telemedicina (decisión 9): la URL solo se guarda con el flag.
  const isTelemedicine = data.isTelemedicine ?? false;
  const telemedicineUrl = isTelemedicine ? (data.telemedicineUrl ?? null) : null;

  // Auto-fill the per-turno mini-diagnóstico from the patient's default when
  // the caller didn't provide an explicit title/description. S07sb: también
  // cuando el actor no puede escribirlos (Secretaria) — el diagnóstico es del
  // paciente, no lo escribe el actor, y el kine lo ve en su turno.
  const title = own.title ?? patientDiag?.diagnosisTitle ?? null;
  const description = own.description ?? patientDiag?.diagnosisNote ?? null;

  // Idempotency (clientKey resolved above): a double-submit / retry that shares
  // the SAME key collapses to one row via the @unique column; a *deliberate*
  // new turno (fresh modal → new key) gets its own row. This replaced the old
  // deterministic patient+slot key, which silently OVERWROTE an existing turno
  // when the same patient was re-booked at the same instant (the reported data
  // loss — now hard-blocked earlier by the patient-day guard). No client key
  // (or a malformed one) → random. NOTE: this dedups submits that share a key
  // (retry / double-click of ONE modal); two genuinely-concurrent submits from
  // DIFFERENT modal instances (two tabs / two users) carry different keys, so
  // the exact-slot case is caught by the partial unique index (P2002 →
  // resolveUniqueViolation), not the @unique column.
  const idempotencyKey = clientKey ?? randomBytes(16).toString("hex");

  try {
    // upsert on the unique idempotencyKey is atomic (Postgres ON CONFLICT):
    // a same-key retry collapses to one row. `update` resets the mutable
    // fields so a re-book of the same patient+slot (e.g. after cancelling)
    // converges to a single fresh active turno instead of returning a stale one.
    const w = await runWithRls(actor.tenantId, async (tx) => {
      // The key is CLIENT-supplied and globally @unique: with BYPASSRLS (prod)
      // a key that belongs to ANOTHER tenant's row would make the upsert's
      // `update` branch overwrite that row. Refuse it. (Under RLS the row is
      // invisible here and the ON CONFLICT update fails the policy instead.)
      const holder = await tx.booking.findUnique({
        where: { idempotencyKey },
        select: { tenantId: true, id: true, programId: true },
      });
      if (holder && holder.tenantId !== actor.tenantId) return { kind: "foreign-key" as const };
      // C3 (S12): el turno de esta key ya lo adoptó un plan. El reintento del
      // alta (respuesta perdida, doble click tardío) es el MISMO intento →
      // éxito idempotente SIN update: la rama `update` del upsert le pisaría
      // copago, estado, notas y sede a un turno que ahora es del plan (y el
      // copago de un `pricedByPlan` es la cuota, I6). Mismo escalar, sin
      // sentencia extra.
      if (holder?.programId) return { kind: "adopted" as const, id: holder.id };

      // Overlap capacity check, scoped to the SAME practitioner + SAME service.
      // Overlaps are allowed up to the cupo (null = ilimitado, el caso normal
      // en kinesiología: varios pacientes en paralelo en la franja). An expired
      // unpaid public reservation no longer holds the slot. B3.1: el cupo es el
      // efectivo del profesional (`PractitionerService.concurrencyOverride`) o
      // `Service.maxConcurrent` — con el backfill, el mismo de antes.
      // B3.1 (TOCTOU): el conteo y el upsert van en ESTE tx, detrás del lock de
      // cupo del día. Antes el conteo corría en otro tx y dos altas
      // simultáneas de pacientes distintos en un cupo 1 pasaban las dos.
      const capWindow = {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        serviceId: service.id,
        start: data.scheduledFor,
        end,
      };
      if (roomCheck) {
        // SR, enmienda C2 (1b): cupo → SALA → sedes → filas. Cupo y sala en UNA
        // sentencia (la misma cantidad que `lockCapacityWindow`): dos altas de
        // profesionales distintos en la misma sala se serializan acá, y el
        // conteo de abajo de la segunda ya ve la fila de la primera.
        await lockCapacityAndRoomsMany(
          tx,
          capacityKeysForWindow(capWindow),
          roomKeysForWindow({ tenantId: actor.tenantId, roomId: roomTarget!, start: data.scheduledFor, end })
        );
      } else {
        // Sin sala (o forzada): lo de siempre, 0 statements nuevos (techo
        // estricto de `f.createBooking` en tests/perf/compare.ts).
        await lockCapacityWindow(tx, capWindow);
      }
      // Integrador final de B-pre: re-chequeo de bloqueos con el lock de cupo
      // ya tomado (`liveBlocksInTx`). `cls` se calculó en otro tx: un candado
      // commiteado en el medio solo se ve acá. Bloqueado y sin forzar → el
      // mismo aviso `blocked` de antes; forzado → sobreturno (decisión 1).
      const live = classifyForWrite(
        {
          ...input,
          blocks: await liveBlocksInTx(tx, {
            tenantId: actor.tenantId,
            practitionerId: data.practitionerId,
            start: data.scheduledFor,
            end,
          }),
        },
        clsArgs
      );
      if (live.blocked && !raw.allowBlocked) return { kind: "blocked" as const, reason: live.blockReason };
      const overlapCount = await countCapacityOverlaps(tx, {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        serviceId: service.id,
        start: data.scheduledFor,
        end,
        now,
        excludeKey: clientKey,
      });
      const capacityReached = overlapBlocks(overlapCount, rule.cap);
      // Sin escribir: la UI ofrece el próximo libre o re-llamar con
      // allowOverbooking=true para forzar el sobreturno.
      if (capacityReached && !raw.allowOverbooking) return { kind: "conflict" as const };

      // Sobreturno = cupo lleno forzado o bloqueo forzado (decisión 1). B3.1:
      // `isOverbooked` (M-agenda) es la fuente; el prefijo "[SOBRETURNO]" en
      // notes se sigue escribiendo hasta el contract posterior a B-pre.
      const overbooked = capacityReached || live.blocked;
      const notes = overbooked ? `[SOBRETURNO] ${own.notes ?? ""}`.trim() : own.notes;

      // Sede: lock compartido + activa, en el MISMO tx que el upsert (carrera
      // con archiveLocation). Elegida y ya archivada → rechazo; la de por
      // defecto archivada en el medio → null (= principal).
      let loc = locationId;
      // SR: la sala se valida DESPUÉS del lock compartido de sedes
      // (`archiveRoom` toma el exclusivo: con el compartido tomado, la sala no
      // se archiva entre esta lectura y el upsert). `lockActiveRoomInTx` exige
      // sala activa, DE esa sede y sede activa: reemplaza a la validación de la
      // sede (misma cantidad de sentencias que `lockActiveLocation`).
      let roomId: string | null = null;
      let room: { id: string; capacity: number; name: string } | null = null;
      if (roomTarget && roomLocationId) {
        await lockTenantLocationsShared(tx, actor.tenantId);
        room = await lockActiveRoomInTx(tx, {
          tenantId: actor.tenantId,
          roomId: roomTarget,
          locationId: roomLocationId,
        });
      }
      if (room) {
        roomId = room.id;
        loc = roomLocationId; // SR-D6: la sede de la sala, explícita.
      } else {
        // Elegida y no válida (de otra sede, de otro consultorio, archivada, o
        // su sede archivada) → rechazo sin escribir. La por defecto archivada
        // en el medio → sin sala, como el turnero (SR2b) y la edición (SR2a);
        // la sede se valida sola, como siempre.
        if (roomPinned) return { kind: "bad-room" as const };
        if (loc && !(await lockActiveLocation(tx, actor.tenantId, loc))) {
          if (data.locationId) return { kind: "bad-location" as const };
          loc = null;
        }
      }
      // SR-D1/D2: ocupación de la sala DESPUÉS del conteo de cupo (orden de los
      // avisos: FORCE_PROMPT_ORDER) y con la clave de sala ya tomada arriba.
      // Profesionales DISTINTOS solapados o un bloqueo de sala (§17.5) → aviso
      // forzable; el mismo profesional nunca choca consigo mismo.
      if (room && roomCheck) {
        const occ = await countRoomOverlapsInTx(tx, {
          tenantId: actor.tenantId,
          roomId: room.id,
          practitionerId: data.practitionerId,
          start: data.scheduledFor,
          end,
          now,
          capacity: room.capacity,
          // Un reintento idempotente no choca consigo mismo.
          excludeKey: clientKey,
        });
        if (occ.atCapacity) {
          return {
            kind: "room-busy" as const,
            roomName: room.name,
            blocked: occ.blocked ? { reason: occ.blocked.reason } : null,
          };
        }
      }
      const row = await tx.booking.upsert({
        where: { idempotencyKey },
        update: {
          serviceId: service.id,
          durationMin: duration,
          copagoCents,
          notes,
          isOverbooked: overbooked,
          locationId: loc,
          // SR: junto con la sede, en la MISMA sentencia (la FK compuesta
          // (roomId, locationId) de M4 no admite la sala vieja con otra sede).
          roomId,
          isTelemedicine,
          telemedicineUrl,
          status: data.patientId ? "CONFIRMED" : "PENDING",
          guestName: data.guestName,
          guestEmail: data.guestEmail,
          guestPhone: data.guestPhone,
        },
        // S07c: los mismos datos de fila que el batch (`buildBookingCreateData`).
        create: buildBookingCreateData({
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          scheduledFor: data.scheduledFor,
          durationMin: duration,
          copagoCents,
          patientId: data.patientId,
          guestName: data.guestName,
          guestEmail: data.guestEmail,
          guestPhone: data.guestPhone,
          notes,
          isOverbooked: overbooked,
          locationId: loc,
          roomId,
          isTelemedicine,
          telemedicineUrl,
          title,
          description,
          idempotencyKey,
        }),
      });
      return { kind: "ok" as const, row };
    });
    if (w.kind === "room-busy") {
      return {
        ok: false,
        error: w.blocked ? ROOM_BLOCKED_ERROR(w.roomName, w.blocked.reason) : ROOM_BUSY_ERROR(w.roomName),
        roomBusy: { roomName: w.roomName, nextFreeISO: null, blocked: w.blocked },
      };
    }
    if (w.kind === "bad-room") return { ok: false, error: BAD_ROOM_ERROR };
    if (w.kind === "conflict") {
      const [practitionerName, suggestion] = await Promise.all([nameOf(), suggest()]);
      return {
        ok: false,
        error: "El profesional ya tiene un turno en ese horario. Podés elegir el próximo libre o forzar un sobreturno.",
        conflict: { practitionerName, nextFreeISO: suggestion },
      };
    }
    if (w.kind === "blocked") {
      const [practitionerName, nextFreeISO] = await Promise.all([nameOf(), suggest()]);
      return {
        ok: false,
        error: BLOCKED_ERROR(w.reason),
        blocked: { practitionerName, reason: w.reason, nextFreeISO },
      };
    }
    if (w.kind === "foreign-key") return { ok: false, error: "No pudimos crear el turno." };
    // Éxito idempotente: no se escribió nada → ni audit ni `afterBookingsCommitted`.
    if (w.kind === "adopted") return { ok: true, data: { id: w.id } };
    if (w.kind === "bad-location") return { ok: false, error: BAD_LOCATION_ERROR };
    const b = w.row;
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "booking.create",
      entity: "Booking",
      entityId: b.id,
    });
    if (actor.userId) {
      let who: string;
      if (data.patientId) {
        const p = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
          where: { id: data.patientId, tenantId: actor.tenantId },
          select: { firstName: true, lastName: true },
        }));
        who = p ? `${p.firstName} ${p.lastName}` : "Paciente";
      } else {
        who = data.guestName ?? "Reserva externa";
      }
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.BOOKING_CREATED,
        title: `Nuevo turno · ${who}`,
        body: data.scheduledFor.toLocaleString("es-AR", {
          weekday: "short",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "America/Argentina/Buenos_Aires",
        }),
        link: `/agenda?date=${toARDateKey(data.scheduledFor)}`,
      });
    }
    revalidatePath("/agenda");
    revalidatePath("/dashboard");
    if (data.patientId) revalidatePath(`/pacientes/${data.patientId}`);
    // Del row que devolvió el upsert: en un reintento con la misma key (rama
    // `update`) el horario y el profesional son los de la fila que ya existía.
    await afterBookingsCommitted(actor.tenantId, [
      { bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, kind: "booking", roomId: b.roomId },
    ]);
    return { ok: true, data: { id: b.id } };
  } catch (e) {
    // The partial unique index (tenant+patient+slot, non-cancelled) is the
    // race-free backstop for the patient-day guard: a genuinely-concurrent
    // second create at the same slot loses the INSERT race here. Two
    // concurrent upserts with the SAME key can also cross on that index; that
    // one resolves to the row the other one wrote (idempotent success).
    const r = await resolveUniqueViolation(actor.tenantId, e, idempotencyKey);
    if (r.kind === "existing") return { ok: true, data: { id: r.id } };
    if (r.kind === "patient-slot") return { ok: false, error: SAME_INSTANT_ERROR };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Turno duplicado." };
    }
    logger.error("booking.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear el turno." };
  }
}

// Devuelve la nueva versión (`updatedAt`) como los toggles de cobro: el
// caller (drawer, turnos-view, dashboard) la guarda y puede encadenar otra
// mutación sin recargar ni chocar con su propio lock (A2 integrador).
type UpdateBookingResult = ActionResult<{ updatedAt: Date }> & {
  conflict?: { practitionerName: string; nextFreeISO: string | null };
  patientOverlap?: { existingISO: string };
  // B3.1: mismos avisos blandos que createBooking (re-llamar con el flag).
  outOfHours?: BookingOutOfHoursPrompt;
  blocked?: BookingBlockedPrompt;
  // SR: sala llena u ocupada (forzable con `allowRoomConflict`, no es sobreturno).
  roomBusy?: { roomName: string; nextFreeISO: null; blocked?: { reason: string | null } | null };
  /**
   * S12 (C4): aviso no bloqueante de la sincronía con la sesión del plan (p.
   * ej. salir de COMPLETED con evolución cargada: la sesión queda realizada).
   */
  notice?: string;
};

export async function updateBooking(
  raw: BookingUpdateInput & {
    allowOverbooking?: boolean;
    // Same flag as createBooking: the front desk confirmed the patient may
    // have two turnos overlapping (two services in parallel).
    allowPatientOverlap?: boolean;
    // B3.1: mismos flags que createBooking (decisiones 1 y 2).
    allowOutOfHours?: boolean;
    allowBlocked?: boolean;
    allowRoomConflict?: boolean;
    expectedUpdatedAt?: string;
  }
): Promise<UpdateBookingResult> {
  const actor = await getActor();
  const parsed = BookingUpdate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { id, locationId: patchLocationId } = parsed.data;
  const patch = parsed.data;
  const now = new Date();

  // Ownership lookup + optimistic-concurrency check + access + patient re-bind
  // validation + conflict re-check + the write, all under the tenant GUC in
  // one transaction (S07c: el cuerpo es `applyBookingUpdateInTx`, con el gate
  // de la Secretaria y `bookingFieldAccess` ADENTRO). The prac-name +
  // next-free suggestion (read-only, advisory) are fetched outside on conflict.
  const outcome = await runWithRls(actor.tenantId, (tx) =>
    applyBookingUpdateInTx(
      tx,
      actor,
      {
        patch: parsed.data,
        expectedUpdatedAt: raw.expectedUpdatedAt,
        force: {
          allowOverbooking: raw.allowOverbooking,
          allowPatientOverlap: raw.allowPatientOverlap,
          allowOutOfHours: raw.allowOutOfHours,
          allowBlocked: raw.allowBlocked,
          allowRoomConflict: raw.allowRoomConflict,
        },
      },
      { now }
    )
  ).catch(async (e) => {
    // A reschedule that lands the turno on a slot the SAME patient already
    // occupies trips the partial unique index (patient+slot, non-cancelled).
    // S12: desde M1 hay un segundo único que una edición puede pisar,
    // `Booking_session_active_key` (I2: reactivar un turno de plan cuya sesión
    // ya tiene otro activo). Bajo RLS `meta.target` llega null, así que se
    // decide por los datos en una tx nueva. El core no lo atrapa: un P2002
    // aborta la tx de Postgres (C8).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const r = await resolveBookingUpdateUniqueViolation(actor.tenantId, id);
      if (r.kind === "plan-session-taken") return { kind: "plan-session-taken" as const, ordinal: r.ordinal };
      return { kind: "patient-slot" as const };
    }
    // El core ya traduce el P2025 del update a `stale`; queda por si otra
    // sentencia lo tira.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return { kind: "stale" as const };
    }
    throw e;
  });

  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  if (outcome.kind === "clinical-relink") return { ok: false, error: CLINICAL_RELINK_ERROR };
  if (outcome.kind === "patient-slot") {
    return {
      ok: false,
      error: UPDATE_SAME_INSTANT_ERROR,
    };
  }
  if (outcome.kind === "patient-overlap") {
    return {
      ok: false,
      error: PATIENT_OVERLAP_ERROR,
      patientOverlap: { existingISO: outcome.existingISO },
    };
  }
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "foreign-patient") return { ok: false, error: "Paciente fuera del consultorio." };
  if (outcome.kind === "bad-location") return { ok: false, error: BAD_LOCATION_ERROR };
  if (outcome.kind === "bad-room") return { ok: false, error: BAD_ROOM_ERROR };
  if (outcome.kind === "room-busy") {
    return {
      ok: false,
      error: outcome.blocked
        ? ROOM_BLOCKED_ERROR(outcome.roomName, outcome.blocked.reason)
        : ROOM_BUSY_ERROR(outcome.roomName),
      roomBusy: { roomName: outcome.roomName, nextFreeISO: null, blocked: outcome.blocked ?? null },
    };
  }
  // S12 (C4): variantes de Planes del core.
  if (outcome.kind === "plan-session-not-pending") {
    return { ok: false, error: PLAN_SESSION_NOT_PENDING_ERROR(outcome.ordinal) };
  }
  if (outcome.kind === "plan-session-taken") return { ok: false, error: PLAN_SESSION_TAKEN_ERROR(outcome.ordinal) };
  if (outcome.kind === "plan-paid-cancel") return { ok: false, error: PLAN_PAID_CANCEL_ERROR };
  if (outcome.kind === "plan-patient-change") return { ok: false, error: PLAN_PATIENT_CHANGE_ERROR };
  if (outcome.kind === "conflict" || outcome.kind === "blocked" || outcome.kind === "out-of-hours") {
    const [practitionerName, nextFreeISO] = await Promise.all([
      runWithRls(actor.tenantId, (tx) => practitionerLabel(tx, actor.tenantId, outcome.before.practitionerId)),
      suggestNextFreeSlot(actor.tenantId, {
        practitionerId: outcome.before.practitionerId,
        serviceId: outcome.before.serviceId,
        from: outcome.newWhen,
        durationMin: outcome.newDuration,
        cap: outcome.cap,
        patientId: outcome.finalPatientId,
        locationId: patchLocationId ?? null,
        excludeBookingId: id,
      }),
    ]);
    if (outcome.kind === "blocked") {
      return {
        ok: false,
        error: BLOCKED_ERROR(outcome.reason),
        blocked: { practitionerName, reason: outcome.reason, nextFreeISO },
      };
    }
    if (outcome.kind === "out-of-hours") {
      return { ok: false, error: OUT_OF_HOURS_ERROR, outOfHours: { practitionerName, nextFreeISO } };
    }
    return {
      ok: false,
      error: "El profesional ya tiene un turno en ese horario.",
      conflict: { practitionerName, nextFreeISO },
    };
  }

  const before = outcome.before;
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.update",
    entity: "Booking",
    entityId: id,
    // El patch YA filtrado (S07sb): un campo sacado no aparece ni en el audit.
    payload: {
      ...(outcome.written as Record<string, unknown>),
      ...(outcome.roomId !== undefined ? { roomId: outcome.roomId } : {}),
    },
  });
  // Surface status transitions in the bell.
  if (patch.status && patch.status !== before.status && actor.userId) {
    const who = before.patient
      ? `${before.patient.firstName} ${before.patient.lastName}`
      : "Reserva externa";
    const niceWhen = before.scheduledFor.toLocaleString("es-AR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "America/Argentina/Buenos_Aires",
    });
    if (patch.status === "CANCELLED") {
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.BOOKING_CANCELLED,
        title: `Turno cancelado · ${who}`,
        body: niceWhen,
        link: `/agenda?date=${toARDateKey(before.scheduledFor)}`,
      });
    } else if (patch.status === "NO_SHOW") {
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.BOOKING_CANCELLED,
        title: `Ausente · ${who}`,
        body: niceWhen,
        link: `/agenda?date=${toARDateKey(before.scheduledFor)}`,
      });
    }
  }
  revalidatePath("/agenda");
  revalidatePath("/dashboard");
  if (before.patientId) revalidatePath(`/pacientes/${before.patientId}`);
  if (patch.patientId && patch.patientId !== before.patientId) {
    revalidatePath(`/pacientes/${patch.patientId}`);
  }
  await afterBookingsCommitted(actor.tenantId, outcome.refs);
  // S12 (C4): alta próxima, post-commit (la notificación nunca tira).
  if (outcome.plan?.discharge) {
    await notifyPlanNearingDischarge(actor.tenantId, outcome.plan.discharge, actor.userId ?? null);
  }
  return {
    ok: true,
    data: { updatedAt: outcome.updatedAt },
    ...(outcome.plan?.sessionKeptDone ? { notice: SESSION_KEPT_DONE_NOTICE } : {}),
  };
}

/**
 * Status change = an `updateBooking` with only `status`. Reactivating a
 * CANCELLED turno re-checks capacity and the patient's own overlap (A2a-S06),
 * so the result can carry `conflict` / `patientOverlap` like a reschedule; the
 * caller re-sends with the matching `allow*` flag to force it.
 */
export async function setBookingStatus(
  id: string,
  status: BookingStatus,
  expectedUpdatedAt?: string,
  // B5.7: `ForceFlags` (incluye allowOutOfHours / allowBlocked de B3.1, que ya
  // se esparcían a updateBooking pero el tipo no lo decía).
  force?: ForceFlags
): Promise<UpdateBookingResult> {
  // Revisión A2: volver a PENDING no es una transición de la agenda (ver
  // BookingUpdate). La firma sigue aceptando `BookingStatus` por los callers.
  if (status === "PENDING") return { ok: false, error: "Datos inválidos" };
  return updateBooking({ id, status, expectedUpdatedAt, ...force });
}

/**
 * Recepción (B4.1; decisión 3 de B-pre: timestamps, no BookingStatus nuevos).
 * Una sola action para las seis acciones de la sala de espera — llegó, llamar
 * (SV05), en atención, atendido, ausente, deshacer — porque la transición válida depende
 * del estado ACTUAL de la fila, no del botón: `applyReceptionAction`
 * (lib/reception-state.ts, puro) la valida y arma el patch, y acá se escribe
 * en una tx con el lock optimista atómico (`where { id, tenantId, updatedAt }`
 * → P2025 = stale), así dos personas marcando el mismo turno no pisan una a la
 * otra ("Llegó" y "Ausente" con la misma versión: gana una).
 *
 * Autorización: capability `agenda.reception` (OWNER, ADMIN, PRACTITIONER,
 * ASSISTANT; no BILLING). DECISIÓN B4.1: la recepción es ADMINISTRATIVA, así
 * que NO exige acceso `full` al paciente (a diferencia de `setBookingStatus`):
 * la Secretaria (ASSISTANT) tiene acceso básico a casi todos los pacientes y
 * su trabajo es justamente marcar llegadas y ausentes. No expone ni toca
 * contenido clínico; el turno tiene que ser del tenant (IDOR) y guest ok.
 * Revisión de B-pre: sin `agenda.manageBlocks` (= PRACTITIONER, el rol que no
 * opera la agenda de todos) solo sus turnos o los de pacientes con acceso
 * `full` (guest ok): si no, un profesional podía marcar ausente a pacientes
 * de un colega que ni ve. La Secretaria y el admin siguen operando todo.
 * "Atendido"/"Ausente" escriben `status` (COMPLETED / NO_SHOW) igual que el
 * drawer; deshacer vuelve al status de origen (`undoStatus`: PENDING para
 * guest y reserva pública impaga, CONFIRMED el resto). `expectedUpdatedAt`
 * es obligatorio.
 *
 * Devuelve el `updatedAt` nuevo (ISO) para el próximo click sin refetch.
 */
export async function markReceptionAction(
  bookingId: string,
  action: ReceptionAction,
  expectedUpdatedAt: string
): Promise<ActionResult<ReceptionActionResult>> {
  let actor: Actor;
  let caps: ReadonlySet<Capability>;
  try {
    ({ actor, caps } = await requireCapability("agenda.reception", RECEPTION_FORBIDDEN_ERROR));
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = ReceptionActionInput.safeParse({ bookingId, action, expectedUpdatedAt });
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const expected = new Date(input.expectedUpdatedAt);
  const now = new Date();

  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.booking.findFirst({
      where: { id: input.bookingId, tenantId: actor.tenantId },
      select: {
        id: true,
        scheduledFor: true,
        durationMin: true,
        status: true,
        arrivedAt: true,
        // SV05: sin `calledAt` la fila llamada se derivaba «en-sala»: Llamar dos
        // veces pasaba y Deshacer desde llamado borraba también la llegada.
        calledAt: true,
        attendingAt: true,
        updatedAt: true,
        patientId: true,
        practitionerId: true,
        // `undoStatus`: guest / reserva pública impaga vuelven a PENDING.
        paymentStatus: true,
        idempotencyKey: true,
        patient: { select: { firstName: true, lastName: true } },
        // SR: sala para el `BookingChangeRef` (escalar, misma sentencia).
        roomId: true,
        // S12 (C4): vínculo con el plan (escalares: sin sentencia extra).
        sessionId: true,
        pricedByPlan: true,
      },
    });
    if (!row) return { kind: "notfound" as const };
    if (
      !caps.has("agenda.manageBlocks") &&
      row.practitionerId !== actor.practitionerId &&
      !(await hasFullAccess(actor, row.patientId, tx))
    ) {
      return { kind: "forbidden" as const };
    }
    if (+row.updatedAt !== +expected) return { kind: "stale" as const };
    const t = applyReceptionAction(row, input.action, now);
    if (!t.ok) return { kind: "invalid" as const, error: t.error };
    // S12 (C4): "Deshacer Ausente" de un turno de plan es una reactivación
    // (NO_SHOW → activo): mismas reglas que el drawer, con Booking → Session
    // lockeados antes de escribir.
    const finalStatus = t.patch.status ?? row.status;
    const reactivating = !!row.sessionId && !activeForSession(row.status) && activeForSession(finalStatus);
    let stamp: PlanReactivationStamp | null = null;
    if (reactivating) {
      const r = await lockPlanReactivationInTx(tx, {
        tenantId: actor.tenantId,
        bookingId: row.id,
        sessionId: row.sessionId!,
        expectedUpdatedAt: row.updatedAt,
        pricedByPlan: row.pricedByPlan,
      });
      if (r.kind === "stale") return { kind: "stale" as const };
      if (r.kind === "plan-session-not-pending") return { kind: "not-pending" as const, ordinal: r.ordinal };
      stamp = r.stamp;
    }
    const after = await tx.booking.update({
      where: { id: row.id, tenantId: actor.tenantId, updatedAt: row.updatedAt },
      data: { ...t.patch, ...planStampData(stamp) },
      select: { updatedAt: true, status: true, arrivedAt: true, calledAt: true, attendingAt: true },
    });
    // "Atendido" cierra la sesión (solo `completedAt`); "Deshacer Atendido" la
    // reabre si está untouched; "Deshacer Ausente" re-alinea la fecha (I3).
    const plan: PlanSyncResult | null = row.sessionId
      ? await syncPlanSessionAfterBookingWriteInTx(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId ?? null,
          sessionId: row.sessionId,
          beforeStatus: row.status,
          finalStatus,
          writeThroughAt: reactivating ? row.scheduledFor : null,
          now,
        })
      : null;
    return { kind: "ok" as const, row, transition: t, after, plan };
  }).catch(async (e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return { kind: "stale" as const };
    }
    // S12 (C4): "Deshacer Ausente" con otro turno activo en la sesión pisa
    // `Booking_session_active_key` (I2). Antes era un 500.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const r = await resolveBookingUpdateUniqueViolation(actor.tenantId, input.bookingId);
      return r.kind === "plan-session-taken"
        ? { kind: "taken" as const, ordinal: r.ordinal }
        : { kind: "invalid" as const, error: UPDATE_SAME_INSTANT_ERROR };
    }
    throw e;
  });

  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "forbidden") return { ok: false, error: RECEPTION_OTHER_PRACTITIONER_ERROR };
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "invalid") return { ok: false, error: outcome.error };
  if (outcome.kind === "not-pending") return { ok: false, error: PLAN_SESSION_NOT_PENDING_ERROR(outcome.ordinal) };
  if (outcome.kind === "taken") return { ok: false, error: PLAN_SESSION_TAKEN_ERROR(outcome.ordinal) };

  const { row, transition, after, plan } = outcome;
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: `booking.reception.${input.action}`,
    entity: "Booking",
    entityId: row.id,
    payload: { from: transition.from, to: transition.to, label: RECEPTION_ACTION_LABEL[input.action] },
  });
  // Paridad con el drawer (`updateBooking`): un "Ausente" sale en la campana.
  if (transition.patch.status === "NO_SHOW" && actor.userId) {
    await notify({
      tenantId: actor.tenantId,
      userId: actor.userId,
      kind: NotificationKind.BOOKING_CANCELLED,
      title: `Ausente · ${row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : "Reserva externa"}`,
      body: row.scheduledFor.toLocaleString("es-AR", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "America/Argentina/Buenos_Aires",
      }),
      link: `/agenda?date=${toARDateKey(row.scheduledFor)}`,
    });
  }
  revalidatePath("/agenda");
  if (transition.patch.status) {
    // El estado (atendido/ausente) cuenta en el dashboard y en la ficha.
    revalidatePath("/dashboard");
    if (row.patientId) revalidatePath(`/pacientes/${row.patientId}`);
  }
  // Enmienda Realtime: TODA acción OK de recepción emite (SV muestra "llegó" /
  // "en atención" en la sala de espera), pero los caches derivados (puntos de
  // la agenda, KPIs) solo cambian con el estado, como antes. SV05: «Llamar»
  // sale como `kind:"called"` (el cliente anuncia «Pase …» con la sala); el
  // resto, Deshacer de un llamado incluido, es `reception`.
  await afterBookingsCommitted(
    actor.tenantId,
    [
      {
        bookingId: row.id,
        practitionerId: row.practitionerId,
        scheduledFor: row.scheduledFor,
        kind: input.action === "llamar" ? "called" : "reception",
        roomId: row.roomId,
      },
    ],
    { invalidateCaches: !!transition.patch.status }
  );
  if (plan?.discharge) await notifyPlanNearingDischarge(actor.tenantId, plan.discharge, actor.userId ?? null);
  return {
    ok: true,
    data: {
      updatedAt: after.updatedAt.toISOString(),
      status: after.status,
      arrivedAt: after.arrivedAt?.toISOString() ?? null,
      calledAt: after.calledAt?.toISOString() ?? null,
      attendingAt: after.attendingAt?.toISOString() ?? null,
      state: transition.to,
      ...(plan?.sessionKeptDone ? { notice: SESSION_KEPT_DONE_NOTICE } : {}),
    },
  };
}

export async function deleteBooking(
  id: string,
  expectedUpdatedAt?: string
): Promise<ActionResult> {
  const actor = await getActor();
  // RLS Etapa 2: lookup + delete share the tx so policies guard the
  // destructive side too. The optimistic-concurrency check rejects a delete
  // when the row changed since the client loaded it.
  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: {
        id: true,
        patientId: true,
        updatedAt: true,
        paymentStatus: true,
        insurerPaidAt: true,
        payment: { select: { status: true } },
        // Para el `BookingChangeRef` post-commit (misma sentencia, sin round-trip).
        practitionerId: true,
        scheduledFor: true,
        programId: true,
        roomId: true, // SR: sala del ref (escalar)
      },
    });
    if (!row) return { kind: "notfound" as const };
    if (expectedUpdatedAt && +row.updatedAt !== +new Date(expectedUpdatedAt)) {
      return { kind: "stale" as const };
    }
    if (!(await hasFullAccess(actor, row.patientId, tx))) return { kind: "basic" as const };
    // S12 (C4, I7): un turno de plan no se borra en duro (la FK de la sesión
    // es RESTRICT y el turno es historia de la sesión): se cancela y la
    // sesión queda "sin turno". Después del gate: quien no opera el turno no
    // se entera de que es de un plan.
    if (row.programId) return { kind: "plan-delete" as const };
    // Payment FK is onDelete: Restrict, so a paid turno can't be silently
    // wiped. Refuse the delete if a real payment is attached; for an
    // abandoned checkout (UNPAID/FAILED) clean up the orphan payment first
    // so the Restrict constraint is satisfied.
    const pay = row.payment;
    if (pay && (pay.status === "AUTHORIZED" || pay.status === "PAID" || pay.status === "REFUNDED")) {
      return { kind: "has-payment" as const };
    }
    // H1: a copago collected BY HAND (Facturación toggle → paymentStatus, no
    // Payment row) or a confirmed obra social payment (insurerPaidAt) is a
    // money record too. Deleting the turno used to erase it with no trace.
    if (
      row.paymentStatus === "PAID" ||
      row.paymentStatus === "AUTHORIZED" ||
      row.paymentStatus === "REFUNDED" ||
      row.insurerPaidAt != null
    ) {
      return { kind: "has-billing" as const };
    }
    if (pay) {
      await tx.payment.delete({ where: { bookingId: id } });
    }
    // `updatedAt` in the where: a concurrent edit → P2025 → rollback (the
    // orphan-payment cleanup above too) → "stale".
    await tx.booking.delete({ where: { id, tenantId: actor.tenantId, updatedAt: row.updatedAt } });
    const ref: BookingChangeRef = {
      bookingId: row.id,
      practitionerId: row.practitionerId,
      scheduledFor: row.scheduledFor,
      kind: "booking",
      roomId: row.roomId,
    };
    return { kind: "ok" as const, patientId: row.patientId, ref };
  }).catch((e) => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return { kind: "stale" as const };
    }
    throw e;
  });
  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  if (outcome.kind === "plan-delete") return { ok: false, error: PLAN_DELETE_ERROR };
  if (outcome.kind === "has-payment") {
    return {
      ok: false,
      error: "Este turno tiene un pago registrado. Cancelalo en vez de eliminarlo para conservar el comprobante.",
    };
  }
  if (outcome.kind === "has-billing") {
    return {
      ok: false,
      error: "Este turno tiene un cobro registrado (copago u OS): cancelalo en vez de eliminarlo.",
    };
  }
  const owned = { patientId: outcome.patientId };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.delete",
    entity: "Booking",
    entityId: id,
  });
  revalidatePath("/agenda");
  if (owned.patientId) revalidatePath(`/pacientes/${owned.patientId}`);
  await afterBookingsCommitted(actor.tenantId, [outcome.ref]);
  return { ok: true, data: undefined };
}

/**
 * Shared body of the two Facturación toggles (A2a-S06). Before: lookup and
 * update in two separate transactions, `where: { id }` only on the write, no
 * optimistic lock and no access check — a second quick toggle (or another
 * tab) silently overwrote the first, and a basic-access kine could mark a
 * foreign patient's copago as cobrado. Now: one transaction, tenant-scoped
 * write guarded by `updatedAt`, and the new `updatedAt` goes back to the
 * client so its next toggle isn't stale.
 */
async function toggleBilling(
  id: string,
  data: Prisma.BookingUpdateManyMutationInput,
  expectedUpdatedAt: string | undefined,
  action: string,
  opts: { freezeCopago?: boolean } = {}
): Promise<ActionResult<{ updatedAt: Date; notice?: string }>> {
  const actor = await getActor();
  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      // practitionerId/scheduledFor: para el `BookingChangeRef` post-commit.
      // copagoCents/serviceId: Q8 (escalares, sin sentencia extra).
      select: {
        id: true,
        patientId: true,
        updatedAt: true,
        practitionerId: true,
        scheduledFor: true,
        copagoCents: true,
        serviceId: true,
        // P2-Z · B-M3: cobro previo de un turno de plan cancelado/ausente.
        status: true,
        sessionId: true,
        // P3.Z: re-marcar un copago ya PAID no mueve `copagoPaidAt`.
        paymentStatus: true,
        // P3.Z: idem `insurerPaidAt` (la OS se cuenta por esa fecha).
        insurerPaidAt: true,
        roomId: true, // SR: sala del ref (escalar)
      },
    });
    if (!row) return { kind: "notfound" as const };
    if (expectedUpdatedAt && +row.updatedAt !== +new Date(expectedUpdatedAt)) {
      return { kind: "stale" as const };
    }
    if (!(await hasFullAccess(actor, row.patientId, tx))) return { kind: "basic" as const };
    // P2-Z · B-M3: marcar/desmarcar el cobro de un turno de plan CANCELLED o
    // NO_SHOW cambia si la cuota de su sesión "ya se pagó" (cobro previo,
    // `priorPaidStamp`). El turno que la reemplaza tiene que acompañar en la
    // MISMA tx: si no, desmarcar dejaba el reemplazo en $0 para siempre y
    // marcar después de estampar a precio pleno cobraba la sesión dos veces.
    // Lock del paciente PRIMERO (C2: va antes que cualquier fila; la lectura
    // de arriba no lockea) — serializa con el reprecio y el motor, que deciden
    // la plata de la misma sesión. Los turnos activos o sueltos no pagan nada.
    const planPrior = row.sessionId != null && row.patientId != null && (row.status === "CANCELLED" || row.status === "NO_SHOW");
    if (planPrior) await lockPlanPatient(tx, { tenantId: actor.tenantId, patientId: row.patientId! });
    // Q8 (C5, cierra parcialmente AUDIT:940): un turno fuera de plan sin copago
    // propio (`copagoCents` null) se COBRA por el copago resuelto en lectura
    // (precedencia §5.5 de lib/copago.ts, la misma que la agenda). Si no se
    // congela, cambiar después la cobertura o el precio del servicio cambiaba
    // retroactivamente cuánto "se cobró". Un turno de plan nunca entra acá
    // (`pricedByPlan` ⇒ copago no nulo, CHECK). Solo al marcar cobrado.
    let frozen: { copagoCents: number } | null = null;
    if (opts.freezeCopago && row.copagoCents == null) {
      const [coverage, particularCopago, service] = await Promise.all([
        row.patientId
          ? tx.coverage.findFirst({
              where: { patientId: row.patientId, patient: { tenantId: actor.tenantId } },
              orderBy: { id: "desc" },
              select: { insurer: true, copagoCents: true, insurerRef: { select: { copagoCents: true } } },
            })
          : Promise.resolve(null),
        getParticularCopagoCents(actor.tenantId, tx),
        tx.service.findFirst({ where: { id: row.serviceId, tenantId: actor.tenantId }, select: { priceCents: true } }),
      ]);
      frozen = {
        copagoCents: resolveBookingCopagoCents({
          bookingOverride: null,
          coverageOverride: coverage?.copagoCents ?? null,
          hasCoverage: !!coverage,
          insurerCopago: coverage?.insurerRef ? coverage.insurerRef.copagoCents : null,
          particularCopago,
          servicePriceCents: service?.priceCents ?? 0,
        }),
      };
    }
    // P3.Z (revisor b · B1): `copagoPaidAt` es la fecha con la que el widget
    // de ingresos cuenta el cobro en la semana/mes. Si el turno YA estaba PAID,
    // re-marcarlo (otra pestaña, la Facturación agrupada, un doble click con el
    // `updatedAt` nuevo) la reescribía con `new Date()` y el cobro se mudaba de
    // mes. Ya PAID → no se toca (tampoco si quedó null de antes de M3a: no
    // se le inventa una fecha). Desmarcar la sigue limpiando.
    const write: Prisma.BookingUpdateManyMutationInput = { ...data };
    if (data.paymentStatus === "PAID" && row.paymentStatus === "PAID") delete write.copagoPaidAt;
    // Mismo bug en la OS (hallazgo de F1): el widget cuenta lo que pagó la obra
    // social por `insurerPaidAt`. Re-marcar una OS ya cobrada no la muda de mes.
    // Se reescribe la MISMA fecha (no se borra la clave): un `updateMany` sin
    // datos devuelve count 0 y se leería como stale.
    if (data.insurerPaidAt instanceof Date && row.insurerPaidAt != null) write.insurerPaidAt = row.insurerPaidAt;
    const res = await tx.booking.updateMany({
      // El CAS por `updatedAt` ata la decisión de arriba a ESTA versión de la fila.
      where: { id, tenantId: actor.tenantId, updatedAt: row.updatedAt },
      data: { ...write, ...(frozen ?? {}) },
    });
    if (res.count === 0) return { kind: "stale" as const };
    const after = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { updatedAt: true },
    });
    const refs: BookingChangeRef[] = [
      { bookingId: row.id, practitionerId: row.practitionerId, scheduledFor: row.scheduledFor, kind: "booking", roomId: row.roomId },
    ];
    const sync = planPrior ? await syncPriorPaidReplacementInTx(tx, actor.tenantId, row.sessionId!, new Date()) : null;
    if (sync?.ref) refs.push(sync.ref);
    return { kind: "ok" as const, patientId: row.patientId, updatedAt: after!.updatedAt, refs, notice: sync?.notice ?? null };
  }).catch((e) => {
    if (e instanceof BillingReplacementStale) return { kind: "stale" as const };
    throw e;
  });
  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action,
    entity: "Booking",
    entityId: id,
  });
  if (outcome.patientId) revalidatePath(`/pacientes/${outcome.patientId}`);
  await afterBookingsCommitted(actor.tenantId, outcome.refs);
  return { ok: true, data: { updatedAt: outcome.updatedAt, ...(outcome.notice ? { notice: outcome.notice } : {}) } };
}

/** El reemplazo cambió entre la lectura y el CAS: rollback de TODO el toggle (C5: conteo esperado o nada). */
class BillingReplacementStale extends Error {}

const ddmm = (d: Date) => {
  const k = toARDateKey(d); // YYYY-MM-DD en hora AR
  return `${k.slice(8, 10)}/${k.slice(5, 7)}`;
};

/**
 * P2-Z · B-M3. Después de marcar/desmarcar el cobro de un turno previo
 * (CANCELLED/NO_SHOW) de la sesión, recalcula `priorPaidStamp` y lo aplica al
 * turno ACTIVO de esa sesión si todavía es "estampable" — el mismo criterio
 * que la reactivación (`lockPlanReactivationInTx`) y el reprecio:
 * PENDING/CONFIRMED, `pricedByPlan` (I8: acá nunca se escribe
 * `pricedByPlan=true`, solo copago o el desestampado), UNPAID sin plata
 * (`bookingHasMoney`, con el `Payment` de MP) y futuro. Si no lo es (ya se
 * cobró, se realizó, pasó o tiene copago manual), la plata de ese turno no se
 * toca y se avisa para que lo revisen a mano. Sin cambio necesario, no hace
 * nada. CAS del copago sobre `updatedAt` + los valores leídos; si no pega,
 * rollback completo (el caller lo traduce a stale).
 *
 * Corre sin gate de módulo: es consistencia de datos (misma decisión que la
 * sincronía turno↔sesión de S12).
 */
async function syncPriorPaidReplacementInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sessionId: string,
  now: Date
): Promise<{ ref: BookingChangeRef | null; notice: string } | null> {
  const session = await tx.session.findFirst({
    where: { id: sessionId, program: { tenantId } },
    select: {
      priceCents: true,
      bookings: {
        where: { tenantId },
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          insurerPaidAt: true,
          copagoCents: true,
          pricedByPlan: true,
          scheduledFor: true,
          updatedAt: true,
          practitionerId: true,
          roomId: true,
          payment: { select: { status: true } },
        },
      },
    },
  });
  if (!session) return null;
  const active = session.bookings.find((b) => b.status === "PENDING" || b.status === "CONFIRMED" || b.status === "COMPLETED");
  if (!active) return null; // sin reemplazo: el próximo turno se estampa con el cobro previo (motor)
  const stamp = priorPaidStamp({ priceCents: session.priceCents }, session.bookings);
  if (active.copagoCents === stamp.copagoCents && active.pricedByPlan === stamp.pricedByPlan) return null;

  const when = ddmm(active.scheduledFor);
  const stampable =
    active.pricedByPlan &&
    (active.status === "PENDING" || active.status === "CONFIRMED") &&
    active.paymentStatus === "UNPAID" &&
    !bookingHasMoney(active) &&
    active.scheduledFor.getTime() > now.getTime();
  if (!stampable) {
    return {
      ref: null,
      notice: stamp.priorPaid
        ? `La sesión ya quedó paga con este turno, pero el turno del ${when} no se puede ajustar (ya está cobrado, realizado o pasó): revisá su cobro a mano.`
        : `La sesión ya no tiene un pago previo, pero el turno del ${when} no se puede ajustar (ya está cobrado, realizado o pasó): revisá su cobro a mano.`,
    };
  }
  const res = await tx.booking.updateMany({
    where: {
      id: active.id,
      tenantId,
      updatedAt: active.updatedAt,
      status: active.status,
      paymentStatus: "UNPAID",
      insurerPaidAt: null,
      pricedByPlan: true,
      copagoCents: active.copagoCents,
    },
    data: planStampData({ copagoCents: stamp.copagoCents, pricedByPlan: stamp.pricedByPlan }) as Prisma.BookingUpdateManyMutationInput,
  });
  if (res.count !== 1) throw new BillingReplacementStale();
  return {
    ref: {
      bookingId: active.id,
      practitionerId: active.practitionerId,
      scheduledFor: active.scheduledFor,
      kind: "booking",
      roomId: active.roomId,
    },
    notice: stamp.priorPaid
      ? `La sesión ya quedó paga con este turno: el turno del ${when} pasa a ${formatARS(0)}.`
      : stamp.copagoCents != null
        ? `La sesión ya no tiene un pago previo: el turno del ${when} vuelve a la cuota del plan (${formatARS(stamp.copagoCents)}).`
        : `La sesión ya no tiene un pago previo: el turno del ${when} vuelve a quedar sin precio del plan.`,
  };
}

/**
 * Confirm / un-confirm that the obra social reimbursement for a turno was
 * received. Backs the "Confirmar pago Obra social" action in the patient's
 * Facturación tab. Tenant-scoped; `paid=false` clears the confirmation.
 * `expectedUpdatedAt` is optional only for legacy callers; the Facturación
 * tab always sends it and patches the returned `updatedAt`.
 */
export async function setBookingInsurerPaid(
  id: string,
  paid: boolean,
  expectedUpdatedAt?: string
): Promise<ActionResult<{ updatedAt: Date; notice?: string }>> {
  return toggleBilling(
    id,
    { insurerPaidAt: paid ? new Date() : null },
    expectedUpdatedAt,
    paid ? "booking.insurer_paid" : "booking.insurer_unpaid"
  );
}

/**
 * Mark a turno's copago as collected / pending (in-person payments) by
 * flipping `Booking.paymentStatus` between PAID and UNPAID. Complements the
 * OS confirmation so the Facturación tab tracks both sides. Same lock
 * contract as `setBookingInsurerPaid`.
 *
 * S14r (M3a): `copagoPaidAt` = cuándo se marcó cobrado. Es la fecha con la que
 * el widget de ingresos del dashboard cuenta el copago en la semana/mes (antes
 * solo contaba MP: el cobro en mano no aparecía). Desmarcar la limpia, así el
 * cobro deja de contar en el período. Va en el mismo `updateMany` con CAS que
 * el `paymentStatus` (y la re-sincronización del cobro previo de P2-Z sigue
 * igual en `toggleBilling`): o cambian los dos o ninguno. Re-marcar uno que ya
 * estaba PAID no mueve la fecha (P3.Z, en `toggleBilling`).
 */
export async function setBookingCopagoPaid(
  id: string,
  paid: boolean,
  expectedUpdatedAt?: string
): Promise<ActionResult<{ updatedAt: Date; notice?: string }>> {
  return toggleBilling(
    id,
    { paymentStatus: paid ? "PAID" : "UNPAID", copagoPaidAt: paid ? new Date() : null },
    expectedUpdatedAt,
    paid ? "booking.copago_paid" : "booking.copago_unpaid",
    { freezeCopago: paid }
  );
}

/**
 * Multi-turno batch — creates N INDIVIDUAL bookings (turnos) on the chosen
 * weekdays, in Argentina time. NO TreatmentProgram/Session is created: these
 * are plain turnos. A future "plan" entity can regroup a batch via the shared
 * `seriesId` we stamp on every row.
 *
 * Model: the practitioner picks an anchor date+time (the slot time + where to
 * start), a set of weekdays (`daysOfWeek`, 0=Mon…6=Sun), and `count` (how many
 * turnos). We walk forward day-by-day from the anchor and emit a turno on each
 * matching weekday until we have `count` candidate dates. Example: anchor on a
 * Wednesday, count=3, days={Thu,Fri,Tue} → next Thu, Fri, Tue (Wed excluded).
 *
 * Day-of-week is read with `toARDow` (AR-local, correct on any host); the
 * +24h step preserves the AR wall-clock because Argentina has no DST. This
 * replaces the old createBookingSeries, which used UTC weekday math and put
 * turnos on the wrong days / next month.
 */
// `BatchSlotStatus` vive en lib/booking-schedule.ts (B1.6 S07); se re-exporta
// acá para no romper `import type { … } from "@/lib/bookings"` (solo tipo: un
// archivo "use server" no puede exportar valores que no sean funciones async).
export type { BatchSlotStatus } from "@/lib/booking-schedule";

/** Sala del preflight del batch (validada: activa, de una sede activa, del tenant). */
type RoomInfoRow = { id: string; locationId: string; capacity: number; name: string };

export type BatchOutcome = {
  /** True when nothing was written (preflight). */
  dryRun: boolean;
  requested: number;
  /** B3.1: cada fecha trae además `outOfHours` / `blocked` (flags, no
   *  cambian `status` ni los conteos; un bloqueo ya sube el status a
   *  "sobreturno"). */
  dates: BatchDateOutcome[];
  free: number;
  conflicted: number;
  duplicates: number;
  /** Rows actually written (0 on a dry run). */
  created: number;
  /** How many of `created` were forced through as sobreturno. */
  sobreturnos: number;
  /** Conflicting slots deliberately left out (allowOverbooking = false). */
  omitted: number;
};

/**
 * Multi-turno batch with a PREFLIGHT mode.
 *
 * `dryRun: true` classifies every date without writing, so the UI can warn
 * ("3 de 10 caen como sobreturno") and let the user choose. Then:
 *   · `allowOverbooking: true`  → creates everything, tagging the conflicting
 *     rows `[SOBRETURNO]` + `isOverbooked` like the single-create path does.
 *   · `allowOverbooking: false` → creates only the free slots (an explicit
 *     choice now, not the silent skip it used to be).
 * `duplicado` slots are never creatable and are always reported separately.
 *
 * B3.1: fechas con `expandDates` del motor (`frequency` weekly — default,
 * paridad exacta con la expansión de antes, tope de 58 incluido — biweekly o
 * monthly) y clasificación con `classifyBatchInstant` (mismo status que
 * `classifyBatchSlot` sin bloqueos; un bloqueo lo sube a "sobreturno";
 * fuera de horario es solo el flag `outOfHours`, decisión 2). `count` validado
 * con zod (antes un NaN reventaba).
 */
export async function createBookingsBatch(
  raw: BookingBatchCreateInput & {
    idempotencyKey?: string;
    dryRun?: boolean;
    allowOverbooking?: boolean;
    // SR (SR-D7): escribir también las fechas con la sala llena u ocupada
    // (`BatchDateOutcome.roomBusy`). No es sobreturno (SR-D2).
    allowRoomConflict?: boolean;
  }
): Promise<ActionResult<BatchOutcome>> {
  const actor = await getActor();
  const parsed = BookingBatchCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;
  const { count } = data;
  // Ids de entrada validados contra el tenant ANTES de escribir (A2a-S06): el
  // paciente solo se usaba para leer el diagnóstico — si era de otro tenant la
  // lectura daba null y el batch creaba igual N turnos apuntando a él (las FK
  // saltean RLS). Mismo contrato que createBooking: profesional del tenant y
  // paciente con acceso `full`. Un dryRun también se rechaza: el preflight
  // expone la ocupación del paciente. B3.1: + sede elegida y servicio
  // habilitado para el profesional (mismo rechazo que createBooking).
  const pre = await runWithRls(actor.tenantId, (tx) => validateBookingRefsInTx(tx, actor, data));
  if (pre.kind !== "ok") return { ok: false, error: bookingRefsError(pre) };
  const { service, rule, gate } = pre;
  const duration = data.durationMin ?? rule.durationMin;
  // E1 (S07sb): mismas reglas que createBooking — campos que el actor no lee
  // fuera, y su copago solo con full (si no, precedencia de lib/copago.ts).
  const own = writableFields(data, gate.fields);
  const copagoCents = gate.full ? (data.copagoCents ?? null) : null;

  // Diagnóstico por defecto del paciente para auto-completar title/description
  // de cada turno del batch cuando el caller no los envía.
  const patientDiag = pre.patient;
  const title = own.title ?? patientDiag?.diagnosisTitle ?? null;
  const description = own.description ?? patientDiag?.diagnosisNote ?? null;
  const isTelemedicine = data.isTelemedicine ?? false;
  const telemedicineUrl = isTelemedicine ? (data.telemedicineUrl ?? null) : null;

  // AR-correct date expansion. `data.scheduledFor` is a real instant tagged
  // -03:00 by `localToARIso` on the client. Empty weekday selection → repeat
  // on the anchor's own AR weekday. count ≥ 1 (zod) → al menos una fecha.
  const dates = expandDates({
    anchor: data.scheduledFor,
    count,
    daysOfWeek: data.daysOfWeek,
    frequency: data.frequency,
  });

  // Tag the batch so it can be regrouped into a "plan" later.
  const seriesId = randomBytes(12).toString("hex");
  // Per-slot idempotency base. Prefer the client's stable key (so a
  // double-submitted batch converges to the same turnos instead of
  // duplicating), else the fresh seriesId. Either way it's SCOPED to this
  // batch — it can never collide with a pre-existing single turno's key (the
  // old `tenant:prof:slot:patient` shape did, silently mapping onto it).
  const keyBase = acceptClientKey(raw.idempotencyKey) ?? seriesId;

  // Una carga para todo el rango (loader del motor): franjas, excepciones,
  // bloqueos y los turnos que pueden chocar — del profesional (cupo) o del
  // paciente (solape propio / duplicado), con 240 min hacia atrás.
  const last = dates[dates.length - 1];
  const now = new Date();
  // SR (SR-D7): la sala de cada fecha (la elegida o la de la franja de ESE
  // día, en la sede de esa fecha) y su ocupación en el preflight. Va en la
  // MISMA tx que el loader (la sala por defecto sale de sus franjas): sin sala,
  // 0 sentencias y 0 transacciones nuevas (techo estricto del batch). Con sala:
  // 1 query de salas (validación + capacidad + nombre) y UNA carga por sala
  // distinta (`loadRoomBookingsInTx`, todas las fechas), porque el loader solo
  // trae los turnos de ESTE profesional y la sala la ocupan otros.
  const loaded = await runWithRls(actor.tenantId, async (tx) => {
    const input = await loadAvailabilityInputs(tx, {
      tenantId: actor.tenantId,
      practitionerIds: [data.practitionerId],
      serviceId: service.id,
      patientId: data.patientId,
      from: dayKeyOf(dates[0]),
      to: dayKeyOf(new Date(last.getTime() + duration * 60_000 - 1)),
    });
    const perDate = dates.map((when) => {
      const locationId = data.locationId ?? defaultLocationFor(input, data.practitionerId, when, duration);
      const roomId =
        data.roomId === undefined ? defaultRoomFor(input, data.practitionerId, when, duration, locationId) : data.roomId;
      // SR-D6: con sala, la sede explícita (null = la principal del loader).
      return { when, locationId, roomId, roomLocationId: roomId ? (locationId ?? input.primaryLocationId) : null };
    });
    const roomIds = [...new Set(perDate.map((p) => p.roomId).filter((id): id is string => !!id))];
    if (roomIds.length === 0) return { input, perDate, rooms: new Map<string, RoomInfoRow>(), occupancy: null };
    const rooms = new Map<string, RoomInfoRow>(
      (
        await tx.room.findMany({
          where: { tenantId: actor.tenantId, id: { in: roomIds }, active: true, location: { active: true, tenantId: actor.tenantId } },
          select: { id: true, locationId: true, capacity: true, name: true },
        })
      ).map((r) => [r.id, r])
    );
    // Sala elegida inválida (ajena, archivada, o de otra sede que la de alguna
    // fecha) → todo el batch rechazado, también el preflight: mismo contrato
    // que el alta suelta (BAD_ROOM_ERROR, nada escrito).
    if (typeof data.roomId === "string") {
      const r = rooms.get(data.roomId);
      if (!r || perDate.some((p) => p.roomLocationId !== r.locationId)) return { badRoom: true as const };
    }
    const occupancy = new Map<string, Awaited<ReturnType<typeof loadRoomBookingsInTx>>>();
    const lastEnd = new Date(last.getTime() + duration * 60_000);
    for (const id of roomIds) {
      if (!rooms.has(id)) continue; // la por defecto archivada → sin sala (abajo)
      occupancy.set(id, await loadRoomBookingsInTx(tx, { tenantId: actor.tenantId, roomId: id, from: dates[0], to: lastEnd }));
    }
    return { input, perDate, rooms, occupancy };
  });
  if ("badRoom" in loaded) return { ok: false, error: BAD_ROOM_ERROR };
  const { input, rooms } = loaded;
  const rangesFor = rangesForInput(input);

  const plan = loaded.perDate.map(({ when, locationId, roomId: roomTarget, roomLocationId }) => {
    // Por defecto archivada (o de otra sede que la de la fecha) → sin sala.
    const room = roomTarget ? rooms.get(roomTarget) : undefined;
    const roomOk = !!room && room.locationId === roomLocationId;
    const occ =
      roomOk && loaded.occupancy
        ? roomOccupancyAt(
            loaded.occupancy.get(room!.id)!.bookings,
            {
              roomId: room!.id,
              practitionerId: data.practitionerId,
              when,
              durationMin: duration,
              capacity: room!.capacity,
              now,
            },
            loaded.occupancy.get(room!.id)!.blocks
          )
        : null;
    const c = classifyBatchInstant({
      when,
      durationMin: duration,
      patientId: data.patientId ?? null,
      practitionerId: data.practitionerId,
      serviceId: service.id,
      locationId: data.locationId ?? null,
      cap: rule.cap,
      rangesFor,
      blocks: input.blocks,
      bookings: input.bookings,
      now,
    });
    return {
      when,
      status: c.status,
      outOfHours: c.outOfHours,
      blocked: c.blocked,
      locationId,
      room: roomOk ? room! : null,
      roomLocationId: roomOk ? roomLocationId : null,
      roomBusy: !!occ?.atCapacity,
    };
  });
  const free = plan.filter((p) => p.status === "libre").length;
  const conflicted = plan.filter((p) => p.status === "sobreturno").length;
  const duplicates = plan.filter((p) => p.status === "duplicado").length;
  const datesOut: BatchDateOutcome[] = plan.map((p) => ({
    iso: p.when.toISOString(),
    status: p.status,
    outOfHours: p.outOfHours,
    blocked: p.blocked,
    // SR-D7: flag como `blocked` (no cambia status ni conteos). Solo presente
    // cuando es true: sin salas, la forma de la respuesta no cambia.
    ...(p.roomBusy ? { roomBusy: true } : {}),
  }));

  if (raw.dryRun) {
    return {
      ok: true,
      data: {
        dryRun: true,
        requested: count,
        dates: datesOut,
        free,
        conflicted,
        duplicates,
        created: 0,
        sobreturnos: 0,
        omitted: 0,
      },
    };
  }

  let created = 0;
  let sobreturnos = 0;
  let omitted = 0;
  let duplicatesHit = duplicates;
  // Turnos que ESTA corrida escribió, para `afterBookingsCommitted` al final
  // (una vez, fuera de las tx por fecha).
  const refs: BookingChangeRef[] = [];

  for (const slot of plan) {
    const { when } = slot;
    // Never creatable — the DB index would reject it anyway.
    if (slot.status === "duplicado") continue;
    // Conflicting slot the caller chose NOT to force.
    if (slot.status === "sobreturno" && !raw.allowOverbooking) {
      omitted++;
      continue;
    }
    // SR-D7: sala llena u ocupada en el preflight y sin forzar → se omite.
    if (slot.roomBusy && !raw.allowRoomConflict) {
      omitted++;
      continue;
    }
    const idempotencyKey = `${keyBase}:${when.toISOString()}`;
    const end = new Date(when.getTime() + duration * 60_000);
    const roomCheck = !!slot.room && !raw.allowRoomConflict;
    try {
      // Una tx por fecha (un P2002 aborta la tx entera; así cada fecha se
      // resuelve sola, como antes). B3.1 (TOCTOU): dentro, lock de cupo de los
      // días de ESTA fecha (en orden) y re-conteo: si entre el preflight y acá
      // alguien llenó el cupo, la fecha pasa a sobreturno (forzada solo con
      // allowOverbooking; si no, se omite).
      const w = await runWithRls(actor.tenantId, async (tx) => {
        const capWindow = {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          start: when,
          end,
        };
        if (roomCheck) {
          // SR, C2 (1b): cupo + sala de ESTA fecha en una sentencia (= mismo
          // número de statements que `lockCapacityWindow`).
          await lockCapacityAndRoomsMany(
            tx,
            capacityKeysForWindow(capWindow),
            roomKeysForWindow({ tenantId: actor.tenantId, roomId: slot.room!.id, start: when, end })
          );
        } else {
          await lockCapacityWindow(tx, capWindow);
        }
        // Integrador final de B-pre: re-chequeo de bloqueos con el lock tomado
        // (`liveBlocksInTx`): un candado commiteado después del preflight
        // vuelve la fecha sobreturno (= omitida sin allowOverbooking), igual
        // que si el preflight la hubiera visto bloqueada.
        const liveBlocked = classifyBatchInstant({
          when,
          durationMin: duration,
          patientId: null,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          locationId: data.locationId ?? null,
          cap: rule.cap,
          rangesFor,
          blocks: await liveBlocksInTx(tx, {
            tenantId: actor.tenantId,
            practitionerId: data.practitionerId,
            start: when,
            end,
          }),
          bookings: [],
          now,
        }).blocked;
        const used = await countCapacityOverlaps(tx, {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          start: when,
          end,
          now,
          excludeKey: idempotencyKey,
        });
        const isOverbook = slot.status === "sobreturno" || liveBlocked || overlapBlocks(used, rule.cap);
        if (isOverbook && !raw.allowOverbooking) return { kind: "omitted" as const };
        // Sede: elegida o la de la franja de ese día; archivada en el medio →
        // la elegida omite la fecha, la de por defecto cae a null (= principal).
        let loc = slot.locationId;
        // SR: sala validada después del lock compartido de sedes (carrera con
        // `archiveRoom`); reemplaza a la validación de la sede. Archivada en el
        // medio: la elegida omite la fecha, la por defecto cae a "sin sala".
        let roomId: string | null = null;
        let room: { id: string; capacity: number } | null = null;
        if (slot.room && slot.roomLocationId) {
          await lockTenantLocationsShared(tx, actor.tenantId);
          room = await lockActiveRoomInTx(tx, {
            tenantId: actor.tenantId,
            roomId: slot.room.id,
            locationId: slot.roomLocationId,
          });
        }
        if (room) {
          roomId = room.id;
          loc = slot.roomLocationId;
        } else {
          if (slot.room && typeof data.roomId === "string") return { kind: "omitted" as const };
          if (loc && !(await lockActiveLocation(tx, actor.tenantId, loc))) {
            if (data.locationId) return { kind: "omitted" as const };
            loc = null;
          }
        }
        // SR-D7 (TOCTOU): re-conteo de la sala con la clave tomada; si alguien
        // la ocupó entre el preflight y acá, la fecha se omite sin forzar.
        if (room && roomCheck) {
          const occ = await countRoomOverlapsInTx(tx, {
            tenantId: actor.tenantId,
            roomId: room.id,
            practitionerId: data.practitionerId,
            start: when,
            end,
            now,
            capacity: room.capacity,
            excludeKey: idempotencyKey,
          });
          if (occ.atCapacity) return { kind: "omitted" as const };
        }
        // Same tagging the single-create path uses, so reports can tell them apart.
        const notes = isOverbook ? `[SOBRETURNO] ${own.notes ?? ""}`.trim() : own.notes;
        // `update: {}`: un reintento con la misma key converge a la fila que ya
        // existe sin pisarla. S07c: los mismos datos de fila que el alta simple.
        const row = await tx.booking.upsert({
          where: { idempotencyKey },
          update: {},
          create: buildBookingCreateData({
            tenantId: actor.tenantId,
            practitionerId: data.practitionerId,
            serviceId: service.id,
            scheduledFor: when,
            durationMin: duration,
            copagoCents,
            patientId: data.patientId,
            guestName: data.guestName,
            guestEmail: data.guestEmail,
            guestPhone: data.guestPhone,
            notes,
            isOverbooked: isOverbook,
            locationId: loc,
            roomId,
            isTelemedicine,
            telemedicineUrl,
            title,
            description,
            seriesId,
            idempotencyKey,
          }),
          select: { id: true, practitionerId: true, scheduledFor: true, roomId: true },
        });
        return { kind: "ok" as const, isOverbook, row };
      });
      if (w.kind === "omitted") {
        omitted++;
        continue;
      }
      created++;
      refs.push({
        bookingId: w.row.id,
        practitionerId: w.row.practitionerId,
        scheduledFor: w.row.scheduledFor,
        kind: "booking",
        roomId: w.row.roomId,
      });
      if (w.isOverbook) sobreturnos++;
    } catch (e) {
      // A patient+instant collision that the preflight missed (someone else
      // booked it in between) is a DUPLICATE, not a mystery failure — the old
      // catch-all lumped it into "omitidos por conflicto" with no explanation.
      // Same resolver as the single-create path, so it also works under RLS
      // (`meta.target` null) and a same-key concurrent double submit of the
      // batch counts the slot as created instead of duplicated.
      const r = await resolveUniqueViolation(actor.tenantId, e, idempotencyKey);
      if (r.kind === "existing") {
        created++;
        if (slot.status === "sobreturno") sobreturnos++;
        continue;
      }
      if (r.kind === "patient-slot") {
        duplicatesHit++;
        continue;
      }
      logger.error("createBookingsBatch: slot creation failed", {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        scheduledFor: when.toISOString(),
        err: e instanceof Error ? e.message : String(e),
      });
      omitted++;
    }
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "booking.batch.create",
    entity: "Booking",
    payload: {
      created,
      sobreturnos,
      omitted,
      duplicates: duplicatesHit,
      requested: count,
      frequency: data.frequency,
      seriesId,
    },
  });
  revalidatePath("/agenda");
  if (data.patientId) revalidatePath(`/pacientes/${data.patientId}`);
  // Como antes, se invalida aunque no se haya creado nada (refs vacío).
  await afterBookingsCommitted(actor.tenantId, refs);
  return {
    ok: true,
    data: {
      dryRun: false,
      requested: count,
      dates: datesOut,
      free,
      conflicted,
      duplicates: duplicatesHit,
      created,
      sobreturnos,
      omitted,
    },
  };
}
