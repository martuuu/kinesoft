"use client";

/**
 * Selector de horarios disponibles del modal de turno (B5.2 MOD-slots).
 *
 * Contrato con `index.tsx` (B5.1, "Contratos de la ola B5" en bpre-waves):
 *   <SlotPicker practitionerId serviceId dayKey locationId? patientId?
 *               insurerId? durationMin? value onChange onDayChange? />
 *   • `practitionerId` = un profesional o "any" (cualquiera habilitado).
 *   • `dayKey` = día AR "YYYY-MM-DD" a mostrar. El navegador ‹ Hoy › lo mueve
 *     y avisa con `onDayChange`; sin `onDayChange` el picker navega solo
 *     (estado interno sincronizado con la prop).
 *   • `value` = ISO del instante elegido (null = nada); `onChange(iso, pid)`
 *     devuelve el instante y el profesional (con "any", el del slot elegido:
 *     index lo usa para fijar el profesional del turno).
 *   • `practitionerLabels?` (opcional, AGREGADO por B5.2 sobre el contrato):
 *     nombre por id para el modo "any" y el "Primer turno libre". La
 *     respuesta de `listAvailableSlots` no trae nombres (sin PHI, la ve
 *     BILLING); sin el mapa se muestra "Profesional".
 *
 * Datos: `listAvailableSlots` (B3.3) con debounce y cancelación por secuencia
 * (`createSequencer`): una respuesta vieja nunca pisa la del día visible.
 *
 * Qué se puede elegir (`chipView` en `lib/slot-picker-state.ts`): libres
 * (resaltados), cupo completo (como sobreturno, con aviso) y paciente
 * superpuesto (con aviso); NO pasados ni el duplicado exacto (el índice único
 * parcial lo rechaza siempre). Para cargar fuera de grilla o retroactivo queda
 * la entrada manual de `schedule-section.tsx`.
 *
 * Accesibilidad: cada grilla es un `radiogroup` con roving tabindex (←→↑↓,
 * Home/End saltan los no elegibles); el estado de carga se anuncia en una
 * región `aria-live`. Fechas: todo en DayKey AR y `slot.time` del server; el
 * cliente no recalcula horas con el huso del navegador.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listAvailableSlots } from "@/lib/availability-actions";
import type {
  AnySlots,
  ListSlotsResult,
  PractitionerSlots,
  StaffSlot,
} from "@/lib/availability-actions-types";
import {
  SLOT_QUERY_DEBOUNCE_MS,
  anyRows,
  chipView,
  createSequencer,
  dayLabelLong,
  firstFreeView,
  groupByHour,
  moveRoving,
  rovingEntry,
  sanitizeDuration,
  shiftDay,
  slotQueryKey,
  summarizeSlots,
  todayDayKey,
  type ChipTone,
} from "@/lib/slot-picker-state";

export type SlotPickerProps = {
  practitionerId: string | "any";
  serviceId: string | null;
  dayKey: string;
  locationId?: string | null;
  patientId?: string | null;
  insurerId?: string | null;
  durationMin?: number;
  value: string | null /*iso*/;
  onChange: (iso: string, practitionerId: string) => void;
  onDayChange?: (dayKey: string) => void;
  /** Ver cabecera: agregado opcional de B5.2. */
  practitionerLabels?: Record<string, string>;
};

type Load<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; error: string };

const GENERIC_ERROR = "No pudimos cargar los horarios. Probá de nuevo.";

/**
 * Pide `listAvailableSlots` con debounce. `query` null = no pedir (falta la
 * práctica). La key estable evita re-pedir por identidad de objetos.
 */
