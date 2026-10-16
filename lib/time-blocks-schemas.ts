/**
 * Bloqueos de horario (B2.4b CFG-api-2, B-pre) — zod, tipos y la lógica pura
 * de la ventana del bloqueo, compartidos cliente/servidor.
 *
 * Separado de `lib/time-blocks.ts` (`"use server"`: solo funciones async) para
 * que la UI (candado de día B4.4, modo bloqueo del modal B5.4) importe tipos y
 * límites, y para que `normalizeBlockWindow` sea testeable sin DB.
 *
 * Fechas: TODA la aritmética de días es AR (`lib/datetime-ar.ts`). Argentina
 * no tiene horario de verano desde 2009, así que "00:00 AR del día D" es
 * `D T00:00:00-03:00` y el día siguiente está exactamente 24 h después — sin
 * `setHours`/`getDate` del host (en Vercel el host es UTC).
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { AgendaRoomBlockView } from "@/lib/availability-actions-types";
import { toARDateKey } from "@/lib/datetime-ar";
import { arDayStart } from "@/lib/time-blocks-window";

// PF1-Z (D-PF5): `TIME_BLOCK_MAX_DAYS` y `arDayStart` viven en `lib/time-blocks-window.ts` (sin zod) y se re-exportan
// acá. Los componentes cliente de la agenda (`day-lock-state`, `block-mode-state`) los importan de allá: importarlos de
// este archivo arrastraba zod (~13 kB gz) al JS inicial de /agenda.
export { TIME_BLOCK_MAX_DAYS, arDayStart } from "@/lib/time-blocks-window";
/** Tope de la ventana de `listTimeBlocks` (una vista mensual + bordes). */
export const TIME_BLOCK_LIST_MAX_DAYS = 62;
/** Cuántos turnos afectados se devuelven en detalle (el conteo es completo). */
export const AFFECTED_LIST_LIMIT = 50;

const DAY_MS = 24 * 60 * 60_000;

const Id = z.string().trim().min(1).max(64);
/** ISO con offset explícito ("…Z" o "…-03:00"): sin offset sería hora del host. */
const IsoInstant = z.string().datetime({ offset: true, message: "Fecha/hora inválida" });
const DayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Día inválido (YYYY-MM-DD)");


/**
 * Ventana efectiva del bloqueo.
 *   - Sin `allDay`: tal cual llega.
 *   - Con `allDay`: [00:00 AR del día de `startsAt`, 00:00 AR del día SIGUIENTE
 *     al día del último instante cubierto). El "último instante" es
 *     `endsAt − 1 ms` para que un `endsAt` a medianoche exacta (lo que manda
 *     un rango de días "hasta el 5" como [1, 6)) no sume un día de más; si
 *     `endsAt <= startsAt` se toma un solo día (el de `startsAt`).
 */
export function normalizeBlockWindow(input: {
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
}): { startsAt: Date; endsAt: Date } {
  if (!input.allDay) return { startsAt: input.startsAt, endsAt: input.endsAt };
  const firstDay = toARDateKey(input.startsAt);
  const lastInstant =
    input.endsAt.getTime() > input.startsAt.getTime()
      ? new Date(input.endsAt.getTime() - 1)
      : input.startsAt;
  const lastDay = toARDateKey(lastInstant);
  return {
    startsAt: arDayStart(firstDay),
    endsAt: new Date(arDayStart(lastDay).getTime() + DAY_MS),
  };
}

/** Copy del alcance "Una sala" (SR-B, §17.5) cuando además vienen profesionales. */
export const ROOM_SCOPE_WITH_PRACTITIONERS_ERROR = "Un bloqueo de sala no lleva profesionales.";

/**
 * Alta de bloqueo. Destino (excluyentes):
 *   - `practitionerIds` (≥1) → una fila por profesional; con 2+ comparten
 *     `groupId` (decisión 8: subconjunto = N filas con groupId);
 *   - si no, `practitionerId`: un id = su agenda; `null` = "todos" (una fila
 *     con practitionerId null, alcanza también a profesionales futuros);
 *   - `roomId` (SR-B, §17.5 "Bloquear sala"): UNA fila de esa sala, con
 *     `practitionerId` null y `locationId` = la sede de la sala (lo exige el
 *     CHECK `TimeBlock_room_scope_check` de M4). Bloquea SOLO la sala, nunca a
 *     los profesionales: por eso no admite `practitionerId(s)` — un null ahí
 *     se tolera porque es lo que guarda la fila.
 * `locationId` opcional: null/ausente = todas las sedes. Con `roomId`, si
 * viene, tiene que ser la sede de la sala (si no, se rechaza: el server la
 * deriva de la sala).
 */
