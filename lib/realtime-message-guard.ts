/**
 * Validador del mensaje entrante del canal realtime de la agenda (PF1.0-a, C-PF3).
 *
 * Por qué existe: hasta PF1 el browser validaba con `RealtimeAgendaMessageSchema` (zod) y ese import metía zod
 * entero (~12,9 kB gz) en el shell de `(app)`: lo cargaban TODAS las rutas del workspace aunque la página no tuviera
 * un formulario. Este módulo es TS puro y sin dependencias, con la MISMA semántica que el schema (que sigue vivo en
 * `lib/realtime-events-schema.ts` para el server y los tests). `tests/unit/realtime-message-guard.test.ts` corre un
 * corpus de ≥ 40 mensajes y afirma `isRealtimeAgendaMessage(x) === schema.safeParse(x).success` para cada uno.
 *
 * Es un payload NO confiable (broadcast de Supabase o SSE local): el guard no puede ser más permisivo que zod. Ante
 * la duda, rechaza. Lo que replica de zod 3 a propósito:
 *   - «objeto» = `typeof "object"`, no null, no array, no Map/Set/Date, no thenable (`getParsedType` de zod);
 *   - `.strict()` recorre las claves con `for…in` (también las heredadas enumerables) y rechaza cualquier extra;
 *   - `nullable()` NO acepta `undefined`: `practitionerId` y `day` tienen que estar (con valor o null);
 *   - `optional()` acepta la clave ausente o con `undefined`;
 *   - `z.string().datetime()` sin opciones: fecha con años bisiestos, `T`, hora con segundos y fracción opcionales,
 *     y `Z` obligatoria (sin offset). La regex está copiada de zod 3.25 (`datetimeRegex`).
 *
 * El tipo `RealtimeAgendaMessage` se declara a mano (antes era `z.infer`): el test de equivalencia y el `satisfies`
 * de `lib/realtime-events-schema.ts` evitan que se separen.
 */

export const REALTIME_KINDS = ["booking", "reception", "called", "availability"] as const;
export type RealtimeKind = (typeof REALTIME_KINDS)[number];

/** Mensaje del canal (SV, C-SV2 — FIRMA CONGELADA). Ver `lib/realtime-events.ts` para el porqué de cada campo. */
export type RealtimeAgendaMessage = {
  v: 1;
  kind: RealtimeKind;
  /** Ausente en los mensajes colapsados y en `availability`. */
  bookingId?: string | undefined;
  /** null = todo el consultorio (colapso final o candado de todos). */
  practitionerId: string | null;
  /** null = cualquier día (colapso por profesional). */
  day: string | null;
  /** Sala DESPUÉS del cambio; ausente = el write-path no la informa. */
  roomId?: string | null | undefined;
  /** Dónde estaba antes de un movimiento: las dos agendas tienen que re-pedir. */
  prev?:
    | {
        practitionerId: string;
        day: string;
        roomId?: string | null | undefined;
      }
    | undefined;
  at: string;
};

const MESSAGE_KEYS = ["v", "kind", "bookingId", "practitionerId", "day", "roomId", "prev", "at"] as const;
const PREV_KEYS = ["practitionerId", "day", "roomId"] as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// zod 3.25 `dateRegexSource` (con años bisiestos) + `timeRegexSource({ precision: undefined })` + `Z`.
const DATETIME_RE =
  /^((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z)$/;

type Bag = Record<string, unknown>;

/** `getParsedType(x) === "object"` de zod 3. */
function isPlainObjectLike(x: unknown): x is Bag {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const o = x as Bag;
  if (o.then && typeof o.then === "function" && o.catch && typeof o.catch === "function") return false;
  if (x instanceof Map || x instanceof Set || x instanceof Date) return false;
  return true;
}

/** `.strict()`: ninguna clave enumerable (propia o heredada) fuera de la lista. */
function hasOnlyKeys(o: Bag, allowed: readonly string[]): boolean {
  for (const key in o) {
    if (!allowed.includes(key)) return false;
  }
  return true;
}

/** `z.string().min(1).max(64)`. */
function isId(x: unknown): x is string {
  return typeof x === "string" && x.length >= 1 && x.length <= 64;
}

function isDay(x: unknown): x is string {
  return typeof x === "string" && DAY_RE.test(x);
}

function isKind(x: unknown): x is RealtimeKind {
  return typeof x === "string" && (REALTIME_KINDS as readonly string[]).includes(x);
}

function isPrev(x: unknown): boolean {
  if (!isPlainObjectLike(x)) return false;
  if (!hasOnlyKeys(x, PREV_KEYS)) return false;
  if (!isId(x.practitionerId)) return false;
  if (!isDay(x.day)) return false;
  const room = x.roomId;
  if (room !== undefined && room !== null && !isId(room)) return false;
  return true;
}

/** Mismo resultado que `RealtimeAgendaMessageSchema.safeParse(x).success`. Puede tirar ante un getter hostil. */
function check(x: unknown): x is RealtimeAgendaMessage {
  if (!isPlainObjectLike(x)) return false;
  if (!hasOnlyKeys(x, MESSAGE_KEYS)) return false;
  if (x.v !== 1) return false;
  if (!isKind(x.kind)) return false;
  if (x.bookingId !== undefined && !isId(x.bookingId)) return false;
  if (x.practitionerId !== null && !isId(x.practitionerId)) return false;
  if (x.day !== null && !isDay(x.day)) return false;
  if (x.roomId !== undefined && x.roomId !== null && !isId(x.roomId)) return false;
  if (x.prev !== undefined && !isPrev(x.prev)) return false;
  if (typeof x.at !== "string" || !DATETIME_RE.test(x.at)) return false;
  return true;
}

/** ¿Es un mensaje válido del canal? Nunca tira (un getter hostil cuenta como inválido). */
export function isRealtimeAgendaMessage(x: unknown): x is RealtimeAgendaMessage {
  try {
    return check(x);
  } catch {
    return false;
  }
}

/**
 * Payload crudo → copia limpia del mensaje, o `null`. Como `safeParse(x).data`, devuelve un objeto NUEVO con solo las
 * claves del contrato (las que estaban en la entrada), así nadie aguas abajo sostiene la referencia al payload crudo
 * ni a su prototipo. Nunca tira.
 */
export function parseRealtimeAgendaMessage(x: unknown): RealtimeAgendaMessage | null {
  try {
    if (!check(x)) return null;
    const out: RealtimeAgendaMessage = {
      v: 1,
      kind: x.kind,
      practitionerId: x.practitionerId,
      day: x.day,
      at: x.at,
    };
    if ("bookingId" in x) out.bookingId = x.bookingId;
    if ("roomId" in x) out.roomId = x.roomId;
    if ("prev" in x) {
      const p = x.prev;
      if (p === undefined) {
        out.prev = undefined;
      } else {
        out.prev = { practitionerId: p.practitionerId, day: p.day };
        if ("roomId" in p) out.prev.roomId = p.roomId;
      }
    }
    return out;
  } catch {
    return null;
  }
}
