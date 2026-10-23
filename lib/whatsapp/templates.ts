/**
 * WA-P1 (T6, C-WA2, brief §26.5) · Plantillas de WhatsApp y la ÚNICA entrada de parámetros (WA-D16/WA-D20).
 *
 * Por qué una sola puerta: los mensajes salen a Meta, que no es un encargado de tratamiento de datos de salud del
 * consultorio (Ley 25.326, datos sensibles). El servicio («Rehabilitación de LCA»), las notas, el título/diagnóstico
 * del turno y hasta el profesional («Lic. X, traumatología») dicen algo de la salud del paciente. `buildTemplateParams`
 * recibe un objeto con forma fija y saca SOLO nombre, consultorio, fecha/hora AR y conteo: aunque el caller le pase el
 * turno entero, el resto no se lee. `tests/unit/wa-p1-templates.test.ts` lo prueba con un turno cargado de PHI.
 *
 * Los cuerpos son los que se dan de alta en Meta (es_AR, UTILITY). Cambiar un cuerpo exige subir `specVersion` y el
 * sufijo `_vN` del nombre: Meta no deja editar una plantilla aprobada sin volver a revisión, y la cola re-arma el texto
 * de la plantilla (no guarda cuerpo), así que el nombre tiene que identificar el texto.
 */
import { toARDateKey, toARMinutes, toARDow } from "@/lib/datetime-ar";
import type { WaTemplateKey } from "@/lib/whatsapp/types";

export const TEMPLATE_FOOTER = "Respondé BAJA para no recibir más avisos.";

/** Prueba de envío (WA-D28): `hello_world` viene aprobada en toda WABA y no necesita esperar la revisión de las nuestras. */
export const TEST_TEMPLATE = { name: "hello_world", language: "en_US" } as const;

export type WaTemplateParamName = "firstName" | "clinicName" | "date" | "time" | "count";

export type WaTemplateSpec = {
  key: WaTemplateKey;
  name: string;
  language: "es_AR";
  category: "UTILITY";
  specVersion: number;
  header: "DOCUMENT" | null;
  /** `{{1}}..{{n}}` en el orden de `params`. */
  body: string;
  footer: typeof TEMPLATE_FOOTER;
  /** Botones QUICK_REPLY, en orden (el payload lo arma `buttonPayload`). */
  buttons: string[];
  params: WaTemplateParamName[];
  /** Ejemplo para el alta en Meta (lo exige la revisión), uno por param. */
  example: string[];
};

export const TEMPLATE_SPECS: Record<WaTemplateKey, WaTemplateSpec> = {
  BOOKING_CREATED: {
    key: "BOOKING_CREATED",
    name: "cs_turno_agendado_v1",
    language: "es_AR",
    category: "UTILITY",
    specVersion: 1,
    header: null,
    body: "Hola {{1}}, tu turno en {{2}} quedó agendado para el {{3}} a las {{4}} h.",
    footer: TEMPLATE_FOOTER,
    buttons: [],
    params: ["firstName", "clinicName", "date", "time"],
    example: ["Martina", "Consultorio Sur", "jueves 23/10", "09:30"],
  },
  BOOKING_MOVED: {
    key: "BOOKING_MOVED",
    name: "cs_turno_reprogramado_v1",
    language: "es_AR",
    category: "UTILITY",
    specVersion: 1,
    header: null,
    body: "Hola {{1}}, tu turno en {{2}} se reprogramó para el {{3}} a las {{4}} h.",
    footer: TEMPLATE_FOOTER,
    buttons: [],
    params: ["firstName", "clinicName", "date", "time"],
    example: ["Martina", "Consultorio Sur", "viernes 24/10", "16:00"],
  },
  BOOKINGS_UPDATED: {
    key: "BOOKINGS_UPDATED",
    name: "cs_turnos_actualizados_v1",
    language: "es_AR",
    category: "UTILITY",
    specVersion: 1,
    header: null,
    body: "Hola {{1}}, en {{2}} se actualizaron tus turnos: tenés {{3}} turnos y el primero es el {{4}} a las {{5}} h.",
    footer: TEMPLATE_FOOTER,
    buttons: [],
    params: ["firstName", "clinicName", "count", "date", "time"],
    example: ["Martina", "Consultorio Sur", "8", "lunes 27/10", "10:00"],
  },
  BOOKING_REMINDER: {
    key: "BOOKING_REMINDER",
    name: "cs_recordatorio_turno_v1",
    language: "es_AR",
    category: "UTILITY",
    specVersion: 1,
    header: null,
    body: "Hola {{1}}, te recordamos tu turno en {{2}} el {{3}} a las {{4}} h. ¿Vas a poder venir?",
    footer: TEMPLATE_FOOTER,
    buttons: ["Confirmo", "No puedo ir"],
    params: ["firstName", "clinicName", "date", "time"],
    example: ["Martina", "Consultorio Sur", "jueves 23/10", "09:30"],
  },
  DOCUMENT_SHARED: {
    key: "DOCUMENT_SHARED",
    name: "cs_documento_v1",
    language: "es_AR",
    category: "UTILITY",
    specVersion: 1,
    header: "DOCUMENT",
    body: "Hola {{1}}, {{2}} te compartió un documento. Lo tenés adjunto en este mensaje.",
    footer: TEMPLATE_FOOTER,
    buttons: [],
    params: ["firstName", "clinicName"],
    example: ["Martina", "Consultorio Sur"],
  },
};

