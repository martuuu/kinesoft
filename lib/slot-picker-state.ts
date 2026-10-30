/**
 * Lógica pura del selector de horarios del modal de turno (B5.2 MOD-slots):
 * `components/agenda/booking-modal/slot-picker.tsx` y el aviso en vivo de
 * `schedule-section.tsx`. Vive fuera de los componentes para testearla en
 * TZ=UTC y TZ=AR (AGENTS.md §3: la lógica pura va en un módulo testeable).
 *
 * Reglas:
 *   • Días = `DayKey` AR. "Hoy" sale de `toARDateKey(now)` y la navegación de
 *     `addDays` (aritmética de calendario, sin huso): nunca `getDay`/
 *     `toISOString().slice(0,10)` del host, que en un navegador fuera de AR o
 *     después de las 21:00 AR en UTC corren el día.
 *   • La hora de un slot es `slot.time` ("HH:MM" AR que manda el server): no
 *     se recalcula. Solo `firstFree` (que trae ISO) se formatea acá, con los
 *     helpers de `lib/datetime-ar.ts` (Intl con `timeZone` AR).
 *   • Sin PHI: la respuesta de `listAvailableSlots` no trae nombres; el nombre
 *     del profesional lo pone la UI con su propio mapa (`labelOf`).
 */
import { addDays, dayKeyDiff, dowOfDayKey, formatWallTime } from "@/lib/availability/day";
import type { DayKey, InstantClass, SlotUnavailableReason } from "@/lib/availability/types";
import type { AnySlots, InstantCheck, ListSlotsResult, StaffSlot } from "@/lib/availability-actions-types";
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import { arIntervalLabels } from "@/lib/availability/interval-cap";
import { intervalCapNoticeText } from "@/lib/booking-force-flags";
import { AGENDA_RULES_COPY, otherServiceLiveText } from "@/lib/agenda-rules-config";

/**
 * Copy es-AR de cada clase, para el aviso en vivo del modal (B5.x).
 * T3a-0z2 (19-oct): vivía en `lib/availability-actions-types.ts`, que entra al first-load de /agenda; acá solo lo
 * carga el modal (diferido con `next/dynamic`).
 */
export const INSTANT_CLASS_LABEL: Record<InstantClass, string> = {
  libre: "Libre",
  sobreturno: "Sobreturno: el cupo de ese horario está completo",
  "paciente-superpuesto": "El paciente ya tiene otro turno en ese horario",
  "fuera-de-horario": "Fuera del horario del profesional",
  bloqueado: "Horario bloqueado",
  duplicado: "El paciente ya tiene un turno a esa hora",
  "tope-intervalo": "El profesional ya llegó a su tope de turnos en ese horario",
  // CF-U2: copy genérico (sin nombre); el aviso en vivo usa `otherServiceLiveText(nombre)` en `instantStatusView`.
  "otro-servicio": otherServiceLiveText(null),
};

// ─────────────────────────────────────────────────────────────────────────────
// Días
// ─────────────────────────────────────────────────────────────────────────────

/** Hoy en AR (no el día del host). */
export function todayDayKey(now: Date): DayKey {
  return toARDateKey(now);
}

/** ‹ / › del navegador de días. */
export function shiftDay(dayKey: DayKey, delta: number): DayKey {
  return addDays(dayKey, delta);
}

const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/** "Hoy" / "Mañana" / "Ayer" o "mié 30/09" (con año si no es el de hoy).
 *  El día de la semana sale de `dowOfDayKey` (calendario puro, sin huso). */
export function dayLabel(dayKey: DayKey, today: DayKey): string {
  const diff = dayKeyDiff(today, dayKey);
  if (diff === 0) return "Hoy";
  if (diff === 1) return "Mañana";
  if (diff === -1) return "Ayer";
  const [y, m, d] = dayKey.split("-");
  const base = `${DOW_SHORT[dowOfDayKey(dayKey)]} ${d}/${m}`;
  return y === today.slice(0, 4) ? base : `${base}/${y}`;
}

