/**
 * Reglas de agenda por profesional (CF, §28 del plan; decisiones 1, 3 y 6 de Martin del 30-oct; M20) — puro, sin DB.
 *
 *   • «Atiende servicios distintos a la vez» (`Practitioner.allowParallelServices`, default false): el cupo era SOLO
 *     profesional + servicio, así que un turno de Evaluación no frenaba uno de Kinesiología del mismo profesional a la
 *     misma hora. `exclusiveService = !allowParallelServices`; NO hereda del consultorio (decisión 1: es por
 *     profesional). El predicado de choque vive en `exclusive-service.ts`.
 *   • Paso del selector del staff (`agendaSlotStepMin`) y del turnero (`publicSlotStepMin`): profesional →
 *     consultorio → default. Staff: 15 (CF-D6). Turnero: null = automático por duración (`publicSlotStepFor`, AS-D9),
 *     lo resuelve quien arma la grilla pública (CF-D7), no esta función.
 *   • Anticipación mínima del turnero: `PractitionerService.minLeadMinutes` > `Practitioner.publicMinLeadMinutes`
 *     (CF2, M21, D-CF2-8) > `Tenant.publicMinLeadMinutes` > 60 (decisión 6, CF-D8).
 *
 * La herencia la decide SOLO este módulo (como `effectiveIntervalCap` para el tope de T3): el loader la aplica una vez
 * por profesional y motor, escrituras y turnero leen el resultado, así no divergen.
 */
import { PUBLIC_DEFAULT_MIN_LEAD_MINUTES } from "@/lib/availability/types";

export const SLOT_STEP_OPTIONS = [15, 30, 45, 60] as const;
export type SlotStepMin = (typeof SLOT_STEP_OPTIONS)[number];
export const DEFAULT_AGENDA_STEP_MIN: SlotStepMin = 15;
/** 8 semanas en minutos = CHECK `Tenant_publicMinLeadMinutes_check` de M20 (el turnero llega a hoy + 90 días). */
export const PUBLIC_MIN_LEAD_MAX_MINUTES = 80_640;

export function isSlotStepMin(v: unknown): v is SlotStepMin {
  return typeof v === "number" && (SLOT_STEP_OPTIONS as readonly number[]).includes(v);
}

/** Ya resuelto con la herencia. exclusiveService = !allowParallelServices. Un valor fuera de la lista = NULL (hereda). */
export type PractitionerAgendaRules = {
  exclusiveService: boolean;
  agendaStepMin: SlotStepMin;
  publicStepMin: SlotStepMin | null;
};

/** El CHECK de M20 impide en la base un paso fuera de la lista, pero el motor no confía (fila vieja, fixture, cast):
 *  un valor raro se toma como «sin configurar» y hereda, en vez de armar una grilla de 7' o de 0' (loop infinito). */
const stepOrNull = (v: number | null): SlotStepMin | null => (isSlotStepMin(v) ? v : null);

export function effectiveAgendaRules(
  prac: { allowParallelServices: boolean; agendaSlotStepMin: number | null; publicSlotStepMin: number | null },
  tenant: { agendaSlotStepMin: number | null; publicSlotStepMin: number | null }
): PractitionerAgendaRules {
  return {
    exclusiveService: !prac.allowParallelServices,
    agendaStepMin: stepOrNull(prac.agendaSlotStepMin) ?? stepOrNull(tenant.agendaSlotStepMin) ?? DEFAULT_AGENDA_STEP_MIN,
    publicStepMin: stepOrNull(prac.publicSlotStepMin) ?? stepOrNull(tenant.publicSlotStepMin),
  };
}

/** Minutos de anticipación aceptables como valor: entero ≥ 0. 0 SÍ es un valor («sin anticipación»), no «vacío»: con
 *  `||` un PS en 0 caía al consultorio y el profesional que abrió turnos inmediatos no los veía en el turnero. */
const leadOrNull = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

/**
 * PS ?? profesional ?? consultorio ?? 60 (0 es un valor, no "vacío", en cada nivel).
 *
 * CF2 (D-CF2-8): el profesional entra entre el servicio y el consultorio. El pedido del cliente fue «yo quiero 3 horas
 * y el resto del consultorio 1»: sin este nivel había que cargarla servicio por servicio (y un servicio nuevo nacía con
 * la del consultorio). Va como TERCER argumento opcional, no en el medio: las llamadas de dos argumentos (`[CF-K2]`,
 * los callers de antes de M21) siguen dando exactamente lo mismo.
 */
export function effectivePublicMinLead(
  psMinLead: number | null | undefined,
  tenantMinLead: number | null | undefined,
  practitionerMinLead?: number | null
): number {
  return (
    leadOrNull(psMinLead) ??
    leadOrNull(practitionerMinLead) ??
    leadOrNull(tenantMinLead) ??
    PUBLIC_DEFAULT_MIN_LEAD_MINUTES
  );
}
