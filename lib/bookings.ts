"use server";

/**
 * Booking domain — server-only queries + Server Actions used by the
 * Agenda calendar.
 *
 * `listAgendaBookings` es la proyección de la agenda; `listBookingsInRange` (completa, sin llamadores de
 * producción) queda para tests y perf, validada por `BookingsRangeQuery` (PV HD-1). Mutations are intentionally narrow: create, reschedule, change
 * status (confirm / cancel / mark no-show / complete).
 */
import { revalidatePath, unstable_cache } from "next/cache";
import { Prisma, type BookingStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { notify } from "@/lib/notifications-internal";
import { getParticularCopagoCents, resolveBookingCopagoCents } from "@/lib/billing-internal";
import { particularQuoteCents } from "@/lib/copago";
import { isPublicReservation, overlapBlocks } from "@/lib/booking-capacity";
import { toARDateKey } from "@/lib/datetime-ar";
import { lockPlanPatient } from "@/lib/plan-lock";
import { bookingHasMoney, priorPaidStamp } from "@/lib/plan-pricing";
import { formatARS } from "@/lib/format";
import { classifyBatchInstant, dayKeyOf, defaultRoomFor, expandDates, roomOccupancyAt } from "@/lib/availability";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import {
  capacityKeysForWindow,
  hourKeyForStart,
  lockAgendaKeysMany,
  practitionerDayKeysForWindow,
  roomKeysForWindow,
} from "@/lib/booking-cap-lock";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { countRoomOverlapsInTx, loadRoomBookingsInTx, lockActiveRoomInTx } from "@/lib/booking-rooms-internal";
import { bulkPatientAccess } from "@/lib/visibility";
import { ForbiddenError, type Actor } from "@/lib/session";
import { memberCapabilitiesForActor, requireCapability } from "@/lib/authz";
import { canCollectCopago, canConfirmInsurer, canOperateBooking, canWriteClinical, type Capability } from "@/lib/capabilities";
import { COLLECT_COPY, type CopagoMarkInput } from "@/lib/booking-collect";
// T5 (TP-2i): `online-payments-copy`, `online-charge-logic`, `payment-links-internal` y `mp-connect/account-client`
// se cargan con `import()` donde se usan (ramas raras: cancelar con seña, borrar/cobrar con cobro online). Importados
// estáticos, entraban al grafo de first load de `/agenda` por este archivo (3140 B de T5 contra un techo de 300,
// `online-payments-first-load-guard.test.ts`). Mismo comportamiento: solo cambia cuándo se carga el módulo.
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/payment-method";
import { z } from "zod";
import { bookingFieldAccess } from "@/lib/booking-field-access";
import { applyReceptionAction, RECEPTION_ACTION_LABEL } from "@/lib/reception-state";
import { MODULE_DENIED_COPY, roomsEnabled, waitingRoomEnabled } from "@/lib/tenant-modules";
import type { ForceFlags } from "@/lib/booking-force-flags";
import { tags, ttl } from "@/lib/cache-tags";
import { NotificationKind } from "@prisma/client";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
// S07c (ES2b P2.0): los helpers de los write-paths y el cuerpo de la tx de
// `updateBooking` viven en el core server-only (`lib/bookings-core.ts`), para
// que Planes (P2.1) los llame dentro de su propia tx con los mismos gates y
// locks. Este archivo queda como wrapper de las actions: getActor → zod →
// runWithRls(core) → traducir el outcome → notify/revalidate →
// `afterBookingsCommitted` (enmienda Realtime: una vez, después del commit y
// fuera de `runWithRls`; reemplaza a `invalidateBookingDerivedCaches`).
// PL-A (plan §20.5.9): solo se auditan borrar un turno y los cobros, con
// `auditInTx` DENTRO de la tx del write. Alta, lote, edición, reprogramación
// y recepción (Llegó/Llamar/Atendido) dejaron de auditarse: era ruido y el
// `audit()` aparte podía divergir del write.
import {
  acceptClientKey,
  actorCapsInTx,
  applyBookingUpdateInTx,
  PRACTITIONER_NOT_BOOKABLE_ERROR,
  bookingRefsError,
  buildBookingCreateData,
  checkPatientOverlap,
  classifyForWrite,
  countAgendaOccupancy,
  defaultLocationFor,
  guestOperable,
  hasFullAccess,
  intervalCapVerdict,
  liveBlocksInTx,
  loadInstantAvailability,
  lockActiveLocation,
  lockPlanReactivationInTx,
  notifyPlanNearingDischarge,
  otherServiceLabel,
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
  INTERVAL_CAP_ERROR,
  OTHER_SERVICE_ERROR,
  OUT_OF_HOURS_ERROR,
  PATIENT_OVERLAP_ERROR,
  PLAN_DELETE_ERROR,
  PLAN_PAID_CANCEL_ERROR,
  PLAN_PATIENT_CHANGE_ERROR,
  BOOKING_HAS_CLINICAL_NOTE_ERROR,
  BOOKING_CLINICAL_NOTE_PATIENT_ERROR,
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
  BookingsRangeQuery,
  ReceptionActionInput,
  type AgendaBookingsQueryInput,
  type BookingsRangeQueryInput,
} from "@/lib/bookings-schemas";
import {
  BOOKING_ONLINE_CHARGE_PATIENT_ERROR,
  patientReplyOf,
  type AgendaBookingRow,
  type BatchDateOutcome,
  type BookingBlockedPrompt,
  type BookingIntervalCapNotice,
  type BookingIntervalCapPrompt,
  type BookingOtherServicePrompt,
  type BookingOutOfHoursPrompt,
  type BookingRow,
  type ReceptionActionResult,
} from "@/lib/bookings-types";
import type { ReceptionAction } from "@/lib/reception-state";
import { bookablePractitionerWhere, isActorPractitioner } from "@/lib/practitioner-scope";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";

/** Clave del mapa de precios por profesional × servicio (CF3, D-CF3-1). */
const practitionerPriceKey = (practitionerId: string, serviceId: string) => `${practitionerId}:${serviceId}`;

/**
 * CF3 PR-C1 (D-CF3-1): `PractitionerService.priceCents` de los pares profesional × servicio de los turnos que se van a
 * cotizar, en UNA sentencia (nunca por fila: la agenda de la Secretaria trae cientos de turnos de 5+ profesionales).
 * El `where` es el producto `practitionerId IN × serviceId IN` (superconjunto chico de los pares reales, que se filtra
 * en el mapa) y `priceCents` no nulo: un par sin fila o con NULL hereda (= la escalera de antes de CF3). Sin pares no
 * hay sentencia. `tenantId` a mano: en prod la conexión tiene BYPASSRLS.
 *
 * No filtra por `enabled`: el arancel es del profesional aunque después deshabilite el servicio; un turno ya dado con
 * ese servicio se sigue cotizando a su precio hasta cobrarlo (D-CF3-2: sigue al profesional actual).
 */
async function loadPractitionerPrices(
  tx: Prisma.TransactionClient,
  tenantId: string,
  pairs: ReadonlyArray<{ practitionerId: string; serviceId: string }>
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pairs.length === 0) return out;
  const practitionerIds = [...new Set(pairs.map((p) => p.practitionerId))];
  const serviceIds = [...new Set(pairs.map((p) => p.serviceId))];
  const rows = await tx.practitionerService.findMany({
    where: { tenantId, practitionerId: { in: practitionerIds }, serviceId: { in: serviceIds }, priceCents: { not: null } },
    select: { practitionerId: true, serviceId: true, priceCents: true },
  });
  for (const r of rows) if (r.priceCents != null) out.set(practitionerPriceKey(r.practitionerId, r.serviceId), r.priceCents);
  return out;
}

/**
 * CF3 ZF1 (M1): monto de un turno INVITADO (sin paciente) = lo que `toggleBilling` congela al cobrarlo: el monto propio
 * del turno si lo tiene; si no, la escalera del particular (`particularQuoteCents`: precio del profesional →
 * «Particular» del consultorio → servicio). Antes la agenda mostraba el precio del servicio y se estampaba otro monto.
 * No es PHI (no hay paciente): se muestra a todos, como antes el precio del servicio.
 */
function guestCopagoCents(
  b: { copagoCents: number | null; practitionerId: string; serviceId: string; service: { priceCents: number } },
  particularCopago: number | null,
  practitionerPrices: ReadonlyMap<string, number>
): number {
  if (b.copagoCents != null) return b.copagoCents;
  return particularQuoteCents({
    practitionerPriceCents: practitionerPrices.get(practitionerPriceKey(b.practitionerId, b.serviceId)) ?? null,
    particularCopagoCents: particularCopago,
    servicePriceCents: b.service.priceCents,
  });
}