/** Etiqueta completa para lectores de pantalla y el título del navegador. */
export function dayLabelLong(dayKey: DayKey, today: DayKey): string {
  const short = dayLabel(dayKey, today);
  const [, m, d] = dayKey.split("-");
  const named = `${DOW_SHORT[dowOfDayKey(dayKey)]} ${d}/${m}`;
  return short.startsWith(named) ? short : `${short}, ${named}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chips de horario
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tono de un chip:
 *   • free     — disponible y sin conflicto del paciente (resaltado).
 *   • full     — cupo completo o tope por intervalo completo (T3): elegible
 *                igual (el staff puede dar sobreturno; el aviso en vivo y
 *                `createBooking` lo confirman con «Cargar como sobreturno»).
 *   • conflict — el paciente ya tiene otro turno solapado: elegible con aviso.
 *   • blocked  — no elegible: ya pasó, fuera de anticipación/horizonte, o el
 *                paciente ya tiene un turno a ESA hora (duplicado: el índice
 *                único parcial lo rechaza siempre).
 * Decisión B5.2: "pasado" no se elige desde el picker; para cargar un turno
 * retroactivo queda la entrada manual de fecha/hora.
 */
export type ChipTone = "free" | "full" | "conflict" | "blocked";

export type ChipView = {
  tone: ChipTone;
  selectable: boolean;
  /** "1/3" (ocupación actual) o null si no hay nada que mostrar. */
  occupancy: string | null;
  /** Motivo para el tooltip / aria-label (null si está libre sin nada). */
  hint: string | null;
  /** CF-U2: nota corta visible junto a la hora (`OTHER_SERVICE_CHIP_NOTE`). Ausente = nada que agregar. */
  note?: string;
};

/**
 * ZB M8: la nota visible del chip «otro servicio». Con el texto completo («Atiende otro servicio») cada chip duplicaba
 * su ancho y una grilla de 15 min quedaba en una columna a 1366×768. El texto completo sigue en `aria-label` y `title`
 * (vía `hint` = `otherServiceNotice`) y en la leyenda.
 */
export const OTHER_SERVICE_CHIP_NOTE = "otro serv.";

const REASON_LABEL: Record<SlotUnavailableReason, string> = {
  pasado: "Ya pasó",
  "anticipacion-minima": "Antes de la anticipación mínima",
  "fuera-de-horizonte": "Fuera del horizonte de reserva",
  "cupo-completo": "Cupo completo",
  "otro-servicio": AGENDA_RULES_COPY.otherServiceNotice,
  "tope-intervalo": "Tope completo",
};

/** Ocupación "usados/cupo". Ilimitado: solo si hay alguno ("2/∞"). */
export function occupancyLabel(used: number, cap: number | null): string | null {
  if (cap == null) return used > 0 ? `${used}/∞` : null;
  return `${used}/${cap}`;
}

export function chipView(slot: StaffSlot): ChipView {
  const occupancy = occupancyLabel(slot.used, slot.cap);
  // En el chip solo si hay alguien y el cupo es de más de uno: "0/2" en cada
  // chip o "1/1" en un cupo de uno es ruido (el color ya dice libre/lleno).
  const occ = slot.used > 0 && slot.cap !== 1 ? occupancy : null;
  if (slot.patientConflict === "duplicado") {
    return { tone: "blocked", selectable: false, occupancy: occ, hint: INSTANT_CLASS_LABEL.duplicado };
  }
  // T3 (C-AS3): el tope por intervalo es forzable por el staff (sobreturno,
  // decisión 6) igual que el cupo: no cae en "blocked". El turnero no lo
  // ofrece (duro), pero ese camino no usa este chip.
  // CF-U2 (§28 decisión 2): «otro-servicio» también. El staff ve el aviso y puede forzarlo como sobreturno; el
  // turnero lo bloquea duro en el server (`public-booking-slots`), que no pasa por este chip.
  const forceable = slot.reason === "cupo-completo" || slot.reason === "tope-intervalo" || slot.reason === "otro-servicio";
  if (!slot.available && !forceable) {
    return { tone: "blocked", selectable: false, occupancy: occ, hint: REASON_LABEL[slot.reason ?? "pasado"] };
  }
  if (slot.patientConflict === "paciente-superpuesto") {
    return { tone: "conflict", selectable: true, occupancy: occ, hint: "El paciente ya tiene un turno en ese horario" };
  }
  if (!slot.available && slot.reason === "tope-intervalo") {
    const use = slot.intervalCapUse;
    return {
      tone: "full",
      selectable: true,
      occupancy: occ,
      hint: `${REASON_LABEL["tope-intervalo"]}${use ? ` (${use.used}/${use.cap.count})` : ""}: se carga como sobreturno si confirmás`,
    };
  }
  if (!slot.available && slot.reason === "otro-servicio") {
    // Mismo tono que el cupo completo (es un sobreturno al confirmar); el canal no cromático es la línea `note`.
    return {
      tone: "full",
      selectable: true,
      occupancy: occ,
      hint: AGENDA_RULES_COPY.otherServiceNotice,
      note: OTHER_SERVICE_CHIP_NOTE,
    };
  }
  if (!slot.available) {
    return {
      tone: "full",
      selectable: true,
      occupancy: occ,
      // T3-Z (B5): mismo cierre que el tope («si confirmás»): elegir el chip no carga nada todavía.
      hint: `${REASON_LABEL["cupo-completo"]}${occupancy ? ` ${occupancy}` : ""}: se carga como sobreturno si confirmás`,
    };
  }
  return { tone: "free", selectable: true, occupancy: occ, hint: occupancy && slot.used > 0 ? `Ocupación ${occupancy}` : null };
}

/** Agrupa por hora de pared ("08", "09"…) usando `slot.time` del server. Con
 *  paso 15 un día de 8 a 19 son ~44 chips: por fila de hora se leen mejor. */
export function groupByHour<T extends { time: string }>(slots: ReadonlyArray<T>): { hour: string; slots: T[] }[] {
  const out: { hour: string; slots: T[] }[] = [];
  for (const s of slots) {
    const hour = s.time.slice(0, 2);
    const last = out[out.length - 1];
    if (last && last.hour === hour) last.slots.push(s);
    else out.push({ hour, slots: [s] });
  }
  return out;
}

/**
 * `otherService` cuenta aparte los chips «otro servicio»: comparten el tono `full` (son sobreturno al confirmar) pero
 * no son «cupo completo». Sumarlos a `full` prendía la leyenda «Cupo completo (sobreturno)» sin ningún chip con el cupo
 * lleno (ZB B13).
 */
export type SlotSummary = {
  total: number;
  free: number;
  full: number;
  conflict: number;
  blocked: number;
  otherService: number;
};

export function summarizeSlots(slots: ReadonlyArray<StaffSlot>): SlotSummary {
  const s: SlotSummary = { total: slots.length, free: 0, full: 0, conflict: 0, blocked: 0, otherService: 0 };
  for (const slot of slots) {
    const v = chipView(slot);
    if (v.note === OTHER_SERVICE_CHIP_NOTE) s.otherService += 1;
    else s[v.tone] += 1;
  }
  return s;
}

/** CF-U2: hay al menos un chip «Atiende otro servicio» elegible (prende la entrada de la leyenda). */
export function hasOtherServiceChip(slots: ReadonlyArray<StaffSlot>): boolean {
  return slots.some((s) => chipView(s).note === OTHER_SERVICE_CHIP_NOTE);
}

/**
 * CF-U2 (§28 decisión 3, CF-D6): encabezado del selector con el paso que RIGE la grilla. El server lo resuelve
 * (pedido ?? profesional ?? consultorio ?? 15) y lo manda en `PractitionerSlots.stepMin`; en «cualquiera», por
 * profesional (`p.stepMin ?? data.stepMin`: el opcional es por fixtures viejos). Si los pasos difieren no se elige
 * uno: «según cada profesional» (cada fila muestra el suyo). Sin profesionales elegibles → null (no hay grilla).
 */
export function slotStepHeader(data: ListSlotsResult): string | null {
  if (data.mode === "practitioner") return `Horarios cada ${data.stepMin} min`;
  const steps = new Set(data.practitioners.map((p) => p.stepMin ?? data.stepMin));
  if (steps.size === 0) return null;
  if (steps.size > 1) return "Horarios según cada profesional";
  return `Horarios cada ${[...steps][0]} min`;
}

/**
 * CF-U2 (CF-D6): el instante elegido (`value`) cae en el día que se mira pero NO está en la grilla. Pasa con el
 * «Primer turno libre» (`firstFree` sigue en paso 15: con grilla de 30 puede sugerir 10:15) y con la hora manual.
 * Devuelve su «HH:MM» AR para avisarlo; el server lo valida igual al confirmar. null = está en la lista, es otro día
 * o no hay nada elegido.
 */
export function offGridPickTime(
  value: string | null | undefined,
  data: { dayKey: DayKey; slots: ReadonlyArray<{ iso: string }> }
): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  if (toARDateKey(new Date(t)) !== data.dayKey) return null;
  if (data.slots.some((s) => Date.parse(s.iso) === t)) return null;
  return formatWallTime(toARMinutes(new Date(t)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hora manual (schedule-section)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CF-U2 (§28 decisión 3: «la carga manual de la hora exacta ya existe y hay que hacerla más visible»). El input de
 * fecha y hora siempre estuvo debajo del selector, pero con un rótulo que pasaba desapercibido. Ahora:
 *   • «open»   — el botón «¿Otro horario? Cargalo a mano»: entra en modo manual y pide foco (`focusNonce` sube
 *                aunque ya esté en manual, así un segundo click vuelve a llevar el foco a la hora);
 *   • «edit»   — el staff tocó la fecha/hora a mano: modo manual sin robar el foco;
 *   • «picked» — eligió un chip o «Usar» el primer libre: vuelve al rótulo normal.
 */
export type ManualEntryState = { manual: boolean; focusNonce: number };
export type ManualEntryEvent = { type: "open" } | { type: "edit" } | { type: "picked" };
export const MANUAL_ENTRY_INITIAL: ManualEntryState = { manual: false, focusNonce: 0 };

export function manualEntryReducer(s: ManualEntryState, e: ManualEntryEvent): ManualEntryState {
  switch (e.type) {
    case "open":
      return { manual: true, focusNonce: s.focusNonce + 1 };
    case "edit":
      return s.manual ? s : { ...s, manual: true };
    case "picked":
      return s.manual ? { ...s, manual: false } : s;
  }
}

export type ManualEntryView = {
  /** Texto del botón; null sin selector (la entrada manual es la única y no hace falta invitar). */
  cta: string | null;
  label: string;
  hint: string | null;
  /** Resalta el bloque de la entrada manual. */
  highlighted: boolean;
};

/** ZB B14: «Cargalo» (no «Escribilo»): es el verbo del resto del modal. */
export const OTHER_TIME_CTA = "¿Otro horario? Cargalo a mano";

export function manualEntryView(s: ManualEntryState, hasPicker: boolean): ManualEntryView {
  if (!hasPicker) return { cta: null, label: "Fecha y hora", hint: null, highlighted: false };
  if (!s.manual) {
    // ZB B14: el rótulo vuelve a «Fecha y hora»; «(o cargá a mano)» repetía el botón de arriba.
    return { cta: OTHER_TIME_CTA, label: "Fecha y hora", hint: null, highlighted: false };
  }
  return {
    cta: OTHER_TIME_CTA,
    label: "Fecha y hora exacta",
    hint: "Podés cargar cualquier hora, también fuera de la grilla o en el pasado: si choca con algo, te lo avisamos antes de guardar.",
    highlighted: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// "Cualquier profesional"
// ─────────────────────────────────────────────────────────────────────────────

export type AnyRow = {
  practitionerId: string;
  label: string;
  firstSlot: StaffSlot | null;
  availableCount: number;
  /** El hueco destacado ("primer turno libre") es de este profesional y hoy. */
  isFirstFree: boolean;
  /** CF-U2: paso de la grilla de ESTE profesional (`p.stepMin ?? data.stepMin`). */
  stepMin: number;
};

/**
 * Filas del modo "any", una por profesional elegible. Orden: los que tienen
 * hueco ese día primero, por hora del primer hueco; empate y sin hueco
 * conservan el orden del consultorio (el del server). `labelOf` resuelve el
 * nombre (la respuesta no trae PHI ni nombres).
 */
export function anyRows(data: AnySlots, labelOf: (practitionerId: string) => string): AnyRow[] {
  const firstFree = data.firstFree;
  const rows = data.practitioners.map((p, idx) => ({
    idx,
    row: {
      practitionerId: p.practitionerId,
      label: labelOf(p.practitionerId),
      firstSlot: p.firstSlot,
      availableCount: p.availableCount,
      stepMin: p.stepMin ?? data.stepMin,
      isFirstFree:
        !!firstFree && !!p.firstSlot && firstFree.practitionerId === p.practitionerId && firstFree.iso === p.firstSlot.iso,
    } satisfies AnyRow,
  }));
  rows.sort((a, b) => {
    const ai = a.row.firstSlot?.iso ?? null;
    const bi = b.row.firstSlot?.iso ?? null;
    if (ai && bi && ai !== bi) return ai < bi ? -1 : 1;
    if (ai && !bi) return -1;
    if (!ai && bi) return 1;
    return a.idx - b.idx;
  });
  return rows.map((r) => r.row);
}

export type FirstFreeView = {
  practitionerId: string;
  iso: string;
  dayKey: DayKey;
  /** "HH:MM" AR. */
  time: string;
  /** "Primer turno libre: Lic. Pérez · Mañana · 10:15". */
  text: string;
  /** Cae en otro día que el que se está mirando. */
  otherDay: boolean;
};

export function firstFreeView(
  data: Pick<AnySlots, "firstFree" | "dayKey">,
  today: DayKey,
  labelOf: (practitionerId: string) => string
): FirstFreeView | null {
  const ff = data.firstFree;
  if (!ff) return null;
  const dayKey = toARDateKey(ff.iso);
  const time = formatWallTime(toARMinutes(ff.iso));
  return {
    practitionerId: ff.practitionerId,
    iso: ff.iso,
    dayKey,
    time,
    text: `Primer turno libre: ${labelOf(ff.practitionerId)} · ${dayLabel(dayKey, today)} · ${time}`,
    otherDay: dayKey !== data.dayKey,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Teclado (radiogroup con roving tabindex)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Próximo índice enfocable de un radiogroup: ←/→ y ↑/↓ saltan los no
 * elegibles y dan la vuelta (patrón WAI-ARIA de radio group); Home/End van al
 * primero/último elegible. Otra tecla o ninguno elegible → null.
 */
export function moveRoving(selectable: ReadonlyArray<boolean>, current: number, key: string): number | null {
  const n = selectable.length;
  if (n === 0 || !selectable.some(Boolean)) return null;
  if (key === "Home") return selectable.indexOf(true);
  if (key === "End") return selectable.lastIndexOf(true);
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (step === 0) return null;
  let i = current < 0 || current >= n ? (step > 0 ? -1 : n) : current;
  for (let k = 0; k < n; k++) {
    i = (i + step + n) % n;
    if (selectable[i]) return i;
  }
  return null;
}

/** Índice que recibe el Tab en el grupo: el elegido si es elegible, si no el
 *  primero elegible (o -1). */
export function rovingEntry(selectable: ReadonlyArray<boolean>, selectedIndex: number): number {
  if (selectedIndex >= 0 && selectable[selectedIndex]) return selectedIndex;
  return selectable.indexOf(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pedidos: debounce + cancelación por secuencia
// ─────────────────────────────────────────────────────────────────────────────

/** Debounce de las consultas del picker y del aviso en vivo (ms). */
export const SLOT_QUERY_DEBOUNCE_MS = 250;

/**
 * Secuenciador: cada pedido toma un número y solo el último aplica su
 * respuesta. Una respuesta lenta de un día anterior no pisa la del día que se
 * está mirando (las server actions no se pueden abortar).
 */
export function createSequencer() {
  let last = 0;
  return {
    next(): number {
      last += 1;
      return last;
    },
    isCurrent(n: number): boolean {
      return n === last;
    },
    /** Invalida lo que esté en vuelo (desmontaje, pedido sin datos). */
    cancel(): void {
      last += 1;
    },
  };
}

/** Clave estable de la consulta (dependencia del efecto del picker). */
export function slotQueryKey(q: {
  practitionerId: string;
  serviceId: string | null;
  dayKey: string;
  locationId?: string | null;
  patientId?: string | null;
  insurerId?: string | null;
  durationMin?: number;
}): string {
  return [
    q.practitionerId,
    q.serviceId ?? "",
    q.dayKey,
    q.locationId ?? "",
    q.patientId ?? "",
    q.insurerId ?? "",
    q.durationMin ?? "",
  ].join("|");
}

/** Duración válida para la action (zod 5..480 entero); si no, se omite y el
 *  server usa la del profesional/servicio. */
export function sanitizeDuration(min: number | undefined | null): number | undefined {
  if (min == null || !Number.isInteger(min) || min < 5 || min > 480) return undefined;
  return min;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aviso en vivo del instante elegido (schedule-section)
// ─────────────────────────────────────────────────────────────────────────────

export type InstantTone = "ok" | "warn" | "danger";

export type InstantStatusView = {
  tone: InstantTone;
  /** Línea principal: "Libre", "Sobreturno 2/1", "Bloqueado: Feriado"… */
  title: string;
  /** Detalle (copy de `INSTANT_CLASS_LABEL`) y flags extra. */
  details: string[];
};

/**
 * `InstantCheck` → texto del aviso. Sobreturno muestra cómo QUEDARÍA el cupo
 * con este turno (`used + 1`/cap: "2/1"), no la ocupación actual. Los flags
 * `outOfHours`/`blocked` se suman como detalle cuando ganó otra clase (el
 * motor los informa igual, ver `InstantClassification`).
 */
export function instantStatusView(c: InstantCheck, opts?: { practitionerName?: string | null }): InstantStatusView {
  const details: string[] = [];
  const reasons = c.blockReasons.filter((r) => r.trim().length > 0);
  let tone: InstantTone;
  let title: string;
  switch (c.class) {
    case "libre":
      tone = "ok";
      title = INSTANT_CLASS_LABEL.libre;
      if (c.cap != null && c.cap > 1) details.push(`Ocupación ${c.used}/${c.cap}`);
      break;
    case "sobreturno":
      tone = "warn";
      title = `Sobreturno${c.cap != null ? ` ${c.used + 1}/${c.cap}` : ""}`;
      details.push(INSTANT_CLASS_LABEL.sobreturno);
      break;
    case "paciente-superpuesto":
      tone = "warn";
      title = "Paciente superpuesto";
      details.push(INSTANT_CLASS_LABEL["paciente-superpuesto"]);
      break;
    case "fuera-de-horario":
      tone = "warn";
      title = "Fuera de horario";
      details.push(INSTANT_CLASS_LABEL["fuera-de-horario"]);
      break;
    case "bloqueado":
      tone = "warn";
      title = reasons.length ? `Bloqueado: ${reasons.join(", ")}` : "Bloqueado";
      details.push(`${INSTANT_CLASS_LABEL.bloqueado}: si lo cargás, queda como sobreturno`);
      break;
    case "tope-intervalo":
      tone = "warn";
      title = c.intervalCapUse ? `Tope completo (${c.intervalCapUse.used}/${c.intervalCapUse.cap.count})` : "Tope completo";
      details.push(`${INSTANT_CLASS_LABEL["tope-intervalo"]}: si lo cargás, queda como sobreturno`);
      break;
    // CF-U2 (§28 decisión 2): el staff ve el aviso y puede forzar; el alta lo pide como sobreturno (CF-D4).
    case "otro-servicio":
      tone = "warn";
      title = AGENDA_RULES_COPY.otherServiceLine;
      details.push(otherServiceLiveText(opts?.practitionerName));
      break;
    case "duplicado":
      tone = "danger";
      title = "Turno duplicado";
      details.push(INSTANT_CLASS_LABEL.duplicado);
      break;
  }
  if (c.class !== "bloqueado" && c.blocked) {
    details.push(reasons.length ? `También pisa un bloqueo: ${reasons.join(", ")}` : "También pisa un horario bloqueado");
  }
  if (c.class !== "fuera-de-horario" && c.outOfHours) details.push("También queda fuera del horario del profesional");
  // T3: el motor informa `intervalCapped` aunque gane otra clase (forzar el
  // cupo no fuerza el tope: el alta va a pedir las dos confirmaciones).
  if (c.class !== "tope-intervalo" && c.intervalCapped) {
    details.push("También llega al tope de turnos del profesional: se carga como sobreturno si confirmás");
  }
  // CF-U2: como `intervalCapped`, el motor informa `otherServiceBusy` aunque gane otra clase (precedencia en
  // `lib/availability/classify.ts`: sobreturno > otro-servicio); forzar el cupo cubre las dos, pero conviene decirlo.
  if (c.class !== "otro-servicio" && c.otherServiceBusy) details.push(AGENDA_RULES_COPY.otherServiceAlso);
  if (!c.serviceEnabled) details.push("El profesional no tiene habilitada esta práctica");
  return { tone, title, details };
}

/**
 * T3 (C-AS3, decisión 6): aviso INFORMATIVO al elegir un horario cuyo
 * intervalo ya tiene ≥1 turno del profesional sin llegar al tope («el 2.º
 * avisa»): «Ya hay 1 turno de Ana a las 10:15.». La hora es el INICIO del
 * intervalo AR (alineado a la hora, `arIntervalLabels`, mismo cálculo que el
 * server para `intervalCapNotice`), no la del turno. Topeado (`intervalCapped`
 * o clase `tope-intervalo`) no avisa acá: lo dice el título «Tope completo» y
 * el alta pide confirmar. Sin tope (`intervalCapUse` ausente) → null.
 */
export function intervalCapLiveNotice(c: InstantCheck, iso: string, practitionerName: string): string | null {
  const use = c.intervalCapUse;
  if (!use || use.used < 1 || c.intervalCapped || c.class === "tope-intervalo") return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const { from, to } = arIntervalLabels(d, use.cap.intervalMin);
  return intervalCapNoticeText({ practitionerName, used: use.used, from, to, intervalMin: use.cap.intervalMin });
}
