/**
 * Escritorio de Recepción en `/sala` (RX, brief RX §1 y §4.1 C-RX3) — puro: sin React, sin DB, sin reloj propio
 * (`now` lo pasa el caller, el reloj único de `useSalaLive`). Lo consumen las dos caras nuevas de `/sala`
 * (A «Lista y panel», `components/sala/desk/desk-list.tsx`, y B «Flujo», `desk-flow.tsx`) y sus piezas comunes
 * (header, franja de profesionales, botón primario, menú ⋯, cobro).
 *
 * Es la MISMA realidad que el Tablero y que Recepción de la agenda: el estado, las transiciones, «solo hoy» y el rol
 * salen de `lib/reception-state.ts` y `lib/sala-board-state.ts` (`receptionState`, `salaActions`,
 * `primarySalaAction`); acá no se repite ninguna regla, solo se arma la forma del escritorio:
 *   - filtros en chips y KPIs del header (misma cuenta de «En sala» que `boardCounters`/`receptionCounters`);
 *   - las listas del panel / carriles: sala de espera, próximos 30', en atención y por cobrar;
 *   - el «pulso» de cada profesional (franja): demora, qué está haciendo, progreso del día;
 *   - el botón primario y el menú ⋯ de cada fila, con «Cobrar» solo para quien cobra;
 *   - la línea de «ahora» de la tabla A y los atajos de teclado.
 *
 * Diferencias a propósito con el Tablero:
 *   - el orden de la tabla A y de la línea de tiempo B es CRONOLÓGICO (`chronological`), como el prototipo y como
 *     se lee el día; no es `sortForReception`, que sube «en atención» y «llamado» arriba;
 *   - las entries incluyen atendidos y ausentes (`deskEntries`): el Tablero no les da card, pero el escritorio los
 *     necesita para «Por cobrar», «Atendidos» y el progreso de la franja.
 *
 * Cobrar (brief §1.4, RX-D4): `setBookingCopagoPaid` no exige capability (pide acceso full al paciente), pero la UI
 * de cobro del escritorio solo aparece con `billing.manage` (OWNER/ADMIN; BILLING no llega a /sala porque no tiene
 * `agenda.reception`). La Secretaria no cobra hasta que C0 lo decida. El server sigue siendo la autoridad.
 *
 * PD-13: nada clínico. Todo sale de `BookingDTO` ya limpio (`fromSalaWire`): nombre, hora, servicio, profesional,
 * sala, obra social, copago y cobro. Plata en centavos con `formatARS`.
 */
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { formatARS } from "@/lib/format";
import {
  RECEPTION_ACTION_LABEL,
  receptionState,
  sortForReception,
  type ReceptionAction,
  type ReceptionEntry,
} from "@/lib/reception-state";
import {
  primarySalaAction,
  salaActions,
  salaViewer,
  shortPatientName,
  type SalaEntry,
  type SalaPractitioner,
  type SalaViewer,
} from "@/lib/sala-board-state";

const MIN_MS = 60_000;
const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : NaN);

// ── Umbrales ─────────────────────────────────────────────────────────────────

/** «Próximos 30 min» (A) / «Llegan pronto» (B). */
export const DESK_SOON_MIN = 30;
/** La barra de espera se llena a los 30'. */
export const DESK_WAIT_FULL_MIN = 30;
/** Demora del profesional ≤ 5' = «Al día». */
export const DESK_DELAY_OK_MAX = 5;
/** Demora > 15' = rojo; > 5' = ámbar. */
export const DESK_DELAY_BAD_MIN = 15;

// ── Viewer ───────────────────────────────────────────────────────────────────

/** El viewer del Tablero + si cobra (`billing.manage`). */
export type DeskViewer = SalaViewer & { canCollect: boolean };

export function deskViewer(practitionerId: string | null, caps: Iterable<string>): DeskViewer {
  // Se materializa una vez: `caps` puede ser un iterador de un solo uso.
  const list = Array.from(caps);
  return { ...salaViewer(practitionerId, list), canCollect: list.includes("billing.manage") };
}

// ── Entries ──────────────────────────────────────────────────────────────────

/**
 * Una fila del escritorio: la entry de Recepción + las acciones ya filtradas por rol y por «solo hoy»
 * (`salaActions`). Un `SalaEntry` del Tablero también encaja (tiene `salaActions`).
 */
export type DeskEntry = ReceptionEntry<BookingDTO> & { salaActions: ReceptionAction[] };

/**
 * TODAS las filas del día (atendidas, ausentes y canceladas incluidas: cada lista decide), con su estado al reloj
 * `now` y las acciones del viewer. El orden es el de `sortForReception`; para la tabla y la línea de tiempo,
 * `chronological`.
 */