export async function listBookingsInRange(raw: BookingsRangeQueryInput): Promise<BookingRow[]> {
  const actor = await getActor();
  // PV-W1a (HD-1): validada como `listAgendaBookings` (tira ZodError): por RPC llega cualquier cosa, y sin tope un
  // rango de años recorría todo el tenant con el include pesado de abajo.
  const opts = BookingsRangeQuery.parse(raw);
  // Sprint 16: agenda shows every booking in the tenant; per-row access
  // tier is resolved below. The diagnosis chip is hidden when the actor
  // only has BASIC access to that booking's patient.
  const { rows, practitionerPrices } = await runWithRls(actor.tenantId, async (tx) => {
    const rows = await tx.booking.findMany({
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
    });
    // CF3 PR-C1: precio del profesional de los turnos que se cotizan con la escalera, en la misma tx y en una sentencia
    // (+1, solo si hay alguno). CF3 ZF1 (M1): también los invitados (sin paciente), que `toggleBilling` congela con la
    // escalera del particular: sin su par, la agenda los mostraba al precio del servicio y se cobraba otro monto.
    // Quedan afuera solo las filas con paciente sin billing visible (`basic`): esas siguen al precio del servicio, y
    // el acceso se resuelve después de esta tx, así que acá va el superconjunto (un par de más no cambia ningún monto).
    const practitionerPrices = await loadPractitionerPrices(
      tx,
      actor.tenantId,
      rows.map((b) => ({ practitionerId: b.practitionerId, serviceId: b.serviceId }))
    );
    return { rows, practitionerPrices };
  });

  const patientIds = rows
    .map((b) => b.patientId)
    .filter((id): id is string => !!id);
  const [accessMap, particularCopago, caps] = await Promise.all([
    bulkPatientAccess(actor, patientIds),
    getParticularCopagoCents(actor.tenantId),
    memberCapabilitiesForActor(actor),
  ]);
  // E0 (S07k): esta server action se puede llamar por RPC aunque la agenda ya
  // use `listAgendaBookings`. Gateaba solo full/basic, así que la Secretaria
  // (ASSISTANT, sin `clinical.read`) con `sharedPatientView` leía título,
  // descripción, notas y diagnóstico. Ahora: la misma regla que la agenda
  // (`bookingFieldAccess`) y el chip de diagnóstico solo con clinical + full.
  // PL-1 (H-PL1): por MIEMBRO, no por rol: un Titular que no atiende no ve lo clínico.
  const clinical = caps.has("clinical.read");

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
    // Copago precedence (lib/copago.ts, D-CF3-1): per-turno override → per-patient override → insurer / precio del
    // profesional del turno → Particular → service price. Basic-access rows hide billing and just show the service
    // price (sin el precio del profesional: igual que antes de CF3).
    const copagoCents =
      seesBilling
        ? resolveBookingCopagoCents({
            bookingOverride: b.copagoCents,
            coverageOverride: coverage?.copagoCents ?? null,
            hasCoverage: !!coverage,
            insurerCopago: insurer ? insurer.copagoCents : null,
            particularCopago,
            servicePriceCents: b.service.priceCents,
            practitionerPriceCents: practitionerPrices.get(practitionerPriceKey(b.practitionerId, b.serviceId)) ?? null,
            insurerIsParticular: insurer?.isParticular === true,
          })
        : !b.patientId
          ? guestCopagoCents(b, particularCopago, practitionerPrices)
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
  const caps = await memberCapabilitiesForActor(actor);
  const clinical = caps.has("clinical.read");
  let practitionerIds = q.practitionerIds?.length ? [...new Set(q.practitionerIds)] : undefined;
  if (!caps.has("agenda.viewAll")) {
    // IAM-4a: sin profesional no hay agenda propia → `[]` (= ningún turno: el filtro es `in: []`, no «todos»).
    // IAM-4b: hoy ningún rol llega acá sin profesional: todos los roles tienen `agenda.viewAll`
    // (`lib/capabilities.ts` MATRIX) y los no clínicos (ASSISTANT, BILLING) entran por esa rama. Queda como
    // red, fallando cerrado, para un rol futuro sin profesional ni `agenda.viewAll`.
    practitionerIds = actor.practitionerId
      ? (practitionerIds ?? [actor.practitionerId]).filter((id) => isActorPractitioner(actor, id))
      : [];
  }
  const tenantId = actor.tenantId;
  const roomsOn = roomsEnabled(actor.entitlements);

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
        // PL-2f: sin el módulo `salas` el filtro no existe (una pref guardada en Clínica no esconde turnos cuya
        // sala ahora «duerme»).
        ...(!roomsOn ? {} : q.roomId === "none" ? { roomId: null } : q.roomId ? { roomId: q.roomId } : {}),
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
        // T3 (C-AS2): cómo pagó el copago; escalar en la misma sentencia (cable `pm`, default null).
        copagoPaymentMethod: true,
        // T5 (C-TP10): seña (Σ PAID, la escribe el trigger de M18) y quién cobró (null + MERCADO_PAGO = pagado por un
        // cobro online, `paidOnline`). Escalares en la misma sentencia: 0 sentencias (techo +0 de `listAgendaBookings`).
        onlineDepositCents: true,
        copagoCollectedById: true,
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
        // WA-S7 (M15, WA-D21/D22): respuesta del paciente por WhatsApp y el horario al que respondió. Escalares en la
        // misma sentencia (0 sentencias, techo de 16 de `a.listAgendaBookings.week`); de acá sale SOLO `patientReply`
        // (los timestamps no viajan al cliente).
        patientConfirmedAt: true,
        patientCancelRequestedAt: true,
        patientReplyFor: true,
        // C9 (S12): vínculo con el plan, para la proyección de abajo.
        programId: true,
        sessionId: true,
        // ES4 P4.Z (perf S26s #1): escalar en la misma sentencia; la proyección C9 no vuelve a leer Booking.
        pricedByPlan: true,
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
        pricedByPlan: r.pricedByPlan,
      })),
      caps,
      // ES4 P4.Z (perf S26s #1): el acceso de arriba cubre a todos los pacientes de las filas; sin esto la
      // proyección hacía un segundo `bulkPatientAccess` (3 sentencias) para el título del plan.
      access
    );
    // PD-13 (S07sb): cobertura/copago también para `admin` (Secretaria y
    // Facturación ven obra social y estado de cobro); nunca para `basic`.
    const billingIds = patientIds.filter((id) => {
      const l = access.get(id);
      return l === "full" || l === "admin";
    });
    // CF3 PR-C1 (D-CF3-1): precio del profesional SOLO de los pares de las filas que se cotizan con la escalera: las que
    // muestran billing y (CF3 ZF1, M1) los invitados, que `toggleBilling` congela con la escalera del particular. Las
    // de `basic` siguen al precio del servicio. Una sentencia con el mismo `Promise.all` (+1 en el presupuesto de
    // pf2-agenda; sin filas que cotizar, +0).
    const billingSet = new Set(billingIds);
    const [coverages, particularCopago, practitionerPrices] = await Promise.all([
      billingIds.length
        ? tx.coverage.findMany({
            where: { patientId: { in: billingIds }, patient: { tenantId } },
            // = `orderBy id desc, take 1` por paciente de la proyección completa.
            orderBy: { id: "desc" },
            select: {
              patientId: true,
              insurer: true,
              copagoCents: true,
              // [AS-2o] Clave del filtro por obra social: escalares en la MISMA sentencia (0 sentencias nuevas).
              insurerId: true,
              insurerRef: { select: { name: true, copagoCents: true, isParticular: true } },
            },
          })
        : Promise.resolve([]),
      getParticularCopagoCents(tenantId, tx),
      loadPractitionerPrices(
        tx,
        tenantId,
        rows
          .filter((r) => !r.patientId || billingSet.has(r.patientId))
          .map((r) => ({ practitionerId: r.practitionerId, serviceId: r.serviceId }))
      ),
    ]);
    return { locations, rows, access, coverages, particularCopago, practitionerPrices, c9 };
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
    // [AS-2o] Filtro por obra social (plan §23.9), regla segura: el id del catálogo solo si la cobertura está
    // vinculada a una OS que no es la Particular; sin cobertura, con la Particular, con texto libre sin vincular
    // (`insurerId` null) o invitado → "particular"; sin ver facturación (acceso `basic`) → null, que el filtro
    // nunca matchea (se oculta y se cuenta): ni el id ni «particular» filtrarían por algo que el actor no ve.
    const insurerKey: string | null = !b.patientId
      ? "particular"
      : !seesBilling
        ? null
        : coverage?.insurerId && insurer && !insurer.isParticular
          ? coverage.insurerId
          : "particular";
    const copagoCents =
      seesBilling
        ? resolveBookingCopagoCents({
            bookingOverride: b.copagoCents,
            coverageOverride: coverage?.copagoCents ?? null,
            hasCoverage: !!coverage,
            insurerCopago: insurer ? insurer.copagoCents : null,
            particularCopago: loaded.particularCopago,
            servicePriceCents: b.service.priceCents,
            practitionerPriceCents: loaded.practitionerPrices.get(practitionerPriceKey(b.practitionerId, b.serviceId)) ?? null,
            insurerIsParticular: insurer?.isParticular === true,
          })
        : !b.patientId
          ? guestCopagoCents(b, loaded.particularCopago, loaded.practitionerPrices)
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
      copagoPaymentMethod: b.copagoPaymentMethod,
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
      insurerKey,
      onlineDepositCents: b.onlineDepositCents,
      // Misma regla que `copagoCollectViewFor` («Pagado por Mercado Pago»): el webhook nuevo marca PAID con medio
      // MERCADO_PAGO y nunca lleva quién cobró; un cobro a mano lo lleva siempre desde M12 (CHECK), aunque elija el
      // medio «Mercado Pago». Un FULL reintegrado deja el turno REFUNDED: deja de ser «pagado online».
      paidOnline: b.paymentStatus === "PAID" && b.copagoPaymentMethod === "MERCADO_PAGO" && b.copagoCollectedById == null,
      // WA-S7: una sola señal, solo si la respuesta es de ESTE horario (si el turno se movió, la respuesta es vieja).
      // No es PHI ni depende del acceso al paciente: la Secretaría la necesita para llamar a quien pidió cancelar.
      patientReply: patientReplyOf(b),
    };
  });
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
 * IAM-2e: además en un rol clínico y sin suspender
 * (`bookablePractitionerWhere`): la Secretaria y Facturación tienen fila
 * Practitioner para poder entrar (hasta IAM-4) pero no atienden (§19.2
 * decisión 2). Sus turnos viejos siguen en la agenda: `listAgendaBookings`
 * lista por tenant y fecha, no por esta lista.
 */
