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
 */
export * from "@/lib/availability/types";
export * from "@/lib/availability/day";
export * from "@/lib/availability/ranges";
export * from "@/lib/availability/slots";
export * from "@/lib/availability/classify";
export * from "@/lib/availability/next-free";
export * from "@/lib/availability/recurrence";
export * from "@/lib/availability/plan";