function useSlots<T extends ListSlotsResult>(
  query: Parameters<typeof listAvailableSlots>[0] | null,
  key: string
): { state: Load<T>; retry: () => void } {
  const [state, setState] = useState<Load<T>>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(createSequencer());
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const q = queryRef.current;
    if (!q) {
      seq.current.cancel();
      setState({ status: "idle" });
      return;
    }
    const s = seq.current;
    const n = s.next();
    setState({ status: "loading" });
    const t = setTimeout(() => {
      listAvailableSlots(q)
        .then((res) => {
          if (!s.isCurrent(n)) return;
          setState(res.ok ? { status: "ok", data: res.data as T } : { status: "error", error: res.error || GENERIC_ERROR });
        })
        .catch(() => {
          if (s.isCurrent(n)) setState({ status: "error", error: GENERIC_ERROR });
        });
    }, SLOT_QUERY_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      s.cancel();
    };
  }, [key, nonce]);

  const retry = useCallback(() => setNonce((x) => x + 1), []);
  return { state, retry };
}

export function SlotPicker(props: SlotPickerProps) {
  const {
    practitionerId,
    serviceId,
    locationId,
    patientId,
    insurerId,
    durationMin,
    value,
    onChange,
    onDayChange,
    practitionerLabels,
  } = props;

  // "Hoy" AR al montar (el modal vive minutos, no días).
  const today = useMemo(() => todayDayKey(new Date()), []);
  const [day, setDay] = useState(props.dayKey);
  useEffect(() => setDay(props.dayKey), [props.dayKey]);

  const goTo = (next: string) => {
    setDay(next);
    onDayChange?.(next);
  };

  const labelOf = useCallback(
    (pid: string) => practitionerLabels?.[pid] ?? "Profesional",
    [practitionerLabels]
  );

  const dur = sanitizeDuration(durationMin);
  const base = { serviceId, dayKey: day, locationId, patientId, insurerId, durationMin: dur };
  const mainKey = slotQueryKey({ practitionerId, ...base });
  const main = useSlots<ListSlotsResult>(
    serviceId
      ? {
          practitionerId,
          serviceId,
          dayKey: day,
          locationId: locationId ?? null,
          patientId: patientId ?? null,
          insurerId: insurerId ?? null,
          durationMin: dur,
        }
      : null,
    mainKey
  );

  // "any": grilla completa de un profesional a pedido ("Ver horarios").
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => setExpanded(null), [practitionerId, serviceId, day]);
  const expKey = expanded ? slotQueryKey({ practitionerId: expanded, ...base }) : "none";
  const exp = useSlots<PractitionerSlots>(
    practitionerId === "any" && expanded && serviceId
      ? {
          practitionerId: expanded,
          serviceId,
          dayKey: day,
          locationId: locationId ?? null,
          patientId: patientId ?? null,
          insurerId: insurerId ?? null,
          durationMin: dur,
        }
      : null,
    expKey
  );

  return (
    <div
      style={{
        border: "1px solid rgba(15,30,51,0.08)",
        borderRadius: "var(--r-sm)",
        background: "rgba(255,255,255,0.7)",
        padding: 10,
        display: "grid",
        gap: 8,
      }}
    >
      <DayNav day={day} today={today} onGo={goTo} />

      {!serviceId ? (
        <Muted>Elegí una práctica para ver los horarios disponibles.</Muted>
      ) : (
        <>
          <LiveStatus state={main.state} onRetry={main.retry} />
          {main.state.status === "ok" &&
            (main.state.data.mode === "practitioner" ? (
              <PractitionerGrid
                data={main.state.data}
                value={value}
                onPick={onChange}
                insurerAsked={!!insurerId}
              />
            ) : (
              <AnyView
                data={main.state.data}
                today={today}
                labelOf={labelOf}
                value={value}
                insurerAsked={!!insurerId}
                onPick={(iso, pid) => onChange(iso, pid)}
                onUseFirstFree={(iso, pid, dayKey) => {
                  if (dayKey !== day) goTo(dayKey);
                  onChange(iso, pid);
                }}
                expanded={expanded}
                onExpand={(pid) => setExpanded((cur) => (cur === pid ? null : pid))}
                expandedState={exp.state}
                onRetryExpanded={exp.retry}
              />
            ))}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Piezas
// ─────────────────────────────────────────────────────────────────────────────

const navBtn: React.CSSProperties = {
  border: "1px solid rgba(15,30,51,0.1)",
  background: "#fff",
  color: "var(--navy-700)",
  borderRadius: 999,
  minWidth: 30,
  height: 28,
  padding: "0 10px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

function DayNav({ day, today, onGo }: { day: string; today: string; onGo: (d: string) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button type="button" style={navBtn} onClick={() => onGo(shiftDay(day, -1))} aria-label="Día anterior">
        ‹
      </button>
      <button
        type="button"
        style={{ ...navBtn, opacity: day === today ? 0.5 : 1, cursor: day === today ? "default" : "pointer" }}
        onClick={() => onGo(today)}
        disabled={day === today}
      >
        Hoy
      </button>
      <button type="button" style={navBtn} onClick={() => onGo(shiftDay(day, 1))} aria-label="Día siguiente">
        ›
      </button>
      <span
        aria-live="polite"
        style={{ marginLeft: 6, fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}
        title={dayLabelLong(day, today)}
      >
        {dayLabelLong(day, today)}
      </span>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--navy-300)", lineHeight: 1.45 }}>{children}</div>;
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--warn-fg)",
        background: "var(--warn-bg)",
        borderRadius: 8,
        padding: "6px 8px",
        lineHeight: 1.4,
      }}
    >
      {children}
    </div>
  );
}

function LiveStatus({ state, onRetry }: { state: Load<unknown>; onRetry: () => void }) {
  return (
    <div aria-live="polite" role="status">
      {state.status === "loading" && <Muted>Buscando horarios…</Muted>}
      {state.status === "error" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--danger-fg)" }}>
          <span>{state.error}</span>
          <button type="button" style={{ ...navBtn, height: 24, fontSize: 12 }} onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}
    </div>
  );
}