export const TimeBlockCreate = z
  .object({
    practitionerId: Id.nullable().optional(),
    practitionerIds: z.array(Id).min(1).max(100).optional(),
    locationId: Id.nullable().optional(),
    roomId: Id.nullable().optional(),
    startsAt: IsoInstant,
    endsAt: IsoInstant,
    allDay: z.boolean().default(false),
    reason: z
      .string()
      .trim()
      .max(200)
      .optional()
      .nullable()
      .transform((v) => (v ? v : null)),
  })
  .superRefine((v, ctx) => {
    if (v.roomId) {
      if (v.practitionerIds || (v.practitionerId !== undefined && v.practitionerId !== null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roomId"],
          message: ROOM_SCOPE_WITH_PRACTITIONERS_ERROR,
        });
      }
    } else if (v.practitionerIds && v.practitionerId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["practitionerIds"],
        message: "Indicá un profesional, varios o todos; no ambos.",
      });
    }
    if (!v.roomId && !v.practitionerIds && v.practitionerId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["practitionerId"],
        message: "Indicá a quién aplica el bloqueo.",
      });
    }
    const s = new Date(v.startsAt).getTime();
    const e = new Date(v.endsAt).getTime();
    // allDay tolera endsAt == startsAt (un solo día); el resto exige s < e.
    if (v.allDay ? e < s : e <= s) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endsAt"],
        message: "El fin tiene que ser posterior al inicio.",
      });
    }
  });

export type TimeBlockCreateInput = z.input<typeof TimeBlockCreate>;

/**
 * Listado por ventana de días AR inclusiva (como `AvailabilityInput.from/to`).
 * SR-B: sin `roomIds` salen solo los bloqueos de profesionales / "todos" (los
 * de sala tienen `practitionerId` null y, mezclados, se leerían como "todo el
 * equipo"); con `roomIds` salen SOLO los bloqueos de esas salas.
 */
export const TimeBlockList = z
  .object({
    from: DayKey,
    to: DayKey,
    practitionerIds: z.array(Id).max(100).optional(),
    locationId: Id.nullable().optional(),
    roomIds: z.array(Id).min(1).max(100).optional(),
  })
  .superRefine((v, ctx) => {
    const span = (arDayStart(v.to).getTime() - arDayStart(v.from).getTime()) / DAY_MS;
    if (Number.isNaN(span) || span < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Rango inválido." });
    } else if (span + 1 > TIME_BLOCK_LIST_MAX_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `Máximo ${TIME_BLOCK_LIST_MAX_DAYS} días.`,
      });
    }
  });

export type TimeBlockListInput = z.input<typeof TimeBlockList>;

/** Borrado (soft) de un bloqueo suelto o de todo un grupo. */
export const TimeBlockDelete = z.union([
  z.object({ id: Id }).strict(),
  z.object({ groupId: Id }).strict(),
]);

export type TimeBlockDeleteInput = z.input<typeof TimeBlockDelete>;