export async function listPractitioners() {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string) =>
      runWithRls(tenantId, (tx) => tx.practitioner.findMany({
        where: bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }),
        include: { user: true },
        orderBy: { createdAt: "asc" },
      })),
    ["practitioners:list", actor.tenantId],
    { tags: [tags.practitioners(actor.tenantId)], revalidate: ttl.short }
  );
  return fetcher(actor.tenantId);
}

/**
 * PL-2f (C-PL1, PL-D7): una sala ELEGIDA (`roomId` string) sin el módulo `salas` → `ForbiddenError` con el copy de
 * upsell. `undefined` (la de la franja) y `null` («Sin sala») no se gatean: sin el módulo, la de la franja ya es
 * null (`lib/availability-loader.ts`). Síncrono y sin query: el plan viene en `actor.entitlements`.
 */
function assertRoomModule(actor: Actor, roomId: string | null | undefined): void {
  if (typeof roomId === "string" && !roomsEnabled(actor.entitlements)) {
    throw new ForbiddenError(MODULE_DENIED_COPY.salas);
  }
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
    // T3 (C-AS3, decisión 6): el staff confirmó «Cargar como sobreturno» con el
    // tope «N turnos cada X min» del profesional lleno. ES sobreturno
    // (`isOverbooked` + prefijo). Flag propio: no fuerza el cupo del servicio.
    allowIntervalCap?: boolean;
    // CF (§28, ADR-032): el staff confirmó «Cargar igual» aunque el profesional
    // ya atiende OTRO servicio en ese horario (sin `allowParallelServices`). ES
    // sobreturno (`isOverbooked` + prefijo). Flag propio: `allowOverbooking`
    // (cupo del servicio) no lo pasa, para que aceptar «ya tiene un turno» no
    // tape en silencio que el profesional está con otra cosa.
    allowOtherService?: boolean;
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
    // T3 (C-AS3): tope por intervalo lleno (re-llamar con allowIntervalCap; queda
    // sobreturno). Sale después del cupo y antes de la sala.
    intervalCap?: BookingIntervalCapPrompt;
    // CF (§28, ADR-032): el profesional ya atiende OTRO servicio en ese horario
    // (re-llamar con allowOtherService; queda sobreturno). Sale después del cupo
    // y antes del tope (FORCE_PROMPT_ORDER).
    otherService?: BookingOtherServicePrompt;
    // T3 (C-AS3): en un `ok: true`, el turno es el 2.º+ de su intervalo bajo el
    // tope («Ya hay 1 turno de Ana a las 10:00.»): informativo, sin confirmar.
    intervalCapNotice?: BookingIntervalCapNotice;
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
  // PL-2f (PL-D7): elegir sala exige el módulo `salas` (Clínica / Libre). Antes de cualquier lectura: no se escribe
  // nada. «Sin sala» (null) y la por defecto (ausente) siguen andando: sin el módulo el loader no ve las salas de
  // las franjas, así que la por defecto da null.
  assertRoomModule(actor, data.roomId);
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
  // T3 (C-AS3): tope efectivo del profesional (INHERIT / NONE / CUSTOM), del loader de `pre` (0 sentencias). Se
  // lee en el tx previo, como las franjas: la clave de hora no depende de la config, así que un cambio de tope
  // commiteado en el medio solo puede correr la decisión de un alta suelta, nunca dejar dos sin serializar.
  const icap = input.intervalCaps[data.practitionerId] ?? null;
  // CF (§28, ADR-032): «no atiende servicios distintos a la vez» (= !allowParallelServices), del mismo loader de
  // `pre` que el tope (0 sentencias) y con la misma razón para leerlo afuera de la tx: la clave `pday` se toma
  // SIEMPRE, no depende de la regla, así que prender/apagar el interruptor en el medio solo puede correr la decisión
  // de un alta suelta, nunca dejar dos sin serializar. El loader arma una entrada por profesional reservable (el que
  // no lo es ya salió en `validateBookingRefsInTx`); `?? true` es el default de M20, como en la edición.
  const exclusiveService = input.agendaRules[data.practitionerId]?.exclusiveService ?? true;
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
      // SR, enmienda C2 (1b), y T3, enmienda C2 (1c): cupo → HORA → SALA →
      // sedes → filas, las tres familias en UNA sentencia (`lockAgendaKeysMany`:
      // la misma cantidad que el lock de cupo solo, techo estricto de
      // `f.createBooking` en tests/perf/compare.ts). La sala, solo con chequeo
      // (sin sala o forzada, no hay clave de sala). La hora (`kinesoft:phour:…`,
      // la del inicio) SIEMPRE: el tope cruza servicios y el lock de cupo lleva
      // el servicio, así que sin ella dos altas de servicios distintos en el
      // mismo intervalo leían «0 de 1» las dos y entraban las dos.
      // CF, enmienda C2 (1d): + el DÍA del profesional (`kinesoft:pday:`), entre el cupo y la hora, en la MISMA
      // sentencia (0 sentencias nuevas). Sin él, Kine 09:30 + 60' y Evaluación 10:00 no compartían ninguna clave
      // (el cupo lleva el servicio; la hora, solo la del inicio) y las dos leían «0 de otro servicio» ([CF-R1]).
      await lockAgendaKeysMany(tx, {
        cap: capacityKeysForWindow(capWindow),
        pday: practitionerDayKeysForWindow({
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          start: data.scheduledFor,
          end,
        }),
        hour: [hourKeyForStart({ tenantId: actor.tenantId, practitionerId: data.practitionerId, start: data.scheduledFor })],
        rooms: roomCheck
          ? roomKeysForWindow({ tenantId: actor.tenantId, roomId: roomTarget!, start: data.scheduledFor, end })
          : [],
      });
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
      // T3 (C-AS3): cupo del servicio + inicios del intervalo en la MISMA
      // sentencia (`countAgendaOccupancy`; sin tope es la query de siempre).
      const occ = await countAgendaOccupancy(tx, {
        tenantId: actor.tenantId,
        practitionerId: data.practitionerId,
        serviceId: service.id,
        start: data.scheduledFor,
        end,
        now,
        excludeKey: clientKey,
        cap: icap,
        // CF: el otro servicio va en la MISMA sentencia (el where pierde el servicio, como con tope). El paciente
        // del turno nuevo exime a sus propios turnos (CF-D3); un guest (null) no exime a nadie.
        exclusiveService,
        patientId: data.patientId ?? null,
      });
      const capacityReached = overlapBlocks(occ.overlap, rule.cap);
      // Sin escribir: la UI ofrece el próximo libre o re-llamar con
      // allowOverbooking=true para forzar el sobreturno.
      if (capacityReached && !raw.allowOverbooking) return { kind: "conflict" as const };
      // CF: cupo → OTRO SERVICIO → tope → sala (brief CF A.5), sin escribir. `first` = el que empieza antes, para
      // que el aviso sea estable («está atendiendo «Kine»» con el inicio de ese turno).
      const otherBusy = occ.otherService.count > 0;
      if (occ.otherService.first && !raw.allowOtherService) {
        return {
          kind: "other-service" as const,
          serviceId: occ.otherService.first.serviceId,
          existingAt: occ.otherService.first.scheduledFor,
        };
      }
      // T3: tope lleno → aviso forzable DESPUÉS del cupo y antes de la sala
      // (FORCE_PROMPT_ORDER), sin escribir.
      const iv = intervalCapVerdict(occ.intervalStarts, icap, data.scheduledFor);
      const intervalFull = iv?.state === "full";
      if (intervalFull && !raw.allowIntervalCap) return { kind: "interval-cap" as const, verdict: iv! };

      // Sobreturno = cupo lleno forzado, bloqueo forzado (decisión 1), tope
      // forzado (decisión 6 del 19-oct) u otro servicio forzado (CF). B3.1:
      // `isOverbooked` (M-agenda) es la fuente; el prefijo "[SOBRETURNO]" en
      // notes se sigue escribiendo hasta el contract posterior a B-pre (§5.29).
      const overbooked = capacityReached || otherBusy || live.blocked || intervalFull;
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
      // T3: aviso informativo del 2.º+ turno del intervalo («Ya hay 1 turno de
      // Ana a las 10:00.»). El nombre se lee SOLO en este camino (+1 sentencia
      // con aviso; sin tope o con el intervalo vacío, el alta cuesta lo mismo).
      const notice: BookingIntervalCapNotice | null =
        iv?.state === "notice"
          ? {
              practitionerName: await practitionerLabel(tx, actor.tenantId, data.practitionerId),
              used: iv.used,
              time: iv.fromTime,
              to: iv.toTime,
              intervalMin: icap!.intervalMin,
            }
          : null;
      return { kind: "ok" as const, row, notice };
    });
    if (w.kind === "room-busy") {
      return {
        ok: false,
        error: w.blocked ? ROOM_BLOCKED_ERROR(w.roomName, w.blocked.reason) : ROOM_BUSY_ERROR(w.roomName),
        roomBusy: { roomName: w.roomName, nextFreeISO: null, blocked: w.blocked },
      };
    }
    if (w.kind === "bad-room") return { ok: false, error: BAD_ROOM_ERROR };
    if (w.kind === "other-service") {
      // CF: el nombre del servicio que ocupa el horario va en la MISMA tx de lectura que el del profesional (+1 query
      // SOLO en este aviso, fuera de la tx que escribe), como en la edición.
      const [[practitionerName, serviceName], nextFreeISO] = await Promise.all([
        runWithRls(actor.tenantId, async (tx) => [
          await practitionerLabel(tx, actor.tenantId, data.practitionerId),
          await otherServiceLabel(tx, actor.tenantId, w.serviceId),
        ] as const),
        suggest(),
      ]);
      const prompt: BookingOtherServicePrompt = {
        practitionerName,
        serviceName,
        existingISO: w.existingAt.toISOString(),
        nextFreeISO,
      };
      return { ok: false, error: OTHER_SERVICE_ERROR(prompt), otherService: prompt };
    }
    if (w.kind === "interval-cap") {
      const [practitionerName, nextFreeISO] = await Promise.all([nameOf(), suggest()]);
      const v = w.verdict;
      const prompt: BookingIntervalCapPrompt = {
        practitionerName,
        used: v.used,
        cap: v.cap.count,
        fromTime: v.fromTime,
        toTime: v.toTime,
        nextFreeISO,
      };
      return { ok: false, error: INTERVAL_CAP_ERROR(prompt), intervalCap: prompt };
    }
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
    // Éxito idempotente: no se escribió nada → ni `afterBookingsCommitted`.
    if (w.kind === "adopted") {
      // PF-0d: el cliente ya no hace `router.refresh()` después de crear: la
      // agenda nueva llega SOLO con la respuesta de una action que revalida. Un
      // reintento idempotente (la respuesta del primero se perdió) tiene que
      // traerla igual, aunque no haya escrito nada (sin eventos).
      revalidatePath("/agenda");
      return { ok: true, data: { id: w.id } };
    }
    if (w.kind === "bad-location") return { ok: false, error: BAD_LOCATION_ERROR };
    const b = w.row;
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
          hourCycle: "h23",
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
    return { ok: true, data: { id: b.id }, ...(w.notice ? { intervalCapNotice: w.notice } : {}) };
  } catch (e) {
    // BO3-F: modo lectura / soporte → su copy (antes caía en «No pudimos crear el turno.»).
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    // The partial unique index (tenant+patient+slot, non-cancelled) is the
    // race-free backstop for the patient-day guard: a genuinely-concurrent
    // second create at the same slot loses the INSERT race here. Two
    // concurrent upserts with the SAME key can also cross on that index; that
    // one resolves to the row the other one wrote (idempotent success).
    const r = await resolveUniqueViolation(actor.tenantId, e, idempotencyKey);
    if (r.kind === "existing") {
      // PF-0d: éxito idempotente → misma razón que la rama `adopted`.
      revalidatePath("/agenda");
      return { ok: true, data: { id: r.id } };
    }
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
  // T3 (C-AS3): tope por intervalo lleno en el intervalo NUEVO (mover o reactivar;
  // forzable con `allowIntervalCap`, queda sobreturno).
  intervalCap?: BookingIntervalCapPrompt;
  // CF (§28, ADR-032): el profesional ya atiende OTRO servicio en el horario nuevo (mover, alargar o reactivar;
  // forzable con `allowOtherService`, queda sobreturno).
  otherService?: BookingOtherServicePrompt;
  // T3 (C-AS3): en un `ok: true`, el turno quedó 2.º+ de su intervalo nuevo bajo el tope (informativo).
  intervalCapNotice?: BookingIntervalCapNotice;
  /**
   * S12 (C4): aviso no bloqueante de la sincronía con la sesión del plan (p.
   * ej. salir de COMPLETED con evolución cargada: la sesión queda realizada).
   */
  notice?: string;
};