function PractitionerGrid({
  data,
  value,
  onPick,
  insurerAsked,
}: {
  data: PractitionerSlots;
  value: string | null;
  onPick: (iso: string, practitionerId: string) => void;
  insurerAsked: boolean;
}) {
  const summary = summarizeSlots(data.slots);
  const lock = data.dayLockState;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {!data.serviceEnabled && <Warn>No atiende este servicio — habilitalo en Configuración → Profesionales.</Warn>}
      {insurerAsked && !data.acceptsInsurer && <Warn>Este profesional no atiende la cobertura del paciente.</Warn>}
      {data.slots.length === 0 ? (
        <Muted>
          {lock.status === "locked"
            ? `Día bloqueado${lock.detail ? `: ${lock.detail}` : ""}. Podés cargar fuera de grilla con la fecha y hora de abajo.`
            : "Sin horario de atención este día. Podés cargar fuera de grilla con la fecha y hora de abajo."}
        </Muted>
      ) : (
        <>
          {lock.status === "partial" && (
            <Muted>Parte del día está bloqueada{lock.detail ? ` (${lock.detail})` : ""}.</Muted>
          )}
          <ChipGroup
            slots={data.slots}
            value={value}
            onPick={(iso) => onPick(iso, data.practitionerId)}
            label="Horarios del día"
            byHour
          />
          <Muted>
            {summary.free === 0
              ? "No quedan horarios libres este día."
              : `${summary.free} ${summary.free === 1 ? "horario libre" : "horarios libres"}`}
            {data.isFallbackSchedule ? " · horario heredado del consultorio" : ""}
          </Muted>
          <Legend showConflict={summary.conflict > 0} showFull={summary.full > 0} />
        </>
      )}
    </div>
  );
}