export type TimeBlockRow = {
  id: string;
  practitionerId: string | null;
  locationId: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  reason: string | null;
  groupId: string | null;
  /** SR-B: sala bloqueada (§17.5); null = bloqueo de profesional(es) / "todos". */
  roomId: string | null;
  createdById: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Bloqueos de SALA (SR-B, §17.5): helpers puros de lectura para la agenda.
// Viven acá (y no en `lib/time-blocks.ts`) porque ese archivo es "use server":
// todo export sería una action, y estos los usa el server DENTRO de su tx
// (`getAgendaAvailability`, SR3a; el loader, SR1a).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filtro que deja afuera los bloqueos de sala. Todo lector de `TimeBlock` que
 * interpreta `practitionerId: null` como "todos los profesionales" lo TIENE
 * que sumar: un bloqueo de sala también tiene `practitionerId` null (CHECK de
 * M4) y no bloquea a nadie.
 */
export const NOT_ROOM_BLOCK = { roomId: null } as const satisfies Prisma.TimeBlockWhereInput;

/**
 * `where` de los bloqueos de sala vivos que tocan [start, end) (semiabierto,
 * como el resto de las ventanas de bloqueo). `roomIds` acota a esas salas;
 * `locationId` a las salas de esa sede (la fila de sala SIEMPRE tiene su sede).
 */
export function roomBlocksWhere(o: {
  tenantId: string;
  start: Date;
  end: Date;
  roomIds?: readonly string[] | null;
  locationId?: string | null;
}): Prisma.TimeBlockWhereInput {
  return {
    tenantId: o.tenantId,
    deletedAt: null,
    roomId: o.roomIds ? { in: [...o.roomIds] } : { not: null },
    ...(o.locationId ? { locationId: o.locationId } : {}),
    startsAt: { lt: o.end },
    endsAt: { gt: o.start },
  };
}

export const ROOM_BLOCK_SELECT = {
  id: true,
  roomId: true,
  startsAt: true,
  endsAt: true,
  reason: true,
} as const satisfies Prisma.TimeBlockSelect;

/** Orden estable (por inicio e id), el mismo que `RoomBlock` en el motor. */
export const ROOM_BLOCK_ORDER: Prisma.TimeBlockOrderByWithRelationInput[] = [{ startsAt: "asc" }, { id: "asc" }];

/**
 * Filas de `ROOM_BLOCK_SELECT` → DTO serializable de la agenda
 * (`AgendaAvailability.roomBlocks`). Descarta las filas sin sala (no deberían
 * llegar con `roomBlocksWhere`, pero el tipo de Prisma no lo sabe).
 */
export function toAgendaRoomBlockViews(
  rows: readonly { id: string; roomId: string | null; startsAt: Date; endsAt: Date; reason: string | null }[]
): AgendaRoomBlockView[] {
  const out: AgendaRoomBlockView[] = [];
  for (const b of rows) {
    if (!b.roomId) continue;
    out.push({
      id: b.id,
      roomId: b.roomId,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      reason: b.reason,
    });
  }
  return out;
}

/**
 * Turno activo (PENDING/CONFIRMED que sigue ocupando cupo) que cae, aunque
 * sea en parte, dentro de un bloqueo recién creado. Solo lo necesario para
 * que la UI ofrezca reprogramar/cancelar (eso es B4.4): nada clínico
 * (title/description/notes); el nombre del paciente sí, porque es el nivel
 * "basic" que la agenda ya muestra a todo el equipo (`lib/visibility.ts`).
 */
export type AffectedBooking = {
  id: string;
  practitionerId: string;
  scheduledFor: string;
  durationMin: number;
  patientName: string | null;
};

export type CreateTimeBlockResult = {
  ids: string[];
  groupId: string | null;
  /** Ventana efectiva guardada (allDay ya normalizado). */
  startsAt: string;
  endsAt: string;
  affected: { count: number; bookings: AffectedBooking[] };
};

// ─────────────────────────────────────────────────────────────────────────────
// Candado de día (B4.4 AG-lock): preview → aplicar (con mantener/cancelar los
// turnos de debajo) → desbloquear. Pedido explícito del dueño (plan §11.3).
// ─────────────────────────────────────────────────────────────────────────────

/** Tope de profesionales por candado (un consultorio grande ronda 10). */
export const DAY_LOCK_MAX_PRACTITIONERS = 100;
/** Tope de ids esperados en `applyDayLock` (un día con 2000 turnos no existe). */
export const DAY_LOCK_MAX_AFFECTED = 2000;

const MinOfDay = z.number().int().min(0).max(1440);

/**
 * Ventana del candado de un día AR: todo el día = [00:00, 24:00) AR; franja =
 * [00:00 + startMin, 00:00 + endMin) AR. Sin DST en Argentina (ver cabecera):
 * sumar minutos a las 00:00 AR da la hora de pared exacta en cualquier host.
 */
export function dayLockWindow(
  dayKey: string,
  span: { allDay: boolean; startMin?: number | null; endMin?: number | null }
): { startsAt: Date; endsAt: Date } {
  const start = arDayStart(dayKey).getTime();
  if (span.allDay) return { startsAt: new Date(start), endsAt: new Date(start + DAY_MS) };
  return {
    startsAt: new Date(start + (span.startMin ?? 0) * 60_000),
    endsAt: new Date(start + (span.endMin ?? 0) * 60_000),
  };
}

/** "2027-02-30" pasa el regex pero no existe: se exige que el día AR vuelva igual. */
function isRealDayKey(dayKey: string): boolean {
  const d = arDayStart(dayKey);
  return !Number.isNaN(d.getTime()) && toARDateKey(d) === dayKey;
}

const DayLockScopeShape = {
  dayKey: DayKey,
  /** null = "todos" (una fila con practitionerId null, decisión 8). */
  practitionerIds: z.array(Id).min(1).max(DAY_LOCK_MAX_PRACTITIONERS).nullable(),
  /** null/ausente = todas las sedes. Con `roomId`: la sede de la sala o ausente. */
  locationId: Id.nullable().optional(),
  /**
   * SR-B (§17.5): alcance "Una sala". Exige `practitionerIds: null` (el
   * bloqueo es de la sala, no de profesionales); null/ausente = el candado
   * de profesionales de siempre.
   */
  roomId: Id.nullable().optional(),
  allDay: z.boolean(),
  startMin: MinOfDay.optional(),
  endMin: MinOfDay.optional(),
};

function refineDayLockScope(
  v: {
    dayKey: string;
    allDay: boolean;
    startMin?: number;
    endMin?: number;
    roomId?: string | null;
    practitionerIds: string[] | null;
  },
  ctx: z.RefinementCtx
) {
  if (!isRealDayKey(v.dayKey)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dayKey"], message: "Día inválido." });
  }
  if (v.roomId && v.practitionerIds !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roomId"], message: ROOM_SCOPE_WITH_PRACTITIONERS_ERROR });
  }
  if (v.allDay) return;
  if (v.startMin === undefined || v.endMin === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startMin"], message: "Indicá desde y hasta qué hora." });
  } else if (v.endMin <= v.startMin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endMin"],
      message: "El fin tiene que ser posterior al inicio.",
    });
  }
}

