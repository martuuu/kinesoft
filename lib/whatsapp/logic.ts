/**
 * WA-P1 (T6, C-WA2, brief §26.5) · Lógica pura de WhatsApp: qué cambio de turno se avisa, a quién se le puede escribir,
 * cómo se agrupan las series, las claves de idempotencia de la cola, la máquina de estados del mensaje, la
 * clasificación de errores de Graph, los reintentos, las respuestas del paciente y la ventana del recordatorio.
 *
 * Sin I/O ni `server-only`: lo usan el hook post-commit (`booking-hook-internal.ts`), la cola (`outbox-internal.ts`),
 * el webhook, el cron y la UI (el panel del drawer calcula el canal con `patientChannel`). Todo reloj pasa por
 * `lib/datetime-ar.ts`: el cron corre en Vercel (UTC) y «mañana» es mañana en Buenos Aires.
 */
import { toARDateKey } from "@/lib/datetime-ar";
import { normalizeArMobile } from "@/lib/phone-e164";
import type {
  WaChannelBlockReason,
  WaConsentStatus,
  WaErrorClass,
  WaInboundKind,
  WaMessageStatus,
  WaPatientChannel,
  WaSkipReason,
} from "@/lib/whatsapp/types";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Ventana de «turno recién creado» (C-WA2). Un turno creado y movido dentro de las 2 h no manda «reprogramado»: el
 * paciente todavía no recibió nada útil (o recibió el alta hace minutos) y dos mensajes seguidos parecen un error del
 * consultorio. Se manda un único «agendado» con la hora vigente.
 */
export const WA_CREATED_WINDOW_MS = 2 * HOUR;

/** WA-D4: nunca un aviso de turno a menos de 60 min (el paciente ya está en camino o no llega a leerlo). */
export const WA_MIN_LEAD_MS = 60 * MIN;

// ── classifyRef ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Lo que `classifyRef` necesita de un `BookingChangeRef` (`lib/booking-events-internal.ts`). Estructural a propósito:
 * ese módulo importa `next/cache` y el publisher realtime, y este tiene que poder cargarse en un unit test y en el
 * cliente sin arrastrarlos.
 */
export type WaRefInput = {
  scheduledFor: Date;
  prev?: { scheduledFor: Date; practitionerId?: string; roomId?: string | null } | null;
  kind?: "booking" | "reception" | "called";
};

export type WaRefClass = "created" | "moved" | null;

/**
 * ¿Este cambio de turno se le avisa al paciente, y con qué plantilla?
 *   - `created` si el turno se creó dentro de la ventana de 2 h Y después de conectar la cuenta: sin el
 *     `connectedAt`, conectar WhatsApp por primera vez y tocar cualquier turno de la última hora mandaría un «agendado»
 *     de un turno que el paciente ya conoce;
 *   - `moved` si cambió el horario;
 *   - null en cualquier otro caso. Un cambio de sala o de profesional solo NO es un movimiento: el paciente va el mismo
 *     día a la misma hora y avisarle «se reprogramó» sería falso (y el profesional, además, es dato que no sale, WA-D16).
 *     Los refs de Recepción («llegó», «en atención») y del llamado de la sala tampoco.
 *
 * `b` = la fila actual del turno (la lee el hook en su única query); el horario vigente es el de `b`, no el del ref.
 */
export function classifyRef(
  ref: WaRefInput,
  b: { createdAt: Date; scheduledFor: Date },
  now: Date,
  connectedAt: Date
): WaRefClass {
  if (ref.kind && ref.kind !== "booking") return null;
  const threshold = Math.max(now.getTime() - WA_CREATED_WINDOW_MS, connectedAt.getTime());
  if (b.createdAt.getTime() >= threshold) return "created";
  if (ref.prev && ref.prev.scheduledFor.getTime() !== ref.scheduledFor.getTime()) return "moved";
  return null;
}

// ── eligibility / patientChannel ───────────────────────────────────────────────────────────────────────────────

export type WaPatientConsentInput = {
  phone: string | null;
  waConsent: WaConsentStatus | null;
  waPhoneE164: string | null;
};