function AnyView({
  data,
  today,
  labelOf,
  value,
  insurerAsked,
  onPick,
  onUseFirstFree,
  expanded,
  onExpand,
  expandedState,
  onRetryExpanded,
}: {
  data: AnySlots;
  today: string;
  labelOf: (pid: string) => string;
  value: string | null;
  insurerAsked: boolean;
  onPick: (iso: string, pid: string) => void;
  onUseFirstFree: (iso: string, pid: string, dayKey: string) => void;
  expanded: string | null;
  onExpand: (pid: string) => void;
  expandedState: Load<PractitionerSlots>;
  onRetryExpanded: () => void;
}) {
  const rows = anyRows(data, labelOf);
  const ff = firstFreeView(data, today, labelOf);
  if (rows.length === 0) {
    return (
      <Muted>
        {insurerAsked
          ? "Ningún profesional ofrece esta práctica con la cobertura del paciente."
          : "Ningún profesional tiene habilitada esta práctica."}
      </Muted>
    );
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {ff ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            borderRadius: 8,
            background: "rgba(31,79,190,0.08)",
            fontSize: 12,
            color: "var(--sky-800)",
            fontWeight: 600,
          }}
        >
          <span style={{ flex: 1 }}>{ff.text}</span>
          <button
            type="button"
            style={{ ...navBtn, height: 24, fontSize: 12 }}
            aria-pressed={value === ff.iso}
            onClick={() => onUseFirstFree(ff.iso, ff.practitionerId, ff.dayKey)}
          >
            {value === ff.iso ? "Elegido" : "Usar"}
          </button>
        </div>
      ) : (
        <Muted>Nadie tiene un hueco libre en los próximos días.</Muted>
      )}

      {/* Lista (no radiogroup): cada fila puede abrir su propia grilla, que
          sí es un radiogroup, y los radiogroups no se anidan. */}
      <div style={{ display: "grid", gap: 4 }}>
        {rows.map((r) => {
          return (
            <div key={r.practitionerId} style={{ display: "grid", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--navy-900)", minWidth: 0 }}>
                  {r.label}
                  {r.isFirstFree && (
                    <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: "var(--sky-700)" }}>
                      · primer libre
                    </span>
                  )}
                </span>
                {r.firstSlot ? (
                  <FirstSlotChip slot={r.firstSlot} value={value} onPick={(iso) => onPick(iso, r.practitionerId)} />
                ) : (
                  <span style={{ fontSize: 12, color: "var(--navy-300)" }}>Sin horarios libres</span>
                )}
                <span style={{ fontSize: 11, color: "var(--navy-300)", minWidth: 56, textAlign: "right" }}>
                  {r.availableCount} {r.availableCount === 1 ? "libre" : "libres"}
                </span>
                <button
                  type="button"
                  style={{ ...navBtn, height: 24, fontSize: 12 }}
                  aria-expanded={expanded === r.practitionerId}
                  onClick={() => onExpand(r.practitionerId)}
                >
                  {expanded === r.practitionerId ? "Ocultar" : "Ver horarios"}
                </button>
              </div>
              {expanded === r.practitionerId && (
                <div style={{ paddingLeft: 8, borderLeft: "2px solid var(--sky-200)", display: "grid", gap: 6 }}>
                  <LiveStatus state={expandedState} onRetry={onRetryExpanded} />
                  {expandedState.status === "ok" && (
                    <PractitionerGrid
                      data={expandedState.data}
                      value={value}
                      onPick={onPick}
                      insurerAsked={insurerAsked}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend({ showConflict, showFull }: { showConflict: boolean; showFull: boolean }) {
  if (!showConflict && !showFull) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, color: "var(--navy-500)" }}>
      {showFull && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Swatch tone="full" /> Cupo completo (sobreturno)
        </span>
      )}
      {showConflict && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <Swatch tone="conflict" /> El paciente ya tiene un turno
        </span>
      )}
    </div>
  );
}

function Swatch({ tone }: { tone: ChipTone }) {
  const s = chipStyle(tone, false);
  return <span aria-hidden style={{ width: 12, height: 12, borderRadius: 4, ...s, padding: 0 }} />;
}

function chipStyle(tone: ChipTone, selected: boolean): React.CSSProperties {
  if (selected) {
    return { background: "var(--sky-700)", color: "#fff", border: "1px solid var(--sky-700)" };
  }
  switch (tone) {
    case "free":
      return { background: "#fff", color: "var(--sky-800)", border: "1px solid var(--sky-300)" };
    case "full":
      return { background: "var(--warn-bg)", color: "var(--warn-fg)", border: "1px solid var(--warn-border)" };
    case "conflict":
      // Borde punteado: canal no cromático para "el paciente ya tiene turno".
      return { background: "var(--warn-bg)", color: "var(--warn-fg)", border: "1px dashed var(--warn-fg)" };
    case "blocked":
      return {
        background: "rgba(15,30,51,0.04)",
        color: "var(--navy-200)",
        border: "1px solid transparent",
        textDecoration: "line-through",
      };
  }
}

/** Grilla de chips de un día (un radiogroup), opcionalmente por fila de hora. */
function ChipGroup({
  slots,
  value,
  onPick,
  label,
  byHour,
}: {
  slots: StaffSlot[];
  value: string | null;
  onPick: (iso: string) => void;
  label: string;
  byHour?: boolean;
}) {
  const views = slots.map(chipView);
  const selectable = views.map((v) => v.selectable);
  const selectedIndex = slots.findIndex((s) => s.iso === value);
  const entry = rovingEntry(selectable, selectedIndex);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (selectable[i]) onPick(slots[i].iso);
      return;
    }
    const next = moveRoving(selectable, i, e.key);
    if (next == null) return;
    e.preventDefault();
    refs.current[next]?.focus();
    // Patrón radio: mover con flechas también selecciona.
    onPick(slots[next].iso);
  };

  const chip = (s: StaffSlot, i: number) => {
    const v = views[i];
    const selected = i === selectedIndex;
    const hint = v.hint ?? undefined;
    return (
      <button
        key={s.iso}
        ref={(el) => {
          refs.current[i] = el;
        }}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-disabled={!v.selectable || undefined}
        aria-label={[s.time, v.occupancy ? `ocupación ${v.occupancy}` : null, v.hint].filter(Boolean).join(", ")}
        title={hint}
        tabIndex={i === entry ? 0 : -1}
        onClick={() => v.selectable && onPick(s.iso)}
        onKeyDown={(e) => onKey(e, i)}
        style={{
          ...chipStyle(v.tone, selected),
          borderRadius: 999,
          padding: "4px 9px",
          fontSize: 12,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
          cursor: v.selectable ? "pointer" : "not-allowed",
          display: "inline-flex",
          alignItems: "baseline",
          gap: 4,
        }}
      >
        {s.time}
        {v.occupancy && <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.8 }}>{v.occupancy}</span>}
      </button>
    );
  };

  if (!byHour) {
    return (
      <div role="radiogroup" aria-label={label} style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {slots.map(chip)}
      </div>
    );
  }
  let i = 0;
  return (
    <div role="radiogroup" aria-label={label} style={{ display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
      {groupByHour(slots).map((g) => (
        <div key={g.hour} style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          {g.slots.map((s) => chip(s, i++))}
        </div>
      ))}
    </div>
  );
}

/** Primer hueco de un profesional en el modo "any": botón simple con
 *  `aria-pressed` (siempre elegible: `firstSlot` ya filtra libres sin
 *  conflicto del paciente). */
function FirstSlotChip({ slot, value, onPick }: { slot: StaffSlot; value: string | null; onPick: (iso: string) => void }) {
  const v = chipView(slot);
  const selected = slot.iso === value;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Primer horario libre ${slot.time}${v.occupancy ? `, ocupación ${v.occupancy}` : ""}`}
      title={v.hint ?? undefined}
      onClick={() => v.selectable && onPick(slot.iso)}
      style={{
        ...chipStyle(v.tone, selected),
        borderRadius: 999,
        padding: "4px 9px",
        fontSize: 12,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        cursor: "pointer",
      }}
    >
      {slot.time}
    </button>
  );
}
