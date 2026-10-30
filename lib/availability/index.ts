/**
 * Motor de disponibilidad de B-pre (puro, sin DB): punto de entrada único.
 * La carga vive aparte en `lib/availability-loader.ts` (server-only, B2.2).
 *
 *   types       contrato (B2.0)
 *   day         DayKey ↔ instantes, `@db.Date` ↔ DayKey (B2.1a)
 *   ranges      franjas efectivas y candado del día (B2.1a)
 *   slots       grilla de turnos ofrecibles (B2.1a)
 *   classify    clase de un instante + status del batch (B2.1b)
 *   next-free   próximo hueco y "cualquier profesional" (B2.1b)
 *   recurrence  fechas semanal / cada 2 semanas / mensual (B2.1b)
 *   plan        motor puro de Planes: expandPlanDates, classifyPlanRows,
 *               suggestRowSlot, stateToken y tipos C6/C7 (S07p, ES1)
 *   rooms       salas (SR1a): defaultRoomFor, roomOccupancyAt, roomAssignmentsFor
 *   interval-cap  tope de turnos por intervalo (T3, C-AS3): effectiveIntervalCap,
 *               arIntervalWindow/arIntervalKeyOf/arHourKeyOf, intervalStartsUsed, intervalCapState
 *   agenda-rules  reglas de agenda por profesional (CF, M20): effectiveAgendaRules, effectivePublicMinLead,
 *               SLOT_STEP_OPTIONS / isSlotStepMin
 *   exclusive-service  «ya atiende otro servicio» (CF, M20): isOtherServiceConflict, otherServiceConflicts.
 *               El motor lo aplica solo con la regla: `ClassifyInstantInput.exclusiveService` (clase
 *               "otro-servicio" y lote), `BuildSlotsInput.exclusive` (razón "otro-servicio"),
 *               `FirstFreeAcrossInput.agendaRules[pid].exclusiveService` y `ClassifyPlanRowsInput.exclusiveService`
 *               (Planes: plegado en el cupo). Quien arma el input lo saca de `AvailabilityInput.agendaRules[pid]`.
 */
export * from "@/lib/availability/types";
export * from "@/lib/availability/day";
export * from "@/lib/availability/ranges";
export * from "@/lib/availability/slots";
export * from "@/lib/availability/classify";
export * from "@/lib/availability/next-free";
export * from "@/lib/availability/recurrence";
export * from "@/lib/availability/plan";
export * from "@/lib/availability/rooms";
export * from "@/lib/availability/interval-cap";
export * from "@/lib/availability/agenda-rules";
export * from "@/lib/availability/exclusive-service";