export const DayLockPreviewQuery = z.object(DayLockScopeShape).superRefine(refineDayLockScope);
export type DayLockPreviewInput = z.input<typeof DayLockPreviewQuery>;

export const DayLockApply = z
  .object({
    ...DayLockScopeShape,
    reason: z
      .string()
      .trim()
      .max(200)
      .optional()
      .nullable()
      .transform((v) => (v ? v : null)),
    /** Qué hacer con los turnos activos de debajo. */
    bookingsDecision: z.enum(["keep", "cancel"]),
    /** Los ids que el usuario VIO en el preview: si la tx encuentra otros, no aplica. */
    expectedAffectedIds: z.array(Id).max(DAY_LOCK_MAX_AFFECTED),
  })
  .superRefine(refineDayLockScope);
export type DayLockApplyInput = z.input<typeof DayLockApply>;

/**
 * Desbloquear un día. `practitionerId` = alcance: un profesional (sus filas)
 * o null = todo el consultorio (todas las filas del día, incluidas las de
 * "todos" y las de cada profesional). `blockIds` opcional acota a los que el
 * usuario tildó en el diálogo.
 *
 * SR-B: `roomId` = desbloquear ESA sala (solo sus bloqueos; exige
 * `practitionerId: null`). Sin `roomId` los bloqueos de sala no se tocan ni
 * se listan en `remaining`: no son de la agenda de nadie.
 */
export const DayLockRemove = z
  .object({
    dayKey: DayKey.refine(isRealDayKey, "Día inválido."),
    practitionerId: Id.nullable(),
    roomId: Id.nullable().optional(),
    blockIds: z.array(Id).min(1).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.roomId && v.practitionerId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["roomId"], message: ROOM_SCOPE_WITH_PRACTITIONERS_ERROR });
    }
  });
export type DayLockRemoveInput = z.input<typeof DayLockRemove>;

/** Turno afectado por el candado: lo de `AffectedBooking` + si tiene cobro y si es de plan. */
export type DayLockAffected = AffectedBooking & {
  status: "PENDING" | "CONFIRMED";
  /** Cobro registrado (criterio de `cancelBookingsInTx`): no se cancela en lote. */
  hasPayment: boolean;
  /**
   * Turno de un plan (`Booking.programId` no nulo). S18b H2 (P3.Z): el diálogo
   * cuenta cuántos son de plan para la nota precisa ("cancelarlo deja la
   * sesión sin turno") y marca la fila con un chip no cromático. Solo el
   * booleano: ni título ni id del plan (PD-13: la Secretaria opera el candado).
   */
  inPlan: boolean;
};

export type DayLockPreview = {
  dayKey: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** TODOS los afectados (un día está acotado), por hora. */
  affected: DayLockAffected[];
};

/** Espejo de `CancelSkipReason` (`lib/bookings-cancel-internal.ts`, server-only). */
export type DayLockSkipReason = "not-found" | "not-active" | "has-payment";

export type DayLockApplyData = {
  ids: string[];
  groupId: string | null;
  startsAt: string;
  endsAt: string;
  /** El candado ya existía idéntico (doble click / reintento): no se duplicó. */
  reused: boolean;
  decision: "keep" | "cancel";
  /** Turnos que quedaron debajo sin tocar (decision = keep). */
  kept: DayLockAffected[];
  cancelled: DayLockAffected[];
  /** No cancelados: con cobro ("resolver a mano") o que cambiaron de estado. */
  skipped: { booking: DayLockAffected; reason: DayLockSkipReason }[];
};

export type ApplyDayLockResult =
  | { ok: true; data: DayLockApplyData }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }
  /** La agenda cambió entre el preview y el apply: re-mostrar `affected`. */
  | { ok: false; error: string; changed: true; affected: DayLockPreview };

export type DayLockRemainingBlock = TimeBlockRow & {
  /** Abarca más de este día: quitarlo desbloquearía también los otros días. */
  multiDay: boolean;
};

export type RemoveDayLockData = {
  deleted: number;
  /** Bloqueos que SIGUEN tocando ese día en el alcance (parciales, de varios
   *  días, de "todos" visto desde un profesional, o no tildados). */
  remaining: DayLockRemainingBlock[];
};
