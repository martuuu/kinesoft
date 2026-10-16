/**
 * Predicados Prisma canónicos de Planes (P2-C1, ES2b). Un solo lugar para
 * "qué es una sesión viva", "qué es sin turno", "qué plan está vinculado"
 * (R-LEGACY), "qué turno se puede adoptar" y "qué turno tiene plata".
 *
 * Por qué fragmentos `where` y no columnas: "sin turno" (C4) se DERIVA, no se
 * guarda. Una columna habría que mantenerla en cada write-path de turnos
 * (drawer, Recepción, candado, turnero, webhook MP…) y el día que uno se
 * olvide, la lista de "sesiones sin turno" miente. Con el predicado único,
 * Seguimiento, el detalle del plan, el dashboard y la agenda dicen lo mismo.
 *
 * Reglas de uso:
 *   - Son FRAGMENTOS: no llevan `tenantId` (salvo `adoptableBookingWhere`, que
 *     es el where de un CAS de escritura). El caller suma `tenantId` a mano
 *     (`Session` no tiene `tenantId`: va por `program: { tenantId }`), porque
 *     en prod la conexión tiene BYPASSRLS y el filtro explícito es la única
 *     barrera.
 *   - Se combinan con `AND: [...]` cuando el caller también filtra por el
 *     mismo campo (un spread pisaría la clave).
 *
 * Sin `server-only` a propósito: no tocan la base (son objetos), y así los
 * tests unit y los módulos puros de lectura los importan. Solo usa
 * `Prisma.DbNull` (valor runtime del cliente) en `linkedProgramWhere`; la UI
 * no tiene por qué importar este módulo.
 */
import { Prisma } from "@prisma/client";

/** Estados de un turno que lo dejan "activo" para su sesión (I2, C4): todo menos CANCELLED y NO_SHOW. */
const INACTIVE_FOR_SESSION = ["CANCELLED", "NO_SHOW"] as const;

/**
 * "Tiene plata": mismo criterio que `bookingHasMoney` (`lib/plan-pricing.ts`) y
 * que `cancelBookingsInTx` (`lib/bookings-cancel-internal.ts`, `MONEY`):
 * PAID, AUTHORIZED o REFUNDED, en el copago o en el `Payment` de MP, o la OS
 * ya pagada. AUTHORIZED cuenta porque la plata está retenida; REFUNDED porque
 * hubo un movimiento que no se puede pisar. S14 suma el test de paridad de los
 * tres.
 */
const MONEY_STATUSES = ["PAID", "AUTHORIZED", "REFUNDED"] as const;

/** Sesión viva = no archivada (§2.4). Las archivadas no cuentan para nada: ni ordinal, ni I5, ni "sin turno". */
export const liveSessionWhere = {
  archivedAt: null,
} satisfies Prisma.SessionWhereInput;

/**
 * Plan vivo = no archivado (§2.4). "Activo" para cualquier lector es
 * `status: 'ACTIVE'` **y** esto: `{ ...liveProgramWhere, status: 'ACTIVE' }`.
 */
export const liveProgramWhere = {
  archivedAt: null,
} satisfies Prisma.TreatmentProgramWhereInput;

/**
 * Plan VINCULADO (R-LEGACY, §2.3): tiene `schedule` o al menos un turno con
 * `programId`. Espejo Prisma de `isLinkedProgram` (`lib/plan-display.ts`). Un
 * legacy (alta vieja, sesiones a 00:00Z, sin turnos) no cuenta para "Fuera de
 * plan", ni para "sin turno", ni para I3/I5/I6 del verificador.
 *
 * `Prisma.DbNull` (nunca `JsonNull`): `schedule` es `Json?` y "sin schedule"
 * es NULL de SQL, no el JSON `null`.
 */
export const linkedProgramWhere = {
  OR: [{ schedule: { not: Prisma.DbNull } }, { bookings: { some: {} } }],
} satisfies Prisma.TreatmentProgramWhereInput;

