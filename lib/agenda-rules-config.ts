/**
 * Configuración de las reglas de agenda (CF, §28; M20) — puro y client-safe, SIN zod (precedente
 * `lib/booking-cap-config.ts`). Lo usan los setters de consultorio y de profesional (CF-A) y las tarjetas de UI (CF-U*).
 *
 * La regla de la base (CHECK de M20): pasos en 15/30/45/60 o NULL; anticipación 0..80 640 minutos o NULL. Se valida
 * ACÁ antes de escribir para devolver un copy claro y el campo a marcar: un CHECK que rebota en la base sale como 500
 * («No pudimos guardar») y no le dice a nadie qué corregir.
 *
 * Qué significa cada valor (herencia, defaults) lo decide `lib/availability/agenda-rules.ts`: esto solo valida y
 * rotula lo que se guarda. Vacío (null/undefined/"") = NULL = hereda.
 */
import {
  DEFAULT_AGENDA_STEP_MIN,
  PUBLIC_MIN_LEAD_MAX_MINUTES,
  SLOT_STEP_OPTIONS,
  isSlotStepMin,
  type SlotStepMin,
} from "@/lib/availability/agenda-rules";

export { DEFAULT_AGENDA_STEP_MIN, PUBLIC_MIN_LEAD_MAX_MINUTES, SLOT_STEP_OPTIONS, type SlotStepMin };

export const AGENDA_RULES_COPY = {
  agendaStep: "El intervalo de horarios de la agenda puede ser de 15, 30, 45 o 60 minutos.",
  publicStep: "El intervalo de horarios del turnero puede ser automático o de 15, 30, 45 o 60 minutos.",
  minLead: "La anticipación mínima del turnero va de 0 horas a 8 semanas.",
  allowParallel: "Indicá si el profesional atiende servicios distintos a la vez.",
  allowParallelLabel: "Atiende servicios distintos a la vez",
  allowParallelHint:
    "Apagado, no se le dan dos turnos de servicios distintos en el mismo horario (el mismo servicio sigue hasta su cupo). En la agenda se puede forzar como sobreturno; en el turnero no se ofrece.",
  /** Aviso del chip del selector (tooltip / lector de pantalla) cuando el horario choca con otro servicio. Mismo cierre
   *  que el cupo y el tope («si confirmás»): elegir el chip no carga nada todavía. */
  otherServiceNotice: "Atiende otro servicio: se carga como sobreturno si confirmás",
  /** CF-U2: línea corta del chip y de la leyenda / título del aviso en vivo. */
  otherServiceLine: "Atiende otro servicio",
  /** CF-U2: el aviso en vivo cuando gana otra clase (sobreturno, bloqueado…) pero el profesional igual atiende otro
   *  servicio ahí: el alta va a pedir el sobreturno también por esto. */
  otherServiceAlso: "También atiende otro servicio en ese horario: se carga como sobreturno si confirmás",
  inheritTenant: "Usar el del consultorio",
  publicStepAuto: "Automático (según la duración del servicio)",
} as const;

/**
 * CF-U2: aviso en vivo del modal con `InstantCheck.class === "otro-servicio"` (decisión 2: el staff avisa y deja forzar).
 * Sin nombre (el modal en «cualquiera» todavía sin resolver) cae a «el profesional»: no se inventa uno.
 */
export function otherServiceLiveText(practitionerName?: string | null): string {
  const who = practitionerName?.trim() ? practitionerName.trim() : "el profesional";
  return `En ese horario ${who} atiende otro servicio. Se carga como sobreturno si confirmás.`;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";

/** Entero ≥ 0 en número o string de dígitos («1e3», «15.0», «2h» no: no se adivina). */
function toNonNegativeInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

export function parseSlotStep(
  v: unknown,
  kind: "agenda" | "public" = "agenda"
): { ok: true; value: SlotStepMin | null } | { ok: false; error: string } {
  if (isEmpty(v)) return { ok: true, value: null };
  const n = toNonNegativeInt(v);
  if (!isSlotStepMin(n)) {
    return { ok: false, error: kind === "public" ? AGENDA_RULES_COPY.publicStep : AGENDA_RULES_COPY.agendaStep };
  }
  return { ok: true, value: n };
}

type Fail<F extends string> = { ok: false; error: string; field: F };

/** Lo que se guarda en `Tenant` (todas las columnas de M20 del consultorio). */
export type TenantAgendaRulesWrite = {
  agendaSlotStepMin: SlotStepMin | null;
  publicSlotStepMin: SlotStepMin | null;
  publicMinLeadMinutes: number | null;
};

export function parseTenantAgendaRules(input: {
  agendaSlotStepMin?: unknown;
  publicSlotStepMin?: unknown;
  publicMinLeadMinutes?: unknown;
}): { ok: true; data: TenantAgendaRulesWrite } | Fail<keyof TenantAgendaRulesWrite> {
  const agenda = parseSlotStep(input.agendaSlotStepMin, "agenda");
  if (!agenda.ok) return { ...agenda, field: "agendaSlotStepMin" };
  const pub = parseSlotStep(input.publicSlotStepMin, "public");
  if (!pub.ok) return { ...pub, field: "publicSlotStepMin" };
  let lead: number | null = null;
  if (!isEmpty(input.publicMinLeadMinutes)) {
    lead = toNonNegativeInt(input.publicMinLeadMinutes);
    if (lead == null || lead > PUBLIC_MIN_LEAD_MAX_MINUTES) {
      return { ok: false, error: AGENDA_RULES_COPY.minLead, field: "publicMinLeadMinutes" };
    }
  }
  return { ok: true, data: { agendaSlotStepMin: agenda.value, publicSlotStepMin: pub.value, publicMinLeadMinutes: lead } };
}

/** Lo que se guarda en `Practitioner` (las columnas de M20 del profesional). */
export type PractitionerAgendaRulesWrite = {
  allowParallelServices: boolean;
  agendaSlotStepMin: SlotStepMin | null;
  publicSlotStepMin: SlotStepMin | null;
};

export function parsePractitionerAgendaRules(input: {
  allowParallelServices?: unknown;
  agendaSlotStepMin?: unknown;
  publicSlotStepMin?: unknown;
}): { ok: true; data: PractitionerAgendaRulesWrite } | Fail<keyof PractitionerAgendaRulesWrite> {
  // Obligatorio y booleano: la columna es NOT NULL y un «"true"» o un ausente que se tomara como false le cambiaría la
  // regla al profesional sin que nadie lo haya tocado.
  if (typeof input.allowParallelServices !== "boolean") {
    return { ok: false, error: AGENDA_RULES_COPY.allowParallel, field: "allowParallelServices" };
  }
  const agenda = parseSlotStep(input.agendaSlotStepMin, "agenda");
  if (!agenda.ok) return { ...agenda, field: "agendaSlotStepMin" };
  const pub = parseSlotStep(input.publicSlotStepMin, "public");
  if (!pub.ok) return { ...pub, field: "publicSlotStepMin" };
  return {
    ok: true,
    data: { allowParallelServices: input.allowParallelServices, agendaSlotStepMin: agenda.value, publicSlotStepMin: pub.value },
  };
}
