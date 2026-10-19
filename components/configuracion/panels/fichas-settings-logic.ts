/**
 * [FC-3i] Radio «¿Quién ve la historia clínica de cada paciente?» de General: lógica pura y copy (testeable sin DOM:
 * el repo no tiene entorno de DOM en los tests de render, así que lo que decide un click vive acá).
 *
 * Archivo aparte de `mis-fichas-logic.ts` a propósito: lo que importan los DOS chunks (General y «Mis fichas») lo
 * junta webpack en un chunk compartido nuevo si pasa su `minSize`, y cada chunk nuevo suma ~20 B al runtime de TODAS
 * las rutas (/agenda no tiene margen, handoff de FC-3i1). General importa solo esto.
 */
/** Valor del radio: `own` = cada profesional ve lo suyo (default), `all` = `Tenant.sharedPatientView`. */
export type HcVisibility = "own" | "all";

export const hcVisibilityOf = (sharedPatientView: boolean): HcVisibility => (sharedPatientView ? "all" : "own");

/**
 * Qué hace el cambio del radio. Ampliar a «Todos» abre la HC de cada paciente a todo el equipo clínico: pide
 * confirmación (`useConfirm`). Achicar a «Cada profesional» es la opción segura y se aplica directo. Lo mismo = nada.
 */
export function hcVisibilityChange(current: HcVisibility, next: HcVisibility): "noop" | "confirm" | "apply" {
  if (current === next) return "noop";
  return next === "all" ? "confirm" : "apply";
}

/**
 * Copy del radio (hallazgo 13 de §24.2: el texto viejo decía «El Titular y los administradores ven todo», falso desde
 * PL-1b: el rol solo ya no abre la HC, la ven si ATIENDEN; `lib/visibility.ts` regla 1 y nivel 0). Vive con su lógica
 * y no en `fichas-settings-copy.ts`: General importa solo esto.
 */
export const HC_VISIBILITY_COPY = {
  visibilityQuestion: "¿Quién ve la historia clínica de cada paciente?",
  visibilityOwn: "Cada profesional, la de sus pacientes",
  visibilityOwnHint:
    "Cada profesional ve la historia clínica de los pacientes que tiene asignados y de los que otro le compartió con «Compartir con un profesional». Recomendado.",
  visibilityAll: "Todos los profesionales del consultorio",
  visibilityAllHint: "Cualquier profesional que atiende en el consultorio ve la historia clínica de todos los pacientes.",
  visibilityRoles:
    "El Titular y los administradores la ven solo si atienden pacientes. La Secretaria y Facturación nunca ven la historia clínica, con ninguna de las dos opciones.",
  visibilityAllWarning:
    "Con esta opción no hace falta compartir: lo que se compartió paciente por paciente deja de importar mientras esté elegida.",
  widenTitle: "¿Mostrar la historia clínica de todos los pacientes a todo el equipo?",
  widenMessage:
    "Todos los profesionales que atienden en el consultorio van a ver la historia clínica completa de cada paciente, también la de los que no atienden ellos. Podés volver a «Cada profesional» cuando quieras.",
  widenConfirm: "Mostrar a todos",
  widenCancel: "Dejar como está",
  supportNote: "Como soporte no podés cambiar quién ve la historia clínica: lo decide el consultorio.",
} as const;