/**
 * ES4-D5: el plan que ve el PACIENTE en el portal es un plan ACTIVE, vivo y VINCULADO (`linkedProgramWhere`). Un legacy
 * (alta vieja, sesiones a las 00:00Z sin turnos) mostraba fechas corridas un día en AR y no tiene turnos que listar.
 * Una sola fuente para «Tu plan», la home y «Ejercicios» (ES4-Z B4: ejercicios usaba otro where y podía mostrar los
 * ejercicios de un plan legacy distinto del que «Tu plan» mostraba). Lleva su propio `OR`: combinar con `AND`, nunca
 * con spread junto a otro `OR`.
 */
export const PORTAL_PROGRAM_WHERE = {
  status: "ACTIVE",
  ...liveProgramWhere,
  ...linkedProgramWhere,
} satisfies Prisma.TreatmentProgramWhereInput;

/** Orden del plan «actual» del portal (el más reciente; desempate estable). */
export const PORTAL_PROGRAM_ORDER = [
  { startDate: "desc" },
  { createdAt: "desc" },
  { id: "desc" },
] satisfies Prisma.TreatmentProgramOrderByWithRelationInput[];

/**
 * "Sin turno" (C4, literal): sesión viva, no completada y **sin** turno con
 * `sessionId` y `status ∉ {CANCELLED, NO_SHOW}`. Un turno cancelado o ausente
 * deja la sesión "sin turno" con su cuota y su fecha planificada.
 *
 * No mira el plan: para "sin turno de un plan activo y vinculado" el caller
 * suma `program: { tenantId, ...liveProgramWhere, status: 'ACTIVE', ...linkedProgramWhere }`.
 */
export const sessionWithoutActiveBookingWhere = {
  archivedAt: null,
  completedAt: null,
  bookings: { none: { status: { notIn: [...INACTIVE_FOR_SESSION] } } },
} satisfies Prisma.SessionWhereInput;

/** Criterio canónico de "el turno tiene un cobro" (C5, P6). Ver `MONEY_STATUSES`. */
export const bookingHasPaymentWhere = {
  OR: [
    { paymentStatus: { in: [...MONEY_STATUSES] } },
    { insurerPaidAt: { not: null } },
    { payment: { is: { status: { in: [...MONEY_STATUSES] } } } },
  ],
} satisfies Prisma.BookingWhereInput;

/**
 * Turnos que se pueden adoptar en un plan del paciente (C3, `adopt`): del
 * tenant y del paciente, sin plan ni sesión, PENDING / CONFIRMED / COMPLETED,
 * y **nunca** una reserva pública PENDING impaga (retiene el cupo 30 min y es
 * del turnero, no de la recepción). Espejo Prisma de `isAdoptable`
 * (`lib/availability/plan.ts`).
 *
 * La reserva pública se reconoce por la key (`isPublicReservation`,
 * `lib/booking-capacity.ts`): `pub:<…>:<…>` o la legacy `<…>:<…>:<ISO>:<patientId>`.
 * En SQL se aproxima con `startsWith 'pub:'` y `endsWith ':<patientId>'`, que
 * es MÁS amplio que las regex (falla cerrado: ante la duda no se adopta).
 * Ninguna key de cliente (UUID) ni de plan (`plan:<gen>:<index>`) termina en
 * `:<patientId>`.
 *
 * Es el where del CAS de adopción (`updateMany … count === 1`): por eso sí
 * lleva `tenantId`.
 */
export function adoptableBookingWhere(o: { tenantId: string; patientId: string }): Prisma.BookingWhereInput {
  return {
    tenantId: o.tenantId,
    patientId: o.patientId,
    programId: null,
    sessionId: null,
    status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] },
    NOT: {
      status: "PENDING",
      paymentStatus: { in: ["UNPAID", "FAILED"] },
      OR: [{ idempotencyKey: { startsWith: "pub:" } }, { idempotencyKey: { endsWith: `:${o.patientId}` } }],
    },
  };
}