export function deskEntries(rows: ReadonlyArray<BookingDTO>, now: Date, viewer: SalaViewer): DeskEntry[] {
  return sortForReception(rows, now).map((e) => ({ ...e, salaActions: salaActions(e, viewer, now) }));
}

/** Orden de la tabla A y de la línea de tiempo B: hora del turno, después profesional, después id (estable). */
export function chronological<E extends { row: BookingDTO }>(es: ReadonlyArray<E>): E[] {
  return [...es].sort(
    (a, b) =>
      ms(a.row.scheduledFor) - ms(b.row.scheduledFor) ||
      a.row.practitionerId.localeCompare(b.row.practitionerId) ||
      a.row.id.localeCompare(b.row.id)
  );
}

// ── Cobro ────────────────────────────────────────────────────────────────────

/** Estados de cobro que ya no deben nada (AUTHORIZED = MP lo autorizó; REFUNDED = se devolvió, no se re-cobra). */
const SETTLED: ReadonlySet<string> = new Set(["PAID", "AUTHORIZED", "REFUNDED"]);

/** Debe copago: atendido, con copago > 0 y sin cobro registrado. */
export function owesCopago(e: Pick<ReceptionEntry<BookingDTO>, "state" | "row">): boolean {
  return e.state === "atendido" && e.row.copagoCents > 0 && !SETTLED.has(e.row.paymentStatus ?? "UNPAID");
}

/**
 * «Cobrar ahora» desde el menú ⋯ de alguien que todavía no terminó (el cobro por adelantado de la recepción).
 * No para atendidos (ahí «Cobrar» es el botón primario), ni ausentes ni cancelados (no se cobra un turno que no
 * ocurrió).
 */
function canCollectEarly(e: Pick<ReceptionEntry<BookingDTO>, "state" | "row">): boolean {
  if (e.state === "atendido" || e.state === "ausente" || e.state === "cancelado") return false;
  return e.row.copagoCents > 0 && !SETTLED.has(e.row.paymentStatus ?? "UNPAID");
}

// ── Filtros (chips de A) ─────────────────────────────────────────────────────

export type DeskFilter = "todos" | "por-llegar" | "en-sala" | "demorados" | "por-cobrar" | "atendidos";

const FILTERS: ReadonlyArray<{ id: DeskFilter; label: string }> = [
  { id: "todos", label: "Todos" },
  { id: "por-llegar", label: "Por llegar" },
  { id: "en-sala", label: "En sala" },
  { id: "demorados", label: "Demorados" },
  { id: "por-cobrar", label: "Por cobrar" },
  { id: "atendidos", label: "Atendidos" },
];

/** Chips de la tabla A. Sin `canCollect`, «Por cobrar» no existe (la Secretaria no cobra, RX-D4). */
export function deskFilters(canCollect: boolean): ReadonlyArray<{ id: DeskFilter; label: string }> {
  return canCollect ? FILTERS : FILTERS.filter((f) => f.id !== "por-cobrar");
}

/**
 * ¿La fila entra en el chip? «Todos» = el día sin cancelados (la misma base que `total` de los KPIs; un cancelado
 * no es trabajo de la recepción, se reactiva desde la agenda).
 */
export function matchesDeskFilter(e: ReceptionEntry<BookingDTO>, f: DeskFilter): boolean {
  switch (f) {
    case "todos":
      return e.state !== "cancelado";
    case "por-llegar":
      return e.state === "por-llegar" || e.state === "demorado";
    case "en-sala":
      return e.state === "en-sala" || e.state === "llamado";
    case "demorados":
      return e.state === "demorado";
    case "por-cobrar":
      return owesCopago(e);
    case "atendidos":
      return e.state === "atendido" || e.state === "ausente";
  }
}

// ── KPIs del header ──────────────────────────────────────────────────────────

export type DeskKpis = { enSala: number; enAtencion: number; demorados: number; terminados: number; total: number };

/**
 * KPIs del header, sobre TODAS las filas del día (no las filtradas). «En sala» incluye a los llamados (misma cuenta
 * que `boardCounters`/`receptionCounters`: si no, la Secretaria leería dos números para la misma sala). «Terminados»
 * = atendidos + ausentes (el turno ya no espera nada; misma cuenta que el progreso de la franja). `total` sin
 * cancelados.
 */
