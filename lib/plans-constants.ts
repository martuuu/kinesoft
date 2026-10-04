/**
 * Constantes de Planes de tratamiento (PLANES.md P0-Ck, ES1).
 *
 * Puro: lo importan server (keys, validación, motor) y UI (editor). Se publica
 * en P0.0, antes que sus consumidores, para que las sesiones paralelas de
 * P0.1 compilen contra valores congelados en vez de repetir números mágicos.
 */

/**
 * Prefijo de la `idempotencyKey` de un turno generado por un plan:
 * `plan:<generationId>:<index>` (C3). Es un espacio reservado al motor, como
 * `pub:` para el turnero: `createBooking` y el batch rechazan keys de cliente
 * con este prefijo (S07k), si no un cliente podría colisionar con la key de un
 * turno de plan y entrar a la rama `update` del upsert.
 */
export const PLAN_KEY_PREFIX = "plan:";

/**
 * Tope de sesiones en planes, plantillas, Diagnóstico y el editor (PD-04).
 * Coincide con el tope de `expandDates` (60). Los legacy con más se respetan,
 * pero no se generan turnos para el excedente.
 */
export const PLAN_MAX_SESSIONS = 60;

/**
 * Duración efectiva de una sesión de plan (override ?? PS ?? Service), en
 * minutos. Es el rango de `BookingCreate`/`BookingUpdate` (15..240) y el
 * lookback del loader (240): un turno más largo no lo vería el motor. El CHECK
 * `TreatmentProgram_duration_check` de M1 usa los mismos números.
 */
export const PLAN_MIN_DURATION = 15;
export const PLAN_MAX_DURATION = 240;

/**
 * Disciplina de un plan / servicio. Espeja el enum Postgres `"Discipline"`
 * que crea M1 (`plans_booking_link`); hasta que exista en el cliente Prisma
 * vive como unión literal. Cuando M1 entre, `Prisma.Discipline` tiene que
 * seguir siendo asignable a este tipo (y viceversa).
 */
export const DISCIPLINES = ["KINESIOLOGY", "OSTEOPATHY"] as const;
export type Discipline = (typeof DISCIPLINES)[number];

/**
 * Slugs de los 2 tags `DISCIPLINE` del catálogo global que inserta M1
 * (`tag_discipline_kinesiologia`, `tag_discipline_osteopatia`). Filtran la
 * biblioteca por disciplina (S13x) y quedan reservados: `ensureTag` no deja
 * crearlos desde la UI.
 */
export const DISCIPLINE_TAG_SLUGS: Readonly<Record<Discipline, string>> = {
  KINESIOLOGY: "kinesiologia",
  OSTEOPATHY: "osteopatia",
};