// BO3-F: el cuerpo va en `updateBookingImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function updateBooking(
  ...args: Parameters<typeof updateBookingImpl>
): Promise<UpdateBookingResult> {
  return withReadOnlyResult(() => updateBookingImpl(...args));
}

async function updateBookingImpl(
  raw: BookingUpdateInput & {
    allowOverbooking?: boolean;
    // Same flag as createBooking: the front desk confirmed the patient may
    // have two turnos overlapping (two services in parallel).
    allowPatientOverlap?: boolean;
    // B3.1: mismos flags que createBooking (decisiones 1 y 2).
    allowOutOfHours?: boolean;
    allowBlocked?: boolean;
    allowRoomConflict?: boolean;
    // T3 (C-AS3): pasar el tope por intervalo (queda sobreturno). Llega también desde `setBookingStatus` (reactivar).
    allowIntervalCap?: boolean;
    // CF (§28): mover/alargar/reactivar aunque el profesional ya atienda otro servicio a esa hora (queda
    // sobreturno). Flag propio: `allowOverbooking` no lo pasa. Llega también desde `setBookingStatus` (reactivar).
    allowOtherService?: boolean;
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
  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const r = await applyBookingUpdateInTx(
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
          allowIntervalCap: raw.allowIntervalCap,
          allowOtherService: raw.allowOtherService,
        },
      },
      { now }
    );
    if (r.kind !== "ok") return r;
    const cancelledChargeIds = await cancelLiveChargesOnCloseInTx(tx, actor, r.before.id, r.before.status, r.written.status);
    return { ...r, cancelledChargeIds };
  }).catch(async (e) => {
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
    // T5 (§25.8): carrera chequeo/escritura del cambio de paciente: un cobro online que entra entre el EXISTS del core
    // y el UPDATE lo frena la FK compuesta de M18 (23503 → P2003). Mismo caso que «tiene cobro online», no un 500.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2003" &&
      String((e.meta as { field_name?: unknown } | undefined)?.field_name ?? e.message).includes("OnlineCharge_")
    ) {
      return { kind: "online-charge-patient" as const };
    }
    throw e;
  });

  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  if (outcome.kind === "online-charge-patient") return { ok: false, error: BOOKING_ONLINE_CHARGE_PATIENT_ERROR };
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
  if (outcome.kind === "clinical-note-patient") {
    return { ok: false, error: outcome.clinical ? BOOKING_CLINICAL_NOTE_PATIENT_ERROR : CLINICAL_RELINK_ERROR };
  }
  // IAM-4b: turno viejo de un profesional que ya no atiende acá (Secretaria,
  // suspendido): no se mueve; se cancela y se carga con otro profesional.
  if (outcome.kind === "practitioner-not-bookable") return { ok: false, error: PRACTITIONER_NOT_BOOKABLE_ERROR };
  if (
    outcome.kind === "conflict" ||
    outcome.kind === "blocked" ||
    outcome.kind === "out-of-hours" ||
    outcome.kind === "interval-cap" ||
    outcome.kind === "other-service"
  ) {
    const [[practitionerName, otherServiceName], nextFreeISO] = await Promise.all([
      // CF: el nombre del servicio que ocupa el horario va en la MISMA tx de lectura que el del profesional (+1 query
      // solo en este aviso; fuera de la tx que escribe).
      runWithRls(actor.tenantId, async (tx) => [
        await practitionerLabel(tx, actor.tenantId, outcome.before.practitionerId),
        outcome.kind === "other-service" ? await otherServiceLabel(tx, actor.tenantId, outcome.otherServiceId) : null,
      ] as const),
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
    if (outcome.kind === "interval-cap") {
      const prompt: BookingIntervalCapPrompt = {
        practitionerName,
        used: outcome.used,
        cap: outcome.intervalCap.count,
        fromTime: outcome.fromTime,
        toTime: outcome.toTime,
        nextFreeISO,
      };
      return { ok: false, error: INTERVAL_CAP_ERROR(prompt), intervalCap: prompt };
    }
    if (outcome.kind === "other-service") {
      const prompt: BookingOtherServicePrompt = {
        practitionerName,
        serviceName: otherServiceName,
        existingISO: outcome.existingAt.toISOString(),
        nextFreeISO,
      };
      return { ok: false, error: OTHER_SERVICE_ERROR(prompt), otherService: prompt };
    }
    return {
      ok: false,
      error: "El profesional ya tiene un turno en ese horario.",
      conflict: { practitionerName, nextFreeISO },
    };
  }

  const before = outcome.before;
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
      hourCycle: "h23",
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
  await expireCancelledChargePreferences(actor.tenantId, outcome.cancelledChargeIds, "updateBooking");
  // S12 (C4): alta próxima, post-commit (la notificación nunca tira).
  if (outcome.plan?.discharge) {
    await notifyPlanNearingDischarge(actor.tenantId, outcome.plan.discharge, actor.userId ?? null);
  }
  // T5 (§25.8, decisión 2 del 19-oct): cancelar un turno con seña avisa que el reintegro se hace DESDE Mercado Pago
  // (la app no devuelve plata). `onlineDepositCents` ya vino en la lectura del core: 0 sentencias.
  const refundNotice =
    patch.status === "CANCELLED" && before.status !== "CANCELLED" && before.onlineDepositCents > 0
      ? (await import("@/lib/online-charge-logic")).depositRefundNotice(before.onlineDepositCents)
      : null;
  const notices = [outcome.plan?.sessionKeptDone ? SESSION_KEPT_DONE_NOTICE : null, refundNotice].filter((n): n is string => !!n);
  return {
    ok: true,
    data: { updatedAt: outcome.updatedAt },
    ...(notices.length ? { notice: notices.join(" ") } : {}),
    ...(outcome.intervalCapNotice ? { intervalCapNotice: outcome.intervalCapNotice } : {}),
  };
}

/**
 * TP-ZF1 (M3 del revisor de T5-Z): cancelar o marcar ausente un turno anula sus cobros online ACTIVE (LINK y TURNERO)
 * con `booking_cancelled`, en la MISMA tx y con el turno ya bloqueado (el UPDATE del caller tomó la fila: orden de locks
 * Booking → OnlineCharge, §25.3, el mismo del webhook). Antes quedaban vivos: el paciente podía pagar por MP un turno
 * cancelado, y el cron solo anulaba LINK y recién en su próxima vuelta. +1 sentencia SOLO en la transición a
 * CANCELLED / NO_SHOW (el resto de las ediciones cuesta lo de siempre). Un AUTHORIZED no se toca (MP lo retiene; el
 * guard de M18 no deja anularlo): si se acredita, el webhook lo registra como pago tardío y avisa.
 */
async function cancelLiveChargesOnCloseInTx(
  tx: Prisma.TransactionClient,
  actor: Actor,
  bookingId: string,
  beforeStatus: BookingStatus,
  nextStatus: BookingStatus | undefined
): Promise<string[]> {
  const closing = (s: BookingStatus | undefined) => s === "CANCELLED" || s === "NO_SHOW";
  if (!closing(nextStatus) || closing(beforeStatus)) return [];
  const { cancelLiveLinksForBookingInTx } = await import("@/lib/payment-links-internal");
  const r = await cancelLiveLinksForBookingInTx(tx, {
    tenantId: actor.tenantId,
    bookingId,
    reason: "booking_cancelled",
    byUserId: actor.userId ?? null,
    includeTurnero: true,
  });
  return r.cancelledChargeIds;
}

/** Vence en MP las preferencias de los cobros anulados, DESPUÉS del commit. Best effort: nunca tira. */
async function expireCancelledChargePreferences(tenantId: string, chargeIds: string[], where: string): Promise<void> {
  if (chargeIds.length === 0) return;
  // El `import()` va dentro de la cadena: si el módulo no carga, cae al mismo `catch`.
  await import("@/lib/mp-connect/account-client")
    .then((m) => m.expirePreferencesBestEffort(tenantId, chargeIds))
    .catch((err) =>
      logger.warn(`${where}: no se pudieron vencer las preferencias de los cobros anulados`, {
        tenantId,
        err: err instanceof Error ? err.message : String(err),
      })
    );
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
// BO3-F: el cuerpo va en `markReceptionActionImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function markReceptionAction(
  ...args: Parameters<typeof markReceptionActionImpl>
): Promise<ActionResult<ReceptionActionResult>> {
  return withReadOnlyResult(() => markReceptionActionImpl(...args));
}

async function markReceptionActionImpl(
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
  // PL-2f (PL-D6): «Llamar» es de la Sala de Espera (Clínica / Libre). «Llegó», «En atención», «Atendido»,
  // «Ausente» y «Deshacer» son estados de agenda y siguen en el núcleo (todos los planes). Sin query: el plan
  // viene en el Actor. Mismo formato que el resto de los rechazos de esta action (`{ ok:false }`, no throw).
  if (input.action === "llamar" && !waitingRoomEnabled(actor.entitlements)) {
    return { ok: false, error: MODULE_DENIED_COPY.salaEspera };
  }
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
      !isActorPractitioner(actor, row.practitionerId) &&
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
    const cancelledChargeIds = await cancelLiveChargesOnCloseInTx(tx, actor, row.id, row.status, t.patch.status);
    return { kind: "ok" as const, row, transition: t, after, plan, cancelledChargeIds };
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
        hourCycle: "h23",
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
  await expireCancelledChargePreferences(actor.tenantId, outcome.cancelledChargeIds, "markReceptionAction");
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

// BO3-F: el cuerpo va en `deleteBookingImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function deleteBooking(
  ...args: Parameters<typeof deleteBookingImpl>
): Promise<ActionResult> {
  return withReadOnlyResult(() => deleteBookingImpl(...args));
}

async function deleteBookingImpl(
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
    // EV2-D23 (C-EV2-7): un turno con evolución (viva, enmienda o anulada) no se borra en duro: se cancela. La FK
    // RESTRICT de M9 lo frenaría igual, pero con un P2003 (500). Antes de mirar pagos, después del gate (quien no opera
    // el turno no se entera de que tiene evolución). Cuesta +1 sentencia SOLO en `deleteBooking` (no está en el techo
    // STRICT de tests/perf/compare.ts), y solo si el turno tiene paciente: un guest no puede tener evolución.
    //
    // T5 (§25.8, C-TP10): un turno con un cobro online (cualquiera: un link vivo, una seña, uno anulado o vencido) no
    // se borra: `OnlineCharge` nunca se borra y su FK al turno es RESTRICT (23503 → 500). El chequeo se pliega a la
    // MISMA sentencia de la evolución (dos EXISTS): +0 sentencias. Solo con paciente: un cobro exige paciente (la FK
    // compuesta turno-tenant-paciente), así que un guest no puede tener cobros.
    if (row.patientId) {
      const [links] = await tx.$queryRaw<{ note: boolean; charge: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM "ClinicalNote" n WHERE n."tenantId" = ${actor.tenantId} AND n."bookingId" = ${id}) AS "note",
          EXISTS (SELECT 1 FROM "OnlineCharge" c WHERE c."tenantId" = ${actor.tenantId} AND c."bookingId" = ${id}) AS "charge"`;
      if (links.note) return { kind: "has-clinical-note" as const };
      if (links.charge) return { kind: "has-online-charge" as const };
    }
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
    // PL-A (seguridad): borrar en duro no deja rastro en la agenda; el audit va en la tx del delete (si falla, el
    // turno sigue). Antes `audit()` aparte: un fallo propio dejaba el borrado sin rastro.
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "booking.delete",
      entity: "Booking",
      entityId: id,
    });
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
    // EV2-Z a3: carrera chequeo/escritura. Una evolución que entra entre el `findFirst` de arriba y el DELETE la
    // frena la RESTRICT de M9 con un P2003; es el mismo caso que «tiene evolución», no un 500. Solo esa FK: otro
    // P2003 (p. ej. un pago que entró en carrera) sigue su camino.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2003" &&
      String((e.meta as { field_name?: unknown } | undefined)?.field_name ?? e.message).includes("ClinicalNote_")
    ) {
      return { kind: "has-clinical-note" as const };
    }
    // T5: misma carrera con un cobro online que entra entre el chequeo y el DELETE (la RESTRICT de M18).
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2003" &&
      String((e.meta as { field_name?: unknown } | undefined)?.field_name ?? e.message).includes("OnlineCharge_")
    ) {
      return { kind: "has-online-charge" as const };
    }
    throw e;
  });
  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "basic") return { ok: false, error: BASIC_ACCESS_ERROR };
  if (outcome.kind === "plan-delete") return { ok: false, error: PLAN_DELETE_ERROR };
  if (outcome.kind === "has-clinical-note") return { ok: false, error: BOOKING_HAS_CLINICAL_NOTE_ERROR };
  if (outcome.kind === "has-online-charge") {
    const { ONLINE_COLLECT_COPY } = await import("@/lib/online-payments-copy");
    return { ok: false, error: ONLINE_COLLECT_COPY.deleteWithOnlineCharge };
  }
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
  revalidatePath("/agenda");
  if (owned.patientId) revalidatePath(`/pacientes/${owned.patientId}`);
  await afterBookingsCommitted(actor.tenantId, [outcome.ref]);
  return { ok: true, data: undefined };
}

/**
 * Qué cobro se toca y con qué (T3, C-AS2). El gate se elige por el lado: el copago lo registra quien cobra
 * (`canCollectCopago`) y lleva el medio; la obra social la confirma `billing.manage` (`canConfirmInsurer`).
 */
type BillingToggle = { side: "copago"; mark: CopagoMarkInput } | { side: "insurer"; paid: boolean };

/**
 * Lo que `setBookingCopagoPaid` acepta del cliente (C-AS2). `discriminatedUnion` y no `{ paid, method? }`: «pagado
 * sin medio» no es representable (decisión 5 del 19-oct: un cobro por turno CON medio). Cualquier forma inválida
 * (sin medio, uno inventado, el `true` pelado de antes de T3 desde una pestaña vieja) cae en el mismo «Elegí cómo
 * pagó.» sin escribir.
 */
const CopagoMarkSchema = z.discriminatedUnion("paid", [
  z.object({ paid: z.literal(true), method: z.enum(PAYMENT_METHODS) }).strict(),
  z.object({ paid: z.literal(false) }).strict(),
]);

/**
 * Shared body of the two Facturación toggles (A2a-S06). Before: lookup and
 * update in two separate transactions, `where: { id }` only on the write, no
 * optimistic lock and no access check — a second quick toggle (or another
 * tab) silently overwrote the first, and a basic-access kine could mark a
 * foreign patient's copago as cobrado. Now: one transaction, tenant-scoped
 * write guarded by `updatedAt`, and the new `updatedAt` goes back to the
 * client so its next toggle isn't stale.
 *
 * T3 (C-AS2, plan §23.4): orden notfound → stale → gate → Mercado Pago. El gate ya NO es `hasFullAccess`: con él
 * nadie no clínico podía cobrar (Secretaria, Facturación, Admin y Titular sin agenda son nivel `admin` sobre los
 * pacientes; /sala le mostraba «Cobrar» al Admin y el server lo rechazaba, hallazgo §23.2 y AUDIT §5.35 enmendado).
 * El cobro es un dato administrativo del TURNO, no acceso a la HC: se decide con las capabilities del rol
 * (`actorCapsInTx`, la membresía leída en ESTA tx) y el profesional del turno. Sale además más barato: una lectura de
 * la membresía (+ el pago de MP en el copago) en lugar de paciente + settings + membresía + share.
 */
async function toggleBilling(
  id: string,
  toggle: BillingToggle,
  expectedUpdatedAt: string | undefined
): Promise<ActionResult<{ updatedAt: Date; method: PaymentMethod | null; notice?: string }>> {
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
        // T3 (M12): re-marcar con otro medio corrige solo el medio y audita de cuál a cuál.
        copagoPaymentMethod: true,
      },
    });
    if (!row) return { kind: "notfound" as const };
    if (expectedUpdatedAt && +row.updatedAt !== +new Date(expectedUpdatedAt)) {
      return { kind: "stale" as const };
    }
    const caps = await actorCapsInTx(tx, actor);
    if (toggle.side === "copago" && !canCollectCopago(caps, actor.practitionerId, row.practitionerId)) {
      // `collectOwn` sin ser su turno vs. un rol que no cobra nada: dos copys distintos (C-AS2).
      return { kind: "forbidden" as const, error: caps.has("billing.collectOwn") ? COLLECT_COPY.ownOnly : COLLECT_COPY.roleCannotCollect };
    }
    if (toggle.side === "insurer" && !canConfirmInsurer(caps)) {
      return { kind: "forbidden" as const, error: COLLECT_COPY.insurerOnly };
    }
    // P2-Z · B-M3: marcar/desmarcar el cobro de un turno de plan CANCELLED o
    // NO_SHOW cambia si la cuota de su sesión "ya se pagó" (cobro previo,
    // `priorPaidStamp`). El turno que la reemplaza tiene que acompañar en la
    // MISMA tx: si no, desmarcar dejaba el reemplazo en $0 para siempre y
    // marcar después de estampar a precio pleno cobraba la sesión dos veces.
    // Lock del paciente PRIMERO (C2: va antes que cualquier fila, incluido el
    // FOR UPDATE del turno de T3-Z más abajo; la lectura de arriba no lockea)
    // — serializa con el reprecio y el motor, que deciden la plata de la misma
    // sesión. Los turnos activos o sueltos no pagan nada.
    const planPrior = row.sessionId != null && row.patientId != null && (row.status === "CANCELLED" || row.status === "NO_SHOW");
    if (planPrior) await lockPlanPatient(tx, { tenantId: actor.tenantId, patientId: row.patientId! });
    // T5 (C-TP10): plata online del turno, leída después del lock (solo en el copago).
    let online: { depositCents: number; liveLinkIds: string[]; withTurnero: boolean } | null = null;
    if (toggle.side === "copago") {
      // T3-Z (B3): la fila del turno se toma ANTES de leer el `Payment`, como el webhook de MP (`consumeWebhook`:
      // Booking FOR UPDATE → Payment). Sin esto, con un turno marcado a mano, un webhook «approved» en vuelo escribe
      // el `Payment` PAID sin tocar el turno (ya estaba PAID: no cambia `updatedAt`), esta lectura no lo ve (todavía
      // sin commitear), el CAS por `updatedAt` pasa igual y el desmarcar deja el turno «por cobrar» con la plata de
      // MP acreditada: la recepción cobraría dos veces. Con el lock, uno espera al otro y la lectura de abajo (otra
      // sentencia, snapshot nuevo) ve el pago. Va en su propia sentencia a propósito: un JOIN con el Payment en el
      // mismo SELECT … FOR UPDATE leería el Payment con el snapshot de ANTES de esperar. +1 sentencia solo en el
      // copago (marcar del Titular: 10 → 11, dentro del techo de as1c-cobros); la OS no lee el pago.
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${id} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
      // Default del 19-oct: un cobro de Mercado Pago no se desmarca ni se cambia a mano. Desmarcarlo dejaría el turno
      // «por cobrar» con la plata ya acreditada (la recepción cobraría dos veces) y el webhook no lo volvería a
      // marcar; AUTHORIZED es MP reteniendo el pago, que todavía puede acreditarse. Solo en el copago: confirmar la
      // obra social no toca lo que pagó el paciente.
      //
      // T5 (C-TP10, literal): UNA sentencia reemplaza el `payment.findUnique` y trae, además del `Payment` legado
      // (PAID aunque el turno se haya desmarcado antes de T3), los cobros online del turno (`OnlineCharge`): FULL PAID
      // (pagado entero online), alguno AUTHORIZED (en proceso), Σ de las señas PAID y los links vivos. Va DESPUÉS del
      // FOR UPDATE de arriba y en su propia sentencia (snapshot nuevo): el webhook nuevo toma el mismo lock del turno
      // antes de tocar el cobro (§25.3 «Locks»), así quien esperó ve lo que el webhook commiteó. Las señas reales se
      // leen acá y no de `row.onlineDepositCents` (leído ANTES del lock); si el trigger de M18 movió la seña, también
      // movió `updatedAt` y el CAS de abajo da stale igual. Mismo número de sentencias que antes (techo as1c ≤12).
      //
      // TP-ZF1 (M2, enmienda de C-TP10): `liveLinkIds` incluye el cobro TURNERO ACTIVE si el turno NO está PENDING (un
      // «Pagar ahora» OPTIONAL con checkout de 48 h: cobrarlo a mano y dejarlo vivo era un doble cobro). Con el turno
      // PENDING (REQUIRED) el cobro ES la reserva: no se toca. El estado sale de la fila YA bloqueada (`turneroToo`), no
      // de `row` (leído antes del lock). Misma sentencia: +0.
      const [mp] = await tx.$queryRaw<{ legacyStatus: string | null; paidOnline: boolean; inFlight: boolean; depositPaidCents: number; liveLinkIds: string[]; turneroToo: boolean }[]>`
        WITH k AS (SELECT NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."id" = ${id} AND b."tenantId" = ${actor.tenantId} AND b."status" = 'PENDING') AS "turneroToo")
        SELECT (SELECT p."status"::text FROM "Payment" p WHERE p."bookingId" = ${id}) AS "legacyStatus",
          EXISTS (SELECT 1 FROM "OnlineCharge" c WHERE c."tenantId" = ${actor.tenantId} AND c."bookingId" = ${id} AND c."kind" = 'FULL' AND c."status" = 'PAID') AS "paidOnline",
          EXISTS (SELECT 1 FROM "OnlineCharge" c WHERE c."tenantId" = ${actor.tenantId} AND c."bookingId" = ${id} AND c."status" = 'AUTHORIZED') AS "inFlight",
          COALESCE((SELECT sum(c."amountCents") FROM "OnlineCharge" c WHERE c."tenantId" = ${actor.tenantId} AND c."bookingId" = ${id} AND c."kind" = 'DEPOSIT' AND c."status" = 'PAID'), 0)::int AS "depositPaidCents",
          COALESCE((SELECT array_agg(c."id" ORDER BY c."id") FROM "OnlineCharge" c WHERE c."tenantId" = ${actor.tenantId} AND c."bookingId" = ${id} AND (c."origin" = 'LINK' OR (k."turneroToo" AND c."origin" = 'TURNERO')) AND c."status" = 'ACTIVE'), ARRAY[]::text[]) AS "liveLinkIds",
          k."turneroToo"
        FROM k`;
      if (mp.legacyStatus === "PAID" || mp.legacyStatus === "AUTHORIZED" || row.paymentStatus === "AUTHORIZED" || mp.paidOnline) {
        const { ONLINE_COLLECT_COPY } = await import("@/lib/online-payments-copy");
        return { kind: "forbidden" as const, error: ONLINE_COLLECT_COPY.mercadoPagoLocked };
      }
      // En proceso: solo frena MARCAR (cobrar a mano mientras MP retiene un pago es cobrar dos veces si se acredita).
      // Desmarcar un cobro a mano no agrega plata: no se frena.
      if (mp.inFlight && toggle.mark.paid) {
        const { ONLINE_COLLECT_COPY } = await import("@/lib/online-payments-copy");
        return { kind: "forbidden" as const, error: ONLINE_COLLECT_COPY.mercadoPagoInFlight };
      }
      online = { depositCents: mp.depositPaidCents, liveLinkIds: mp.liveLinkIds, withTurnero: mp.turneroToo };
    }
    // Q8 (C5, cierra parcialmente AUDIT:940): un turno fuera de plan sin copago
    // propio (`copagoCents` null) se COBRA por el copago resuelto en lectura
    // (precedencia §5.5 de lib/copago.ts, la misma que la agenda). Si no se
    // congela, cambiar después la cobertura o el precio del servicio cambiaba
    // retroactivamente cuánto "se cobró". Un turno de plan nunca entra acá
    // (`pricedByPlan` ⇒ copago no nulo, CHECK). Solo al marcar cobrado.
    let frozen: { copagoCents: number } | null = null;
    if (toggle.side === "copago" && toggle.mark.paid && row.copagoCents == null) {
      // CF3 PR-C1 (D-CF3-1/2): se congela con el precio del profesional ACTUAL del turno (`row.practitionerId`, leído
      // en esta tx): hasta acá el monto lo siguió al reasignar; desde acá `copagoCents` queda fijo y la escalera ya no
      // se consulta. El precio sale en la MISMA sentencia que el del servicio (LEFT JOIN, +0: el techo de as1c-cobros
      // ≤ 12 ya tenía al marcar 11) — `include` de Prisma serían dos. `tenantId` a mano en las dos tablas.
      const [coverage, particularCopago, [service]] = await Promise.all([
        row.patientId
          ? tx.coverage.findFirst({
              where: { patientId: row.patientId, patient: { tenantId: actor.tenantId } },
              orderBy: { id: "desc" },
              select: { insurer: true, copagoCents: true, insurerRef: { select: { copagoCents: true, isParticular: true } } },
            })
          : Promise.resolve(null),
        getParticularCopagoCents(actor.tenantId, tx),
        tx.$queryRaw<{ priceCents: number; practitionerPriceCents: number | null }[]>`
          SELECT s."priceCents", ps."priceCents" AS "practitionerPriceCents"
          FROM "Service" s
          LEFT JOIN "PractitionerService" ps
            ON ps."serviceId" = s."id" AND ps."practitionerId" = ${row.practitionerId} AND ps."tenantId" = ${actor.tenantId}
          WHERE s."id" = ${row.serviceId} AND s."tenantId" = ${actor.tenantId}`,
      ]);
      frozen = {
        copagoCents: resolveBookingCopagoCents({
          bookingOverride: null,
          coverageOverride: coverage?.copagoCents ?? null,
          hasCoverage: !!coverage,
          insurerCopago: coverage?.insurerRef ? coverage.insurerRef.copagoCents : null,
          particularCopago,
          servicePriceCents: service?.priceCents ?? 0,
          practitionerPriceCents: service?.practitionerPriceCents ?? null,
          insurerIsParticular: coverage?.insurerRef?.isParticular === true,
        }),
      };
    }
    const now = new Date();
    // T5 (§25.8): con seña, «Pagado» cobra lo que falta (copago − señas, `copagoRemainingCents`); el copago congelado
    // sigue siendo el TOTAL (la seña no lo reescribe) y el audit lleva la seña que la recepción vio al cobrar. Solo
    // con seña: sin ella el payload queda igual que antes de T5 (`method` + `copagoCents`).
    const depositPayload = online && online.depositCents > 0 ? { depositCents: online.depositCents } : {};
    let write: Prisma.BookingUpdateManyMutationInput;
    let action: string;
    let payload: Record<string, unknown> | undefined;
    let method: PaymentMethod | null = null;
    if (toggle.side === "insurer") {
      action = toggle.paid ? "booking.insurer_paid" : "booking.insurer_unpaid";
      // Mismo bug que el copago (hallazgo de F1): el widget cuenta lo que pagó la obra social por `insurerPaidAt`.
      // Re-marcar una OS ya cobrada no la muda de mes. Se reescribe la MISMA fecha (no se omite la clave): un
      // `updateMany` sin datos devuelve count 0 y se leería como stale.
      write = { insurerPaidAt: toggle.paid ? (row.insurerPaidAt ?? now) : null };
      method = row.copagoPaymentMethod;
    } else if (toggle.mark.paid && row.paymentStatus === "PAID") {
      // P3.Z (revisor b · B1): `copagoPaidAt` es la fecha con la que el widget de ingresos cuenta el cobro en la
      // semana/mes; re-marcar uno ya PAID (otra pestaña, un doble click con el `updatedAt` nuevo) la reescribía y el
      // cobro se mudaba de mes. T3: re-marcar con OTRO medio es corregir cómo pagó («era transferencia»): cambia
      // solo el medio; ni la fecha ni quién cobró (el cobro es el mismo). Con el mismo medio, el write igual va
      // (idempotente; sube `updatedAt` como antes).
      method = toggle.mark.method;
      write = { copagoPaymentMethod: method };
      if (row.copagoPaymentMethod !== method) {
        action = "booking.copago_method_change";
        payload = { from: row.copagoPaymentMethod, to: method };
      } else {
        action = "booking.copago_paid";
        payload = { method, copagoCents: frozen?.copagoCents ?? row.copagoCents, ...depositPayload };
      }
    } else if (toggle.mark.paid) {
      // S14r (M3a) + T3 (M12): PAID, cuándo, cómo y quién, en el MISMO `updateMany` con CAS (o todo o nada; los
      // CHECK de M12 exigen el medio con PAID/REFUNDED y quién cobró solo con medio).
      method = toggle.mark.method;
      action = "booking.copago_paid";
      write = { paymentStatus: "PAID", copagoPaidAt: now, copagoPaymentMethod: method, copagoCollectedById: actor.userId };
      payload = { method, copagoCents: frozen?.copagoCents ?? row.copagoCents, ...depositPayload };
    } else {
      // Desmarcar limpia todo: el cobro deja de contar en el período y no queda un medio ni un cobrador de un cobro
      // que no existe (los CHECK de M12 tampoco lo admiten con UNPAID).
      action = "booking.copago_unpaid";
      write = { paymentStatus: "UNPAID", copagoPaidAt: null, copagoPaymentMethod: null, copagoCollectedById: null };
      payload = { method: row.copagoPaymentMethod, copagoCents: row.copagoCents };
    }
    const res = await tx.booking.updateMany({
      // El CAS por `updatedAt` ata la decisión de arriba a ESTA versión de la fila.
      where: { id, tenantId: actor.tenantId, updatedAt: row.updatedAt },
      data: { ...write, ...(frozen ?? {}) },
    });
    if (res.count === 0) return { kind: "stale" as const };
    // T5 (C-TP10): cobrar a mano anula los links vivos del turno (si no, el paciente podía pagar por MP lo que ya pagó
    // en el mostrador). +1 sentencia SOLO si hay links (techo 11 → 12). Después del CAS: un stale no anula nada. Las
    // preferencias se vencen DESPUÉS del commit (best effort: si MP falla, el guard y el consumidor igual rechazan).
    let cancelledLinkIds: string[] = [];
    if (toggle.side === "copago" && toggle.mark.paid && online && online.liveLinkIds.length > 0) {
      const { cancelLiveLinksForBookingInTx } = await import("@/lib/payment-links-internal");
      const c = await cancelLiveLinksForBookingInTx(tx, {
        tenantId: actor.tenantId,
        bookingId: id,
        reason: "collected",
        byUserId: actor.userId ?? null,
        includeTurnero: online.withTurnero,
      });
      cancelledLinkIds = c.cancelledChargeIds;
    }
    const after = await tx.booking.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { updatedAt: true },
    });
    const refs: BookingChangeRef[] = [
      { bookingId: row.id, practitionerId: row.practitionerId, scheduledFor: row.scheduledFor, kind: "booking", roomId: row.roomId },
    ];
    const sync = planPrior ? await syncPriorPaidReplacementInTx(tx, actor.tenantId, row.sessionId!, now) : null;
    if (sync?.ref) refs.push(sync.ref);
    // PL-A (plata): el cobro y su audit, o ninguno (un stale de arriba revierte los dos). Payload sin PHI: medio y
    // monto en centavos (AUDIT §5: ids y nombres de campo, nunca datos clínicos).
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action,
      entity: "Booking",
      entityId: id,
      ...(payload ? { payload } : {}),
    });
    return {
      kind: "ok" as const,
      patientId: row.patientId,
      updatedAt: after!.updatedAt,
      method,
      refs,
      notice: sync?.notice ?? null,
      cancelledLinkIds,
    };
  }).catch((e) => {
    if (e instanceof BillingReplacementStale) return { kind: "stale" as const };
    throw e;
  });
  if (outcome.kind === "notfound") return { ok: false, error: "Turno no encontrado." };
  if (outcome.kind === "stale") return { ok: false, error: STALE_ERROR };
  if (outcome.kind === "forbidden") return { ok: false, error: outcome.error };
  if (outcome.patientId) revalidatePath(`/pacientes/${outcome.patientId}`);
  await afterBookingsCommitted(actor.tenantId, outcome.refs);
  if (outcome.cancelledLinkIds.length > 0) {
    // Best effort y nunca tira: el cobro a mano ya quedó; un link anulado no se acepta aunque MP lo cobre igual (el
    // webhook lo registra y avisa, §25.6).
    // El `import()` va dentro de la cadena: si el módulo no carga, cae al mismo `catch` (nunca tira).
    const cancelledLinkIds = outcome.cancelledLinkIds;
    await import("@/lib/mp-connect/account-client")
      .then((m) => m.expirePreferencesBestEffort(actor.tenantId, cancelledLinkIds))
      .catch((err) =>
        logger.warn("toggleBilling: no se pudieron vencer las preferencias de los links anulados", {
          tenantId: actor.tenantId,
          err: err instanceof Error ? err.message : String(err),
        })
      );
  }
  return {
    ok: true,
    data: { updatedAt: outcome.updatedAt, method: outcome.method, ...(outcome.notice ? { notice: outcome.notice } : {}) },
  };
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
          // T5 (TP-2g/TP-2i): la seña online cuenta como cobro (`bookingHasMoney`, `priorPaidStamp`). Escalar.
          onlineDepositCents: true,
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
 *
 * T3 (C-AS2): gate «insurer» = `canConfirmInsurer` (`billing.manage`: Facturación, Titular, Admin). La Secretaria
 * cobra copagos pero no confirma obra social; el profesional tampoco (antes alcanzaba el acceso full al paciente).
 */
export async function setBookingInsurerPaid(
  id: string,
  paid: boolean,
  expectedUpdatedAt?: string
): Promise<ActionResult<{ updatedAt: Date; notice?: string }>> {
  return withReadOnlyResult(async () => {
    const r = await toggleBilling(id, { side: "insurer", paid: paid === true }, expectedUpdatedAt);
    if (!r.ok) return r;
    return { ok: true as const, data: { updatedAt: r.data.updatedAt, ...(r.data.notice ? { notice: r.data.notice } : {}) } };
  });
}

/**
 * Registrar / deshacer el cobro del copago de un turno (en mano: efectivo, transferencia, tarjeta…). Complementa la
 * confirmación de la OS, así Facturación sigue los dos lados.
 *
 * T3 (C-AS2, plan §23.4; decisiones 1 y 5 del 19-oct): `input` = `{ paid: true, method }` (el medio es obligatorio:
 * «Elegí cómo pagó.») o `{ paid: false }`. Gate «copago» = `canCollectCopago` (la Secretaria, Facturación, el
 * Titular y el Admin cobran cualquier turno; el profesional, solo los suyos). Devuelve el `updatedAt` nuevo en ISO
 * (la próxima acción sobre la fila lo manda como `expectedUpdatedAt`) y el medio que quedó (`null` al desmarcar).
 *
 * S14r (M3a): `copagoPaidAt` = cuándo se marcó cobrado; es la fecha con la que el widget de ingresos cuenta el
 * copago en la semana/mes. Desmarcar la limpia. Va en el mismo `updateMany` con CAS que el `paymentStatus`, el medio
 * y quién cobró (y la re-sincronización del cobro previo de P2-Z sigue igual en `toggleBilling`): o cambian todos o
 * ninguno. Re-marcar uno que ya estaba PAID no mueve la fecha (P3.Z); con otro medio corrige solo el medio.
 */
export async function setBookingCopagoPaid(
  id: string,
  input: CopagoMarkInput,
  expectedUpdatedAt?: string
): Promise<ActionResult<{ updatedAt: string; method: PaymentMethod | null; notice?: string }>> {
  const parsed = CopagoMarkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: COLLECT_COPY.methodRequired };
  return withReadOnlyResult(async () => {
    const r = await toggleBilling(id, { side: "copago", mark: parsed.data }, expectedUpdatedAt);
    if (!r.ok) return r;
    return {
      ok: true as const,
      data: { updatedAt: r.data.updatedAt.toISOString(), method: r.data.method, ...(r.data.notice ? { notice: r.data.notice } : {}) },
    };
  });
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
// BO3-F: el cuerpo va en `createBookingsBatchImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function createBookingsBatch(
  ...args: Parameters<typeof createBookingsBatchImpl>
): Promise<ActionResult<BatchOutcome>> {
  return withReadOnlyResult(() => createBookingsBatchImpl(...args));
}

async function createBookingsBatchImpl(
  raw: BookingBatchCreateInput & {
    idempotencyKey?: string;
    dryRun?: boolean;
    allowOverbooking?: boolean;
    // SR (SR-D7): escribir también las fechas con la sala llena u ocupada
    // (`BatchDateOutcome.roomBusy`). No es sobreturno (SR-D2).
    allowRoomConflict?: boolean;
    // T3 (C-AS3): «Agendar igual esas fechas» — escribir también las fechas que
    // pasan el tope por intervalo (`BatchDateOutcome.intervalCapped`). ES
    // sobreturno (decisión 6). Sin el flag esas fechas se omiten.
    allowIntervalCap?: boolean;
  }
): Promise<ActionResult<BatchOutcome>> {
  const actor = await getActor();
  const parsed = BookingBatchCreate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const data = parsed.data;
  // PL-2f: misma regla que `createBooking` (sala elegida sin el módulo → 403, sin escribir ni previsualizar).
  assertRoomModule(actor, data.roomId);
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
  // paciente (solape propio / duplicado), con `BOOKING_LOOKBACK_MIN` (480) hacia atrás.
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
  // T3 (C-AS3): tope efectivo del profesional (del loader, 0 sentencias). El loader trae TODOS los turnos del
  // profesional en el rango (no acota por servicio), que es lo que el tope necesita para contar inicios.
  const icap = input.intervalCaps[data.practitionerId] ?? null;
  // CF (§28, ADR-032, CF-D4): «no atiende servicios distintos a la vez», del mismo loader (0 sentencias), igual que el
  // alta suelta. El lote no tiene aviso propio: la fecha que pisa otro servicio sube a «sobreturno» (se fuerza con
  // `allowOverbooking`) y queda el flag informativo `otherServiceBusy`. Se usa el MISMO valor en el preflight y en
  // el re-conteo de cada fecha, para que una fecha no pueda decir «libre» en uno y contar otro servicio en el otro
  // por la regla (sí por lo commiteado en el medio, que es lo que el re-conteo está para ver).
  const exclusiveService = input.agendaRules[data.practitionerId]?.exclusiveService ?? true;

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
      intervalCap: icap,
      ...(exclusiveService ? { exclusiveService: true } : {}),
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
      intervalCapped: c.intervalCapped === true,
      otherServiceBusy: c.otherServiceBusy === true,
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
    // T3 (C-AS3): ídem (sin tope, la forma de la respuesta no cambia).
    ...(p.intervalCapped ? { intervalCapped: true } : {}),
    // CF (CF-D4): ídem; el status ya subió a "sobreturno" en el motor. Con `allowParallelServices`, sin la clave.
    ...(p.otherServiceBusy ? { otherServiceBusy: true as const } : {}),
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

  for (const [i, slot] of plan.entries()) {
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
    // T3 (C-AS3): tope por intervalo lleno en el preflight y sin «Agendar igual» → se omite (sin tx).
    if (slot.intervalCapped && !raw.allowIntervalCap) {
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
        // SR, C2 (1b) y T3, C2 (1c): cupo + HORA (+ sala con chequeo) de ESTA
        // fecha en una sentencia (= mismo número de statements que el lock de
        // cupo solo: el lote de 20 no admite ni una sentencia más por fecha).
        // CF, C2 (1d): + el DÍA del profesional de esta fecha, en la misma sentencia (0 sentencias nuevas): sin él, el
        // re-conteo del otro servicio no serializa con un alta de otro servicio que empieza a otra hora.
        await lockAgendaKeysMany(tx, {
          cap: capacityKeysForWindow(capWindow),
          pday: practitionerDayKeysForWindow({ tenantId: actor.tenantId, practitionerId: data.practitionerId, start: when, end }),
          hour: [hourKeyForStart({ tenantId: actor.tenantId, practitionerId: data.practitionerId, start: when })],
          rooms: roomCheck
            ? roomKeysForWindow({ tenantId: actor.tenantId, roomId: slot.room!.id, start: when, end })
            : [],
        });
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
        // T3: cupo + inicios del intervalo en la MISMA sentencia (sin tope, la
        // query de siempre). Re-conteo con la clave de hora tomada: si alguien
        // llenó el intervalo después del preflight, la fecha se omite sin el flag.
        const occ = await countAgendaOccupancy(tx, {
          tenantId: actor.tenantId,
          practitionerId: data.practitionerId,
          serviceId: service.id,
          start: when,
          end,
          now,
          excludeKey: idempotencyKey,
          cap: icap,
          // CF: otro servicio en la MISMA sentencia (CF-D3: el paciente del lote exime a sus propios turnos).
          exclusiveService,
          patientId: data.patientId ?? null,
        });
        // CF (CF-D4): otro servicio con el día tomado = sobreturno (plegado en `allowOverbooking`). Ve también lo
        // commiteado después del preflight. `liveBlocked` no necesita la regla: re-clasifica sin turnos (solo
        // bloqueos), y el otro servicio sale de este conteo.
        const otherBusy = occ.otherService.count > 0;
        const capOver =
          slot.status === "sobreturno" || liveBlocked || otherBusy || overlapBlocks(occ.overlap, rule.cap);
        if (capOver && !raw.allowOverbooking) return { kind: "omitted" as const, otherBusy };
        // Flag propio (no `allowOverbooking`): forzar el cupo no fuerza el tope, ni al revés.
        const intervalFull = intervalCapVerdict(occ.intervalStarts, icap, when)?.state === "full";
        if (intervalFull && !raw.allowIntervalCap) return { kind: "omitted" as const, otherBusy };
        const isOverbook = capOver || intervalFull;
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
          if (slot.room && typeof data.roomId === "string") return { kind: "omitted" as const, otherBusy };
          if (loc && !(await lockActiveLocation(tx, actor.tenantId, loc))) {
            if (data.locationId) return { kind: "omitted" as const, otherBusy };
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
          if (occ.atCapacity) return { kind: "omitted" as const, otherBusy };
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
        return { kind: "ok" as const, isOverbook, row, otherBusy };
      });
      // CF: el re-conteo vio otro servicio que el preflight no (commiteado en el medio): se informa en esa fecha,
      // como lo hubiera dicho el preflight (el status queda el del preflight, igual que con un bloqueo en vivo).
      if (w.otherBusy && !datesOut[i].otherServiceBusy) datesOut[i] = { ...datesOut[i], otherServiceBusy: true };
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
      // BO3-F: la tx de la fecha chocó contra el modo lectura / soporte: no se escribió nada y las demás fechas
      // chocarían igual. Se corta con el copy en vez de contarla como «omitida» y devolver ok con 0 creados.
      const ro = readOnlyFailure(e);
      if (ro) return ro;
      // A patient+instant collision that the preflight missed (someone else
      // booked it in between) is a DUPLICATE, not a mystery failure — the old
      // catch-all lumped it into "omitidos por conflicto" with no explanation.
      // Same resolver as the single-create path, so it also works under RLS
      // (`meta.target` null) and a same-key concurrent double submit of the
      // batch counts the slot as created instead of duplicated.
      const r = await resolveUniqueViolation(actor.tenantId, e, idempotencyKey);
      if (r.kind === "existing") {
        created++;
        if (slot.status === "sobreturno" || slot.intervalCapped) sobreturnos++;
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