// ── Fecha y hora AR ────────────────────────────────────────────────────────────────────────────────────────────

const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** «jueves 23/10» en hora AR. Sin año: los avisos son de turnos de las próximas semanas. */
export function formatWaDateAR(d: Date): string {
  const [, m, day] = toARDateKey(d).split("-");
  return `${WEEKDAYS_ES[toARDow(d)]} ${day}/${m}`;
}

/** «09:30» en hora AR. */
export function formatWaTimeAR(d: Date): string {
  const min = toARMinutes(d);
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// ── Parámetros ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Forma FIJA de la entrada: nada de servicio, notas, diagnóstico ni profesional (WA-D16). */
export type WaTemplateInput = {
  firstName: string;
  clinicName: string;
  scheduledFor?: Date | null;
  count?: number | null;
};

export type WaBuiltTemplate = {
  key: WaTemplateKey;
  name: string;
  language: "es_AR";
  bodyParams: string[];
  header: "DOCUMENT" | null;
  buttons: string[];
};

/**
 * Meta rechaza (#132018) un parámetro con saltos de línea, tabs o más de 4 espacios seguidos, y uno vacío. Se colapsa,
 * se recorta y, si queda vacío, se usa un fallback que no rompe la frase.
 */
function clean(s: string | null | undefined, max: number, fallback: string): string {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  if (!v) return fallback;
  return v.length > max ? v.slice(0, max).trimEnd() : v;
}

/**
 * Única entrada de parámetros de una plantilla (C-WA2). Lee SOLO `firstName`, `clinicName`, `scheduledFor` y `count`
 * del input, por nombre: un caller que pase el turno entero no filtra nada más. Tira si la plantilla necesita un dato
 * que no vino (bug del caller: mejor acá que un 132000 de Meta y un mensaje FAILED).
 */
export function buildTemplateParams(key: WaTemplateKey, input: WaTemplateInput): WaBuiltTemplate {
  const spec = TEMPLATE_SPECS[key];
  const firstName = clean(input.firstName, 40, "paciente");
  const clinicName = clean(input.clinicName, 60, "tu consultorio");
  const at = input.scheduledFor ?? null;
  const count = input.count ?? null;
  const bodyParams = spec.params.map((p) => {
    switch (p) {
      case "firstName":
        return firstName;
      case "clinicName":
        return clinicName;
      case "date":
      case "time":
        if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError(`${spec.name}: falta el horario`);
        return p === "date" ? formatWaDateAR(at) : formatWaTimeAR(at);
      case "count":
        if (typeof count !== "number" || !Number.isInteger(count) || count < 1)
          throw new TypeError(`${spec.name}: falta la cantidad de turnos`);
        return String(count);
    }
  });
  return { key, name: spec.name, language: spec.language, bodyParams, header: spec.header, buttons: [...spec.buttons] };
}

/**
 * El texto como lo ve el paciente (Configuración → WhatsApp muestra la vista previa; el simulador lo usa para validar
 * params). Pasa por `buildTemplateParams`, así que tiene la misma garantía de no-PHI.
 */
export function renderTemplatePreview(key: WaTemplateKey, input: WaTemplateInput): string {
  const built = buildTemplateParams(key, input);
  const body = TEMPLATE_SPECS[key].body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => built.bodyParams[Number(n) - 1] ?? "");
  return `${body}\n\n${TEMPLATE_FOOTER}`;
}
