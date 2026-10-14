/**
 * Avisos de la sala de espera (SV11b, plan §18.5 «Avisos», SV-D9, SV-D16) —
 * lógica PURA, sin React ni DOM, para testearla sin jsdom
 * (`tests/unit/arrival-alert-state.test.ts`).
 *
 * Por qué por diff y no por payload: el mensaje realtime no lleva PHI (ni el
 * nombre del paciente ni la hora de llegada, §18.2), así que el cliente re-pide
 * los turnos de HOY y compara contra lo que ya tenía. Eso además lo hace
 * idempotente: el mismo evento puede llegar por el lote y por un resync, y la
 * clave `bookingId + arrivedAt` (o `+ calledAt`) es la misma.
 *
 * A quién (SV-D9): la llegada se le avisa al profesional DEL TURNO; el llamado,
 * a quien opera la agenda de todos (`agenda.operateAll`) y no es ese profesional
 * (la Secretaria se entera de que «pase María G.» lo dijo otro).
 */
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import { shortPatientName } from "@/lib/patient-short-name";
import type { AlertMode } from "@/lib/preferences-constants";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";

export type AlertViewer = {
  /**
   * Profesional que ATIENDE (recibe llegadas). null = no atiende (Secretaria,
   * BILLING). Desde IAM-4a `Actor.practitionerId` ya es null para esos roles;
   * el layout igual decide quién atiende por `clinical.read` (red).
   */
  practitionerId: string | null;
  canOperateAll: boolean;
};

export type AlertPrefs = { arrivalAlert: AlertMode; callAlert: AlertMode };

/** Lo mínimo de `AgendaBookingRow` que mira el diff. Fechas como Date o ISO. */
export type AlertRow = {
  id: string;
  practitionerId: string;
  patientName: string;
  scheduledFor: Date | string;
  status: string;
  roomId: string | null;
  arrivedAt: Date | string | null;
  calledAt: Date | string | null;
  attendingAt: Date | string | null;
};

export type AnnouncementType = "arrival" | "call";

export type Announcement = {
  type: AnnouncementType;
  /** `arr:<bookingId>:<arrivedAt>` / `call:<bookingId>:<calledAt>`: dedupe y id del toast. */
  key: string;
  bookingId: string;
  patientName: string;
  scheduledFor: string;
  practitionerId: string;
  roomId: string | null;
};

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : (typeof d === "string" ? new Date(d) : d).toISOString();

export const arrivalKey = (bookingId: string, arrivedAt: Date | string) => `arr:${bookingId}:${iso(arrivedAt)}`;
export const callKey = (bookingId: string, calledAt: Date | string) => `call:${bookingId}:${iso(calledAt)}`;

/**
 * Qué aplica a quién. Una pref que no aplica queda `off` aunque la fila de
 * preferencias diga otra cosa (p. ej. un OWNER que dejó de atender).
 */
export function effectivePrefs(viewer: AlertViewer, prefs: AlertPrefs): { arrival: AlertMode; call: AlertMode } {
  return {
    arrival: viewer.practitionerId ? prefs.arrivalAlert : "off",
    call: viewer.canOperateAll ? prefs.callAlert : "off",
  };
}

/**
 * SV-D16: tras un resync (vuelta de la pestaña, reconexión) los avisos salen sin
 * sonido. Incluye el modo `polling` (canal caído): sin canal no llegan lotes y
 * cada aviso sale de un resync `"poll"` cada 60 s, así que en polling los avisos
 * son siempre visuales (un chime con hasta 60 s de atraso confunde más de lo que
 * ayuda, y un lote de 60 s puede traer varias llegadas juntas).
 */
export function effectiveMode(pref: AlertMode, opts: { viaResync: boolean }): AlertMode {
  if (pref === "sound" && opts.viaResync) return "visual";
  return pref;
}