export function deskKpis(entries: ReadonlyArray<ReceptionEntry<BookingDTO>>): DeskKpis {
  const k: DeskKpis = { enSala: 0, enAtencion: 0, demorados: 0, terminados: 0, total: 0 };
  for (const e of entries) {
    if (e.state === "cancelado") continue;
    k.total += 1;
    if (e.state === "en-sala" || e.state === "llamado") k.enSala += 1;
    else if (e.state === "en-atencion") k.enAtencion += 1;
    else if (e.state === "demorado") k.demorados += 1;
    else if (e.state === "atendido" || e.state === "ausente") k.terminados += 1;
  }
  return k;
}

// ── Listas del panel (A) y carriles (B) ──────────────────────────────────────

/**
 * Sala de espera: los LLAMADOS primero (van camino al box; por `calledAt`), después los que esperan por orden de
 * LLEGADA (`arrivedAt`: se atiende al que llegó antes, no al del turno más temprano). `now` no cambia el orden; está
 * en la firma para que todas las listas se llamen igual.
 */
export function waitingEntries<E extends ReceptionEntry<BookingDTO>>(es: ReadonlyArray<E>, _now: Date): E[] {
  const rank = (e: E) => (e.state === "llamado" ? 0 : 1);
  const key = (e: E) => (e.state === "llamado" ? ms(e.row.calledAt) : ms(e.row.arrivedAt));
  return es
    .filter((e) => e.state === "llamado" || e.state === "en-sala")
    .sort((a, b) => rank(a) - rank(b) || key(a) - key(b) || a.row.id.localeCompare(b.row.id));
}

/** Minutos hasta el inicio del turno (negativo = ya debería haber empezado). Entero hacia arriba: «en 1'» a los 30 s. */
export function minutesUntil(row: Pick<BookingDTO, "scheduledFor">, now: Date): number {
  return Math.ceil((ms(row.scheduledFor) - now.getTime()) / MIN_MS);
}

/**
 * Minutos enteros desde `iso` (llegada, entrada al box); 0 si falta o es futuro. Uno solo para Lista y panel y Flujo
 * (RX-Z): cada cara tenía su copia y el revisor encontró el «0' espera» del llamado por medir desde el campo
 * equivocado; con un único helper la regla de redondeo (piso, nunca negativo) no puede divergir entre caras.
 */
export function minutesSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now.getTime() - ms(iso)) / MIN_MS));
}

/** Próximos 30' / Llegan pronto: los demorados + los por llegar que empiezan en ≤ 30'. Cronológico. */
export function soonEntries<E extends ReceptionEntry<BookingDTO>>(es: ReadonlyArray<E>, now: Date): E[] {
  return chronological(
    es.filter(
      (e) => e.state === "demorado" || (e.state === "por-llegar" && ms(e.row.scheduledFor) - now.getTime() <= DESK_SOON_MIN * MIN_MS)
    )
  );
}

/** En atención (tercera card/carril de quien no cobra): el que entró antes, arriba. */
export function attendingEntries<E extends ReceptionEntry<BookingDTO>>(es: ReadonlyArray<E>, _now: Date): E[] {
  return es
    .filter((e) => e.state === "en-atencion")
    .sort((a, b) => ms(a.row.attendingAt) - ms(b.row.attendingAt) || a.row.id.localeCompare(b.row.id));
}

/** Por cobrar: atendidos que deben copago (cronológico) y el total pendiente, en centavos. */
export function cashEntries<E extends ReceptionEntry<BookingDTO>>(
  es: ReadonlyArray<E>
): { entries: E[]; totalCents: number } {
  const entries = chronological(es.filter(owesCopago));
  return { entries, totalCents: entries.reduce((s, e) => s + e.row.copagoCents, 0) };
}

/** Espera en minutos → llenado de la barra (0..1), lleno a los `DESK_WAIT_FULL_MIN`. null/negativo = 0. */
export function waitFill(minutes: number | null | undefined): number {
  if (minutes == null || !(minutes > 0)) return 0;
  return Math.min(1, minutes / DESK_WAIT_FULL_MIN);
}

/** «Pasó la hora»: en la sala (o llamado) y ya es más tarde que la hora del turno. */
export function pastScheduled(e: Pick<ReceptionEntry<BookingDTO>, "state" | "row">, now: Date): boolean {
  return (e.state === "en-sala" || e.state === "llamado") && now.getTime() > ms(e.row.scheduledFor);
}

// ── Franja de profesionales ──────────────────────────────────────────────────