/** Motivo de bloqueo del lado del paciente (consentimiento + número), común a `eligibility` y `patientChannel`. */
function patientBlock(p: WaPatientConsentInput): { ok: true; e164: string } | { ok: false; reason: WaChannelBlockReason } {
  if (p.waConsent === null || p.waConsent === undefined) return { ok: false, reason: "no_consent" };
  if (p.waConsent === "REVOKED") return { ok: false, reason: "revoked" };
  const n = normalizeArMobile(p.phone);
  if (!n.ok) return { ok: false, reason: "invalid_phone" };
  // WA-D17: el consentimiento queda anclado al número con el que se dio. Si el teléfono cargado hoy normaliza a otro
  // celular, no se le escribe a ese número (puede ser de otra persona) hasta que se vuelva a consentir.
  if (n.e164 !== p.waPhoneE164) return { ok: false, reason: "phone_changed" };
  return { ok: true, e164: n.e164 };
}

export type WaEligibilityInput = {
  status: string;
  patientId: string | null;
  scheduledFor: Date;
  patient: WaPatientConsentInput | null;
};

export type WaEligibility = { ok: true; e164: string } | { ok: false; reason: WaSkipReason };

/**
 * ¿Se le puede mandar un aviso de ESTE turno? (C-WA2, WA-D4). La cola lo re-chequea al despachar (C-WA7): entre el
 * encolado y el envío el turno puede haberse cancelado o el paciente revocado.
 *
 * Una reserva pública PENDING (turnero sin pagar) queda afuera por el estado: si se paga, pasa a CONFIRMED y su
 * ref llega por el hook como cualquier alta. El orden de los chequeos es el de la UI: primero lo del turno, después
 * lo del paciente, al final el tiempo (así el historial dice «sin consentimiento» y no «muy cerca» cuando son las dos).
 */
export function eligibility(b: WaEligibilityInput, now: Date): WaEligibility {
  if (b.status !== "CONFIRMED") return { ok: false, reason: "not_confirmed" };
  if (!b.patientId || !b.patient) return { ok: false, reason: "no_patient" };
  const p = patientBlock(b.patient);
  if (!p.ok) return p;
  if (b.scheduledFor.getTime() - now.getTime() < WA_MIN_LEAD_MS) return { ok: false, reason: "too_soon" };
  return { ok: true, e164: p.e164 };
}

/**
 * Estado del canal del paciente para la UI (drawer del turno, ficha del paciente). `templateApproved` = la plantilla
 * que se usaría está APPROVED (el caller elige cuál: el recordatorio en el drawer).
 */
export function patientChannel(input: {
  accountActive: boolean;
  templateApproved: boolean;
  patient: WaPatientConsentInput | null;
}): WaPatientChannel {
  if (!input.accountActive) return { state: "blocked", reason: "no_account" };
  if (!input.patient) return { state: "blocked", reason: "no_consent" };
  const p = patientBlock(input.patient);
  if (!p.ok) return { state: "blocked", reason: p.reason };
  if (!input.templateApproved) return { state: "blocked", reason: "template_pending" };
  return { state: "ready" };
}

// ── groupSeries ────────────────────────────────────────────────────────────────────────────────────────────────

export type WaSeriesItem = { bookingId: string; seriesId: string | null; programId: string | null; scheduledFor: Date };

export type WaSeriesGroup<T extends WaSeriesItem> = {
  /** `seriesId`, o `p.<programId>` si se agrupó por plan; null = turno suelto (se avisa con bc/bm). */
  seriesKey: string | null;
  /** Ordenados por horario. */
  bookings: T[];
  /** El primero: su horario va en la plantilla y en la clave `bs:<serie>:<epoch>`. */
  first: T;
};

/**
 * Un mensaje por serie o por plan (C-WA2): «Repetir / Múltiples turnos» crea N turnos en un commit y N plantillas
 * seguidas serían spam (y N cobros de Meta). La serie manda sobre el plan: un plan puede tener varias tandas, y cada
 * tanda es su propio aviso. Un grupo de uno es un turno suelto: «tenés 1 turno a partir del…» es peor que el aviso
 * individual.
 */