function diff(
  type: AnnouncementType,
  prev: ReadonlyArray<AlertRow> | null,
  next: ReadonlyArray<AlertRow>,
  seen: ReadonlySet<string> | undefined,
  include: (r: AlertRow) => boolean,
  stamp: (r: AlertRow) => Date | string | null,
): Announcement[] {
  // Sin prev no hay contra qué comparar: ese fetch es la semilla, no un evento.
  if (!prev) return [];
  const before = new Map(prev.map((r) => [r.id, iso(stamp(r))]));
  const out: Announcement[] = [];
  for (const r of next) {
    const now = iso(stamp(r));
    if (!now || r.status === "CANCELLED" || !include(r)) continue;
    // Ya en atención: el aviso llegaría tarde (el profesional ya lo tiene).
    if (r.attendingAt) continue;
    if (before.get(r.id) === now) continue;
    const key = type === "arrival" ? arrivalKey(r.id, now) : callKey(r.id, now);
    if (seen?.has(key)) continue;
    out.push({
      type,
      key,
      bookingId: r.id,
      patientName: r.patientName,
      scheduledFor: iso(r.scheduledFor) as string,
      practitionerId: r.practitionerId,
      roomId: r.roomId,
    });
  }
  return out;
}

/**
 * Llegadas a anunciar: turnos del viewer cuyo `arrivedAt` pasó de null a valor
 * o cambió (deshacer + volver a marcar es otra llegada). «En atención» y
 * «Deshacer» no tocan `arrivedAt` (o lo vuelven null): no avisan.
 */
export function arrivalsToAnnounce(
  prev: ReadonlyArray<AlertRow> | null,
  next: ReadonlyArray<AlertRow>,
  viewer: AlertViewer,
  seen?: ReadonlySet<string>,
): Announcement[] {
  const me = viewer.practitionerId;
  if (!me) return [];
  return diff("arrival", prev, next, seen, (r) => r.practitionerId === me, (r) => r.arrivedAt);
}

/** Llamados a anunciar: solo con `operateAll` y en turnos que no son del viewer. */
export function callsToAnnounce(
  prev: ReadonlyArray<AlertRow> | null,
  next: ReadonlyArray<AlertRow>,
  viewer: AlertViewer,
  seen?: ReadonlySet<string>,
): Announcement[] {
  if (!viewer.canOperateAll) return [];
  const me = viewer.practitionerId;
  return diff("call", prev, next, seen, (r) => r.practitionerId !== me, (r) => r.calledAt);
}

export type AnnouncementGroup =
  | { kind: "single"; item: Announcement }
  | { kind: "group"; type: AnnouncementType; items: Announcement[] };

/** SV-D16: 3 o más del mismo tipo en un lote → un solo toast (un batch no son N toasts). */
export const GROUP_THRESHOLD = 3;

export function groupAnnouncements(list: ReadonlyArray<Announcement>): AnnouncementGroup[] {
  const out: AnnouncementGroup[] = [];
  for (const type of ["arrival", "call"] as const) {
    const items = list.filter((a) => a.type === type);
    if (items.length >= GROUP_THRESHOLD) out.push({ kind: "group", type, items });
    else for (const item of items) out.push({ kind: "single", item });
  }
  return out;
}

function nameWords(name: string): string[] {
  return name.normalize("NFC").trim().split(/\s+/).filter(Boolean);
}

// `shortPatientName` («María González Pérez» → «María G.») vive en
// `lib/patient-short-name` (FX2b, A4; módulo propio para no arrastrar el
// tablero al first-load): había dos copias con reglas distintas
// (esta tomaba la ÚLTIMA palabra → «María P.») y el toast decía un nombre y la
// banda de `/sala` otro para el mismo paciente. Se re-exporta para no romper
// a quien lo importaba de acá.
export { shortPatientName };

export function patientInitials(name: string): string {
  const w = nameWords(name);
  if (w.length === 0) return "?";
  if (w.length === 1) return Array.from(w[0]).slice(0, 2).join("").toLocaleUpperCase("es");
  return (Array.from(w[0])[0] + Array.from(w[w.length - 1])[0]).toLocaleUpperCase("es");
}