export type PulseStatus = "free" | "on-time" | "late" | "very-late";
export type PractitionerPulse = {
  id: string;
  name: string;
  initials: string;
  status: PulseStatus;
  delayMin: number;
  line:
    | { kind: "with"; patient: string; minutes: number } // «Con Martín S. · 18'»
    | { kind: "called"; patient: string } // «Llamó a Laura P.»
    | { kind: "waiting-for"; patient: string } // «Espera a Facundo M.» (primer demorado)
    | { kind: "room"; room: string } // nombre de la sala del próximo turno
    | { kind: "idle" }; // sin sala ni nada
  done: number; // atendido|ausente
  total: number; // no cancelados
};

/**
 * Pulso de cada profesional para la franja (prototipo `proInfo()`). Solo los que tienen ≥ 1 turno no cancelado hoy,
 * en el orden de `practitioners` (RX-D9: el de `listPractitioners`). Un profesional que ya no está en el catálogo
 * (dado de baja con turnos de hoy) va al final como «Profesional» / «?», igual que en `buildBoard`: su paciente no
 * puede desaparecer de la recepción.
 *
 * Demora = el máximo, con piso 0, de:
 *   - en atención: cuánto empezó tarde (`attendingAt − scheduledFor`) y cuánto se pasó del fin (`now − fin`);
 *   - llamado / en sala: cuánto pasó de la hora del turno (`now − scheduledFor`).
 * Estado: sin nadie en atención ni llamado → «Libre» (aunque haya alguien esperando: el profesional no tiene a nadie
 * adentro); demora ≤ 5 → «Al día»; ≤ 15 → ámbar; > 15 → rojo.
 * Segunda línea, en este orden: con quién está (y hace cuánto), a quién llamó, a qué demorado espera, la sala del
 * próximo turno que no terminó, o nada. Los nombres van cortos (`shortPatientName`: es una pantalla que se ve desde
 * la sala).
 */
export function practitionerPulse(
  rows: ReadonlyArray<BookingDTO>,
  practitioners: ReadonlyArray<SalaPractitioner>,
  now: Date,
  roomById: Readonly<Record<string, { name: string }>> | null
): PractitionerPulse[] {
  const byPro = new Map<string, BookingDTO[]>();
  for (const r of rows) {
    if (r.status === "CANCELLED") continue;
    const list = byPro.get(r.practitionerId);
    if (list) list.push(r);
    else byPro.set(r.practitionerId, [r]);
  }
  const ordered: SalaPractitioner[] = practitioners.filter((p) => byPro.has(p.id));
  const known = new Set(practitioners.map((p) => p.id));
  for (const id of byPro.keys()) if (!known.has(id)) ordered.push({ id, name: "Profesional", initials: "?" });

  const t = now.getTime();
  return ordered.map((p) => {
    const list = [...(byPro.get(p.id) ?? [])].sort(
      (a, b) => ms(a.scheduledFor) - ms(b.scheduledFor) || a.id.localeCompare(b.id)
    );
    let delay = 0;
    let current: BookingDTO | null = null;
    let called: BookingDTO | null = null;
    let waitingFor: BookingDTO | null = null;
    let nextRoom: string | null = null;
    let done = 0;
    for (const r of list) {
      const s = receptionState(r, now);
      const start = ms(r.scheduledFor);
      if (s === "en-atencion") {
        current ??= r;
        delay = Math.max(delay, ms(r.attendingAt) - start, t - (start + r.durationMin * MIN_MS));
      } else if (s === "llamado") {
        called ??= r;
        delay = Math.max(delay, t - start);
      } else if (s === "en-sala") {
        delay = Math.max(delay, t - start);
      } else if (s === "demorado") {
        waitingFor ??= r;
      }
      if (s === "atendido" || s === "ausente") done += 1;
      else if (nextRoom == null && typeof r.roomId === "string" && roomById?.[r.roomId]) nextRoom = roomById[r.roomId].name;
    }
    const delayMin = Math.max(0, Math.floor(delay / MIN_MS));
    const status: PulseStatus =
      !current && !called
        ? "free"
        : delayMin <= DESK_DELAY_OK_MAX
          ? "on-time"
          : delayMin <= DESK_DELAY_BAD_MIN
            ? "late"
            : "very-late";
    const line: PractitionerPulse["line"] = current
      ? {
          kind: "with",
          patient: shortPatientName(current.patientName),
          minutes: Math.max(0, Math.floor((t - ms(current.attendingAt)) / MIN_MS)),
        }
      : called
        ? { kind: "called", patient: shortPatientName(called.patientName) }
        : waitingFor
          ? { kind: "waiting-for", patient: shortPatientName(waitingFor.patientName) }
          : nextRoom
            ? { kind: "room", room: nextRoom }
            : { kind: "idle" };
    return { id: p.id, name: p.name, initials: p.initials, status, delayMin, line, done, total: list.length };
  });
}