export function groupSeries<T extends WaSeriesItem>(items: ReadonlyArray<T>): WaSeriesGroup<T>[] {
  const byKey = new Map<string, T[]>();
  const singles: T[] = [];
  for (const it of items) {
    const key = it.seriesId ?? (it.programId ? `p.${it.programId}` : null);
    if (key === null) {
      singles.push(it);
      continue;
    }
    const arr = byKey.get(key);
    if (arr) arr.push(it);
    else byKey.set(key, [it]);
  }
  const byTime = (a: T, b: T) => a.scheduledFor.getTime() - b.scheduledFor.getTime();
  const groups: WaSeriesGroup<T>[] = [];
  for (const [key, arr] of byKey) {
    if (arr.length === 1) {
      singles.push(arr[0]);
      continue;
    }
    const sorted = [...arr].sort(byTime);
    groups.push({ seriesKey: key, bookings: sorted, first: sorted[0] });
  }
  for (const s of singles) groups.push({ seriesKey: null, bookings: [s], first: s });
  return groups.sort((a, b) => byTime(a.first, b.first));
}

// ── idemKey ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Literal del CHECK `WhatsAppMessage_key_check` de M15. */
export const IDEM_KEY_RE = /^[a-z]{1,8}:[A-Za-z0-9:._-]{1,180}$/;

export type WaIdemSpec =
  | { t: "bc"; bookingId: string }
  | { t: "bm"; bookingId: string; scheduledFor: Date }
  | { t: "bs"; seriesKey: string; scheduledFor: Date }
  | { t: "br"; bookingId: string; scheduledFor: Date }
  | { t: "doc"; documentId: string; key: string };

const epochS = (d: Date) => Math.floor(d.getTime() / 1000);

/**
 * Clave de idempotencia de la cola (UNIQUE `[tenantId, idempotencyKey]`, `enqueue` con ON CONFLICT DO NOTHING):
 *   - `bc:<id>`: un solo «agendado» por turno, por más refs que lleguen;
 *   - `bm:<id>:<epoch>` / `br:<id>:<epoch>`: uno por horario (si lo mueven de nuevo, es otro aviso; si el hook corre dos
 *     veces por el mismo movimiento, no);
 *   - `bs:<serie>:<epoch>`: uno por serie y primer horario;
 *   - `doc:<id>:<key>`: uno por documento compartido y versión.
 * Tira si la clave no cumple el CHECK: un id raro es un bug del caller, y mejor un error con nombre acá que un 23514
 * de la base en medio del hook.
 */
export function idemKey(spec: WaIdemSpec): string {
  let k: string;
  switch (spec.t) {
    case "bc":
      k = `bc:${spec.bookingId}`;
      break;
    case "bm":
      k = `bm:${spec.bookingId}:${epochS(spec.scheduledFor)}`;
      break;
    case "bs":
      k = `bs:${spec.seriesKey}:${epochS(spec.scheduledFor)}`;
      break;
    case "br":
      k = `br:${spec.bookingId}:${epochS(spec.scheduledFor)}`;
      break;
    case "doc":
      k = `doc:${spec.documentId}:${spec.key}`;
      break;
  }
  if (!IDEM_KEY_RE.test(k)) throw new RangeError(`idemKey inválida para ${spec.t}`);
  return k;
}

// ── nextMessageStatus ──────────────────────────────────────────────────────────────────────────────────────────

const PROGRESS: Partial<Record<WaMessageStatus, number>> = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4 };
const TERMINAL = new Set<WaMessageStatus>(["READ", "FAILED", "SKIPPED", "CANCELLED", "EXPIRED"]);

/**
 * Estado resultante de aplicar `incoming` sobre `current` (`applyStatus`, monótono). Meta no garantiza el orden de los
 * webhooks: un `delivered` puede llegar después del `read`, y sin esto el historial «des-leería» el mensaje.
 *   - el progreso QUEUED → SENDING → SENT → DELIVERED → READ solo avanza;
 *   - FAILED solo antes de entregado (Meta manda `failed` después de `sent` cuando no lo pudo entregar; después de
 *     `delivered` no tiene sentido y se ignora);
 *   - SKIPPED / EXPIRED solo desde la cola (QUEUED o SENDING: el dispatch decide saltarlo con el lock tomado);
 *     CANCELLED solo desde QUEUED (lo que ya salió no se cancela);
 *   - los terminales no cambian.
 * La vuelta SENDING → QUEUED de un reintento NO pasa por acá: es el CAS del dispatcher, que suelta su propio lock.
 */