/** «10:30» en hora AR (no la del host: en Vercel es UTC). */
export function hhmmAR(d: Date | string): string {
  const m = toARMinutes(d);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** «Llegó María G. · 10:30» (la hora es la del turno: así sabe cuál de sus pacientes es). */
export function formatArrival(a: Announcement): string {
  return `Llegó ${shortPatientName(a.patientName)} · ${hhmmAR(a.scheduledFor)}`;
}

/** «Pase María G. · Consultorio 2 · Dra. Pérez»; sin sala o sin nombre, se omite ese tramo. */
export function formatCall(
  a: Announcement,
  names: { roomName: string | null; practitionerName: string | null },
): string {
  return [`Pase ${shortPatientName(a.patientName)}`, names.roomName, names.practitionerName]
    .filter((s): s is string => !!s)
    .join(" · ");
}

export function formatGroupTitle(type: AnnouncementType, n: number): string {
  return type === "arrival" ? `Llegaron ${n} pacientes` : `Llamaron a ${n} pacientes`;
}

/** «María G., Juan P. y 2 más» para la descripción del toast agrupado. */
export function formatGroupDescription(items: ReadonlyArray<Announcement>, max = 3): string {
  const names = items.map((a) => shortPatientName(a.patientName));
  if (names.length <= max) {
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(", ")} y ${names.length - max} más`;
}

const BADGE_RE = /^\(\d+\)\s+/;
const BRAND = "KineSoft";

export function stripTitleBadge(title: string): string {
  return title.replace(BADGE_RE, "");
}

/**
 * Título con contador: `(1) Llegó María G. · KineSoft` (el último aviso es lo
 * que se lee en la pestaña); sin texto, `(2) Agenda · KineSoft`; con 0, el base.
 */
export function titleWithBadge(base: string, n: number, latest?: string | null): string {
  const clean = stripTitleBadge(base);
  if (n <= 0) return clean;
  return latest ? `(${n}) ${latest} · ${BRAND}` : `(${n}) ${clean}`;
}

/** Día AR de hoy y su rango [00:00, 24:00) AR (AR no tiene horario de verano). */
export function todayRangeAR(now: Date): { day: string; from: Date; to: Date } {
  const day = toARDateKey(now);
  const from = new Date(`${day}T00:00:00-03:00`);
  return { day, from, to: new Date(from.getTime() + 86_400_000) };
}

/**
 * ¿Este lote puede traer un aviso para el viewer? Si no, no se re-pide nada:
 * la mayoría de los mensajes (altas, movimientos) no son de recepción.
 * - `reception` → llegadas del viewer (o de todos si `practitionerId` es null).
 * - `called` → llamados, solo a quien opera todo.
 * - Colapsado (sin `bookingId`, SV-D10): el kind puede ser `booking` por mezcla
 *   y esconder un `reception`; se re-pide igual (conservador).
 * Siempre que toque hoy (`day` null = cualquier día).
 */
export function batchIsRelevant(
  batch: ReadonlyArray<RealtimeAgendaMessage>,
  today: string,
  viewer: AlertViewer,
  eff: { arrival: AlertMode; call: AlertMode },
): boolean {
  const wantArrival = eff.arrival !== "off" && !!viewer.practitionerId;
  const wantCall = eff.call !== "off" && viewer.canOperateAll;
  if (!wantArrival && !wantCall) return false;
  return batch.some((m) => {
    if (m.kind === "availability") return false;
    const touchesToday = m.day === null || m.day === today || m.prev?.day === today;
    if (!touchesToday) return false;
    const collapsed = !m.bookingId;
    const mine = m.practitionerId === null || m.practitionerId === viewer.practitionerId;
    if (wantArrival && mine && (m.kind === "reception" || collapsed)) return true;
    if (wantCall && (m.kind === "called" || collapsed)) return true;
    return false;
  });
}