// ── Botón primario y menú ⋯ ──────────────────────────────────────────────────

export type DeskPrimary =
  | { kind: "action"; action: ReceptionAction; label: string }
  | { kind: "collect"; label: "Cobrar" }
  | null;

/**
 * Botón primario de la fila (prototipo `primary()`): Llegó / Llamar / En atención / Atendido según el estado (la
 * misma `primarySalaAction` del Tablero), solo si el viewer puede hacerla (`salaActions`: rol, «solo hoy»,
 * `canOperate`). Un atendido que debe copago muestra «Cobrar», solo a quien cobra.
 */
export function deskPrimary(e: Pick<DeskEntry, "row" | "state" | "salaActions">, viewer: DeskViewer): DeskPrimary {
  if (e.state === "atendido") return viewer.canCollect && owesCopago(e) ? { kind: "collect", label: "Cobrar" } : null;
  const a = primarySalaAction(e.state);
  return a && e.salaActions.includes(a) ? { kind: "action", action: a, label: RECEPTION_ACTION_LABEL[a] } : null;
}

export type DeskMenuItem =
  | { kind: "action"; action: ReceptionAction; label: string }
  | { kind: "collect"; label: string } // «Cobrar ahora ($ 6.000)», solo canCollect y no atendido
  | { kind: "agenda"; href: string; label: "Ver turno en la agenda" };

/**
 * Menú ⋯ de la fila: las acciones del viewer menos la primaria (saltear pasos: En atención o Atendido desde la sala,
 * Ausente, Deshacer), «Cobrar ahora» para quien cobra y el turno todavía no terminó, y el link a la agenda en ese
 * día filtrada por el profesional (`view=timeline`: la vista Día de siempre; `view=day` no existe y caía al default).
 * Acepta un `SalaEntry` del Tablero o un `DeskEntry`.
 */
export function deskMenuItems(
  e: Pick<SalaEntry, "row" | "state" | "salaActions">,
  viewer: DeskViewer,
  dayKey: string
): DeskMenuItem[] {
  const primary = primarySalaAction(e.state);
  const items: DeskMenuItem[] = e.salaActions
    .filter((a) => a !== primary)
    .map((action) => ({ kind: "action", action, label: RECEPTION_ACTION_LABEL[action] }));
  if (viewer.canCollect && canCollectEarly(e)) {
    items.push({ kind: "collect", label: `Cobrar ahora (${formatARS(e.row.copagoCents)})` });
  }
  const q = new URLSearchParams({ date: dayKey, view: "timeline", pros: e.row.practitionerId });
  items.push({ kind: "agenda", href: `/agenda?${q.toString()}`, label: "Ver turno en la agenda" });
  return items;
}

// ── Línea de «ahora» (A) ─────────────────────────────────────────────────────

/**
 * Índice de la primera fila que empieza ahora o después (la línea va justo antes). −1 = no hay futuros (la línea va
 * al final). `sorted` tiene que venir en orden cronológico (`chronological`).
 */
export function nowLineIndex(sorted: ReadonlyArray<{ row: BookingDTO }>, now: Date): number {
  const t = now.getTime();
  return sorted.findIndex((e) => ms(e.row.scheduledFor) >= t);
}

/**
 * Fila a la que se scrollea al abrir: `context` turnos antes de la línea (3), así se ve lo que acaba de pasar.
 * −1 (sin futuros) → −1: el caller scrollea al final.
 */
export function scrollAnchorIndex(nowIdx: number, context = 3): number {
  if (nowIdx < 0) return -1;
  return Math.max(0, nowIdx - Math.max(0, context));
}

// ── Atajos de teclado ────────────────────────────────────────────────────────

export type DeskShortcut = "search" | "new-booking" | "clear" | null;

/**
 * `/` enfoca el buscador, `N` va a «Nuevo turno», `Esc` limpia el buscador (solo escribiendo ahí). Con un
 * modificador (Ctrl/Cmd/Alt: los atajos del navegador) o con un modal/drawer/menú abierto, nada. Escribiendo en un
 * campo, `/` y `n` son texto.
 * `ctx.typing` = el foco está en el buscador (u otro campo editable); lo decide el caller.
 */
export function deskShortcut(
  key: string,
  ctx: { typing: boolean; modifier: boolean; overlayOpen: boolean }
): DeskShortcut {
  if (ctx.modifier || ctx.overlayOpen) return null;
  if (key === "Escape") return ctx.typing ? "clear" : null;
  if (ctx.typing) return null;
  if (key === "/") return "search";
  if (key === "n" || key === "N") return "new-booking";
  return null;
}