export function nextMessageStatus(current: WaMessageStatus, incoming: WaMessageStatus): WaMessageStatus {
  if (TERMINAL.has(current) || current === incoming) return current;
  switch (incoming) {
    case "FAILED":
      return current === "QUEUED" || current === "SENDING" || current === "SENT" ? "FAILED" : current;
    case "SKIPPED":
    case "EXPIRED":
      return current === "QUEUED" || current === "SENDING" ? incoming : current;
    case "CANCELLED":
      return current === "QUEUED" ? "CANCELLED" : current;
    default: {
      const a = PROGRESS[current];
      const b = PROGRESS[incoming];
      return a !== undefined && b !== undefined && b > a ? incoming : current;
    }
  }
}

// ── classifyGraphError ─────────────────────────────────────────────────────────────────────────────────────────

export type GraphErrorInput = {
  /** `error.code` de Graph. */
  code?: number | null;
  httpStatus?: number | null;
  timeout?: boolean;
  network?: boolean;
};

export type GraphErrorClassified = {
  errorClass: WaErrorClass;
  /** Para `errorCode`/`lastErrorCode` (CHECK `^[a-z_]{1,40}(:[0-9]{1,7})?$`). Nunca el mensaje de Meta. */
  errorCode: string;
  retryable: boolean;
};

// Códigos de la Cloud API (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes, oct-2026).
const RETRY_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
const RECIPIENT_CODES = new Set([131021, 131026, 131030, 131047, 131050, 130472]);
const PAYMENT_CODES = new Set([131042]);
const ACCOUNT_CODES = new Set([368, 131031, 131045, 131037, 133010, 133005, 133006, 133008, 133009, 133015, 133016]);
const AUTH_CODES = new Set([0, 3, 10, 190, 200]);
const TEMPLATE_CODES = new Set([131008, 131009]);

/**
 * Clase de un error de Graph, que decide qué hace la cola:
 *   - `retry`: timeout, red, 5xx, rate limit (130429, 131048, 131056) → reintento con `retryDelayMs`;
 *   - `recipient`: el problema es ese destinatario (131026 no tiene WhatsApp o no aceptó las condiciones, 131047…)
 *     → falla ESE mensaje, la cuenta sigue;
 *   - `payment`: 131042, el consultorio no tiene medio de pago en Meta → `markAccountProblem` (paymentIssueAt);
 *   - `account`: cuenta bloqueada, número no registrado, display name → la cuenta necesita atención;
 *   - `auth`: token inválido o vencido (190), permisos → REAUTH_REQUIRED;
 *   - `template`: 132xxx (plantilla inexistente, pausada, deshabilitada, params que no coinciden) → re-sync de
 *     plantillas.
 * Un 4xx desconocido cae en `recipient`: falla el mensaje sin pausar la cuenta entera por un código que no conocemos.
 */
export function classifyGraphError(e: GraphErrorInput): GraphErrorClassified {
  if (e.timeout) return { errorClass: "retry", errorCode: "timeout", retryable: true };
  if (e.network) return { errorClass: "retry", errorCode: "network", retryable: true };
  const code = typeof e.code === "number" && Number.isInteger(e.code) && e.code >= 0 && e.code <= 9_999_999 ? e.code : null;
  const pick = (errorClass: WaErrorClass): GraphErrorClassified => ({
    errorClass,
    errorCode: `${errorClass}:${code}`,
    retryable: errorClass === "retry",
  });
  if (code !== null) {
    if (RETRY_CODES.has(code)) return pick("retry");
    if (RECIPIENT_CODES.has(code)) return pick("recipient");
    if (PAYMENT_CODES.has(code)) return pick("payment");
    if (AUTH_CODES.has(code)) return pick("auth");
    if (ACCOUNT_CODES.has(code)) return pick("account");
    if (TEMPLATE_CODES.has(code) || (code >= 132000 && code <= 132999)) return pick("template");
  }
  const http = typeof e.httpStatus === "number" ? e.httpStatus : null;
  if (http !== null && (http >= 500 || http === 429)) {
    return { errorClass: "retry", errorCode: code !== null ? `retry:${code}` : `http:${http}`, retryable: true };
  }
  if (http === 401) return { errorClass: "auth", errorCode: code !== null ? `auth:${code}` : "http:401", retryable: false };
  if (code !== null) return pick("recipient");
  return { errorClass: "recipient", errorCode: http !== null ? `http:${http}` : "unknown", retryable: false };
}

