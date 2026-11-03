import type { TenantVertical } from "@prisma/client";

/**
 * Columnas del directorio de pacientes (EV1-B; CF2 §29). Las comparten el encabezado (`PatientsListHead`) y las filas
 * (`PatientsList`): si se desalinean, cada celda cae bajo el título equivocado. Va en un módulo puro (sin "use client")
 * para que también lo lea un Server Component y los tests sin montar nada.
 *
 * CF2 (decisión 3 de Martin): «Plan activo» salió para todos (el plan queda en la ficha), así que la grilla ya no
 * depende de módulos ni de rol: checkbox · Nombre y apellido · Obra social · Próx. turno · Última visita ·
 * Kinesiólogo/Profesional · Estado · acciones. La columna de profesionales toma el ancho que dejó el plan (dos líneas
 * de nombre; ver `practitionerCellView`).
 */
export function patientsGridColumns(): string {
  return "28px 1.7fr 1fr 1fr 100px 1.4fr 90px 40px";
}

/**
 * Rótulo de la columna de profesionales (CF2, decisión 2). Mismo criterio que `roleLabel` (lib/role-label.ts): en un
 * consultorio General el que atiende es «Profesional»; en Kinesiología, «Kinesiólogo».
 */
export function practitionerColumnLabel(vertical: TenantVertical): string {
  return vertical === "GENERAL" ? "Profesional" : "Kinesiólogo";
}

/** Nombre de un profesional cuyo id no está en el mapa (no debería pasar: el mapa trae también suspendidos y quitados). */
export const PRACTITIONER_NAME_FALLBACK = "Profesional";
/** Paciente sin profesional a cargo y sin turnos próximos ni del último mes. */
export const NO_PRACTITIONER_TEXT = "Consultorio común";
/** Nombres que entran en la celda antes del «+N» (dos líneas: la fila mide lo mismo que nombre + DNI). */
const VISIBLE_PRACTITIONERS = 2;

export type PractitionerCellView = {
  empty: boolean;
  visible: { name: string; assigned: boolean }[];
  /** Cuántos quedan fuera de `visible` (el «+N»). */
  extra: number;
  /** Todos, en orden, para el `title` y el texto de lectores: «Ana López (a cargo), Beto Ruiz». */
  full: string;
};

/**
 * Celda «Kinesiólogo»/«Profesional» (CF2, decisión 2 de Martin: «el a cargo + los que tienen turnos con ese
 * paciente»). `practitionerIds` ya viene ordenado del server (`patientPractitionerIds`: a cargo primero); igual se
 * re-asegura acá que el a cargo vaya primero y una sola vez, porque la marca «a cargo» se apoya en eso y una fila
 * vieja del cache (W2: campos opcionales) podría no traerlo. Nunca se muestra un id: sin nombre, «Profesional».
 */
export function practitionerCellView(
  practitionerIds: readonly string[],
  assignedPractitionerId: string | null | undefined,
  names: Readonly<Record<string, string>>,
): PractitionerCellView {
  const ids = assignedPractitionerId
    ? [assignedPractitionerId, ...practitionerIds.filter((id) => id !== assignedPractitionerId)]
    : [...new Set(practitionerIds)];
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { empty: true, visible: [], extra: 0, full: NO_PRACTITIONER_TEXT };
  const all = unique.map((id) => ({
    name: names[id] ?? PRACTITIONER_NAME_FALLBACK,
    assigned: id === assignedPractitionerId,
  }));
  return {
    empty: false,
    visible: all.slice(0, VISIBLE_PRACTITIONERS),
    extra: Math.max(0, all.length - VISIBLE_PRACTITIONERS),
    full: all.map((p) => (p.assigned ? `${p.name} (a cargo)` : p.name)).join(", "),
  };
}