// ── retryDelayMs ───────────────────────────────────────────────────────────────────────────────────────────────

const RETRY_DELAYS = [MIN, 5 * MIN, 30 * MIN, 2 * HOUR];

/**
 * Espera antes del próximo intento, dado cuántos intentos YA fallaron (1-based). 1′, 5′, 30′, 2 h, y null = corta
 * (FAILED). En total ≈ 2 h 36′: un aviso de turno que no salió en ese rato ya llega tarde; el cron de las 18:00
 * drena lo que quede.
 */
export function retryDelayMs(failedAttempts: number): number | null {
  const i = Math.max(1, Math.floor(failedAttempts)) - 1;
  return i < RETRY_DELAYS.length ? RETRY_DELAYS[i] : null;
}

// ── Entrantes ──────────────────────────────────────────────────────────────────────────────────────────────────

const normWord = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

/**
 * Texto libre del paciente → baja, alta o texto. Solo el mensaje ENTERO (sin puntuación ni tildes): «BAJA», «Baja.»,
 * «STOP». Una frase que contiene «baja» («no me des de baja») no es una baja: el pie de las plantillas dice
 * «Respondé BAJA», y un falso positivo dejaría a un paciente sin recordatorios sin que nadie lo note. «cancelar» NO es
 * baja: el paciente lo escribe para cancelar el turno.
 */
export function parseInboundText(text: string | null | undefined): Extract<WaInboundKind, "OPT_OUT" | "OPT_IN" | "TEXT"> {
  const w = normWord(text ?? "");
  if (w === "baja" || w === "stop") return "OPT_OUT";
  if (w === "alta") return "OPT_IN";
  return "TEXT";
}

export type WaButtonKind = "confirm" | "cancel";

const BUTTON_RE = /^wa1\.([cx])\.([A-Za-z0-9_-]{1,64})$/;

/**
 * Payload de los botones del recordatorio: `wa1.c.<messageId>` («Confirmo») / `wa1.x.<messageId>` («No puedo ir»).
 * Lleva el id de NUESTRO mensaje (no el del turno) para saber a qué horario respondió: si el turno se movió después,
 * la respuesta es vieja (outcome `stale`). `wa1` versiona el formato.
 */
export function buttonPayload(kind: WaButtonKind, messageId: string): string {
  const p = `wa1.${kind === "confirm" ? "c" : "x"}.${messageId}`;
  if (!BUTTON_RE.test(p)) throw new RangeError("buttonPayload: messageId inválido");
  return p;
}

export function parseButtonPayload(payload: string | null | undefined): { kind: WaButtonKind; messageId: string } | null {
  const m = BUTTON_RE.exec(payload ?? "");
  if (!m) return null;
  return { kind: m[1] === "c" ? "confirm" : "cancel", messageId: m[2] };
}

// ── tomorrowWindowAR ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ventana del recordatorio del cron de las 18:00 AR: los turnos de MAÑANA en Buenos Aires, [00:00, 24:00) -03:00.
 * El día se saca con `toARDateKey` (el host de Vercel es UTC: a las 22:30 AR ya es «mañana» en UTC) y la aritmética
 * va sobre la fecha calendario en UTC, que no tiene DST. AR es -03:00 fijo desde 2009 (`AR_OFFSET`).
 */
export function tomorrowWindowAR(now: Date): { dateKey: string; from: Date; to: Date } {
  const [y, m, d] = toARDateKey(now).split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  const dateKey = tomorrow.toISOString().slice(0, 10);
  const from = new Date(`${dateKey}T00:00:00.000-03:00`);
  return { dateKey, from, to: new Date(from.getTime() + 24 * HOUR) };
}
