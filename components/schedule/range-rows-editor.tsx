"use client";

/**
 * Filas de franjas horarias de un día (B3.4 CFG-UI-1; SR-U2 sumó sala y vigencia). Lo usan la semana del profesional
 * y las excepciones de Configuración → Profesionales, y el paso «Tu horario» del alta.
 *
 * VX2-e: extraído de `components/configuracion/panels/practitioners/schedule-editor.tsx`, que lo re-exporta (los
 * imports viejos siguen andando). Antes el alta importaba este editor desde ese archivo y el bundle de /onboarding
 * arrastraba la semana completa de Configuración (`ScheduleEditor`, `WeekDrawer`, el Drawer, el chequeo de
 * conflictos): era lo que lo dejaba arriba de su presupuesto (C-F6, 160 kB). Este módulo no importa Drawer, toast,
 * confirm ni server actions.
 */
import { useState } from "react";
import { IconPlus, IconX } from "@/components/ui/icons";
import type { LocationRow } from "@/lib/locations-schemas";
import { formatHHMM, MAX_RANGES_PER_DAY } from "@/lib/schedule-validate";
import { NO_ROOM_LABEL } from "@/lib/rooms-constants";
import {
  nextRange,
  roomLabel,
  roomsForLocation,
  timeOptions,
  validityLabel,
  withLocation,
  type DraftRange,
  type RoomCatalogEntry,
} from "@/lib/schedule-editor-state";
import { useTenantModules } from "@/components/layout/tenant-modules-context";

/** PL-2f: sin el módulo `salas` no hay selector de sala (porqué en schedule-editor.tsx, `ROOMS_UPSELL`). */
const NO_ROOM_SELECT = { show: false, options: [] } as const;


// ─────────────────────────────────────────────────────────────────────────────
// Estilos compartidos con exceptions-editor
// ─────────────────────────────────────────────────────────────────────────────

export const selectStyle: React.CSSProperties = {
  padding: "8px 10px",
  minHeight: 38,
  borderRadius: 10,
  background: "rgba(255,255,255,0.96)",
  border: "1px solid rgba(15,30,51,0.12)",
  fontSize: 14,
  color: "var(--navy-900)",
  minWidth: 0,
};

export const linkBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--sky-700)",
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 700,
  padding: "6px 4px",
  minHeight: 32,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

export const infoBox: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "var(--sky-50)",
  border: "1px solid var(--sky-100)",
  color: "var(--navy-700)",
  fontSize: 12.5,
};

const START_OPTS = timeOptions("start");
const END_OPTS = timeOptions("end");

function withValue(opts: Array<{ value: number; label: string }>, v: number) {
  // Un valor guardado fuera de la grilla de 5 (no debería existir) igual se
  // muestra: si no, el select mostraría otra hora que la real.
  return opts.some((o) => o.value === v) ? opts : [...opts, { value: v, label: formatHHMM(v) }].sort((a, b) => a.value - b.value);
}

export function locationName(locations: ReadonlyArray<LocationRow>, id: string): string {
  const l = locations.find((x) => x.id === id);
  if (!l) return "Sede desconocida";
  return l.active ? l.name : `${l.name} (archivada)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filas de franjas (un día). Lo reusa el editor de excepciones.
// ─────────────────────────────────────────────────────────────────────────────

/** Copy de Horarios (SR-U2, literal del relevamiento de UI). */
export const SCHEDULE_ROOM_COPY = {
  room: "Sala",
  always: "Siempre",
  onlyPeriod: "Solo por un período",
  change: "Cambiar",
  backToAlways: "Volver a siempre",
  from: "Desde",
  until: "Hasta (opcional)",
  help: "Para un reemplazo o un cambio de consultorio por unas semanas.",
} as const;

export function RangeRowsEditor({
  rows,
  onChange,
  errors,
  locations,
  showLocation,
  defaults,
  disabled,
  dayLabel,
  rooms,
  showValidity = false,
}: {
  rows: DraftRange[];
  onChange: (rows: DraftRange[]) => void;
  errors: Record<string, string>;
  /** Todas las sedes (las archivadas solo para rotular una franja vieja). */
  locations: ReadonlyArray<LocationRow>;
  showLocation: boolean;
  defaults: { startMin: number; endMin: number; locationId: string };
  disabled?: boolean;
  dayLabel: string;
  /** SR-U2: catálogo de salas (archivadas incluidas). Sin salas en la sede de la fila, no hay select. */
  rooms?: ReadonlyArray<RoomCatalogEntry>;
  /**
   * SR-U2: vigencia por franja (solo la semana; una excepción ya es un día).
   * SRZ-FX3 (M3): la semana lo pasa solo con salas; una franja que YA tiene
   * vigencia la muestra igual (nunca se esconde un dato cargado).
   */
  showValidity?: boolean;
}) {
  const roomsOn = useTenantModules().has("salas");
  const active = locations.filter((l) => l.active);
  const canAdd = !disabled && nextRange(rows, defaults) !== null;
  // Vigencia plegada: se abre a pedido ("Solo por un período" / "Cambiar").
  const [openValidity, setOpenValidity] = useState<ReadonlySet<string>>(() => new Set());
  const toggleValidity = (key: string, open: boolean) =>
    setOpenValidity((s) => {
      const n = new Set(s);
      if (open) n.add(key);
      else n.delete(key);
      return n;
    });
  const patch = (key: string, p: Partial<DraftRange>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((r, i) => {
        const err = errors[r.key];
        const locOpts = active.some((l) => l.id === r.locationId)
          ? active
          : [...active, ...locations.filter((l) => l.id === r.locationId)];
        const roomSel = roomsOn ? roomsForLocation(rooms, r.locationId, r.roomId) : NO_ROOM_SELECT;
        const validityOpen = openValidity.has(r.key);
        const hasValidity = !!(r.validFrom || r.validUntil);
        return (
          <div key={r.key} data-range-row={r.key}>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                alignItems: "center",
                padding: 6,
                borderRadius: 10,
                background: err ? "rgba(228,70,70,0.06)" : undefined,
                border: err ? "1px solid rgba(225,75,75,0.35)" : "1px solid transparent",
              }}
            >
              <select
                aria-label={`${dayLabel}, franja ${i + 1}: desde`}
                value={r.startMin}
                disabled={disabled}
                onChange={(e) => patch(r.key, { startMin: Number(e.target.value) })}
                style={selectStyle}
              >
                {withValue(START_OPTS, r.startMin).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: "var(--navy-300)" }}>a</span>
              <select
                aria-label={`${dayLabel}, franja ${i + 1}: hasta`}
                value={r.endMin}
                disabled={disabled}
                onChange={(e) => patch(r.key, { endMin: Number(e.target.value) })}
                style={selectStyle}
              >
                {withValue(END_OPTS, r.endMin).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {showLocation && (
                <select
                  aria-label={`${dayLabel}, franja ${i + 1}: sede`}
                  value={r.locationId}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange(rows.map((x) => (x.key === r.key ? withLocation(x, e.target.value, rooms) : x)))
                  }
                  style={{ ...selectStyle, flex: "1 1 140px", maxWidth: 260 }}
                >
                  {!r.locationId && <option value="">Elegí la sede</option>}
                  {locOpts.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.active ? l.name : `${l.name} (archivada)`}
                    </option>
                  ))}
                </select>
              )}
              {roomSel.show && (
                <select
                  aria-label={`${dayLabel}, franja ${i + 1}: sala`}
                  value={r.roomId ?? ""}
                  disabled={disabled}
                  onChange={(e) => patch(r.key, { roomId: e.target.value || null })}
                  style={{ ...selectStyle, flex: "1 1 140px", maxWidth: 220 }}
                >
                  <option value="">{NO_ROOM_LABEL}</option>
                  {roomSel.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {roomLabel(rooms, o.id)}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                aria-label={`Quitar franja ${i + 1} de ${dayLabel}`}
                title="Quitar franja"
                disabled={disabled}
                onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
                style={{
                  ...linkBtn,
                  color: "var(--navy-300)",
                  width: 34,
                  height: 34,
                  justifyContent: "center",
                  borderRadius: 999,
                }}
              >
                <IconX size={14} />
              </button>
            </div>
            {(showValidity || hasValidity) && (
              <ValidityEditor
                row={r}
                index={i}
                dayLabel={dayLabel}
                open={validityOpen}
                hasValidity={hasValidity}
                disabled={disabled}
                onOpen={(o) => toggleValidity(r.key, o)}
                onPatch={(p) => patch(r.key, p)}
              />
            )}
            {err && (
              <div role="alert" style={{ fontSize: 12, color: "var(--danger-fg)", padding: "2px 8px 0" }}>
                {err}
              </div>
            )}
          </div>
        );
      })}
      <div>
        <button
          type="button"
          style={{ ...linkBtn, opacity: canAdd ? 1 : 0.45, cursor: canAdd ? "pointer" : "not-allowed" }}
          disabled={!canAdd}
          onClick={() => {
            const n = nextRange(rows, defaults);
            if (n) onChange([...rows, n]);
          }}
          title={
            rows.length >= MAX_RANGES_PER_DAY
              ? `Máximo ${MAX_RANGES_PER_DAY} franjas por día`
              : undefined
          }
        >
          <IconPlus size={12} /> Agregar franja
        </button>
      </div>
    </div>
  );
}

/**
 * Vigencia de una franja, plegada: "Siempre · Solo por un período" o
 * "Del 01/11 al 30/11 · Cambiar". Abierta: "Desde" / "Hasta (opcional)" con
 * `<input type="date">` (da "YYYY-MM-DD" = DayKey tal cual, la excepción de
 * TZ permitida). Vacío = abierta en ese extremo.
 */
function ValidityEditor({
  row,
  index,
  dayLabel,
  open,
  hasValidity,
  disabled,
  onOpen,
  onPatch,
}: {
  row: DraftRange;
  index: number;
  dayLabel: string;
  open: boolean;
  hasValidity: boolean;
  disabled?: boolean;
  onOpen: (open: boolean) => void;
  onPatch: (p: Partial<DraftRange>) => void;
}) {
  const label = `${dayLabel}, franja ${index + 1}`;
  if (!open) {
    return (
      <div
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, padding: "0 8px", fontSize: 12 }}
      >
        <span style={{ color: hasValidity ? "var(--navy-700)" : "var(--navy-300)", fontWeight: hasValidity ? 600 : 400 }}>
          {validityLabel(row.validFrom, row.validUntil)}
        </span>
        <span aria-hidden style={{ color: "var(--navy-300)" }}>·</span>
        <button
          type="button"
          style={{ ...linkBtn, minHeight: 28, padding: "2px 4px", fontSize: 12 }}
          disabled={disabled}
          aria-label={`${label}: ${hasValidity ? "cambiar el período" : SCHEDULE_ROOM_COPY.onlyPeriod.toLowerCase()}`}
          onClick={() => onOpen(true)}
        >
          {hasValidity ? SCHEDULE_ROOM_COPY.change : SCHEDULE_ROOM_COPY.onlyPeriod}
        </button>
      </div>
    );
  }
  const dateStyle: React.CSSProperties = { ...selectStyle, width: "100%", minWidth: 0, boxSizing: "border-box" };
  return (
    <div
      style={{
        margin: "2px 6px 4px",
        padding: 8,
        borderRadius: 10,
        background: "rgba(15,30,51,0.04)",
        display: "grid",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <label style={{ display: "grid", gap: 2, flex: "1 1 130px", minWidth: 0, fontSize: 12, color: "var(--navy-500)" }}>
          {SCHEDULE_ROOM_COPY.from}
          <input
            type="date"
            aria-label={`${label}: desde la fecha`}
            value={row.validFrom ?? ""}
            disabled={disabled}
            onChange={(e) => onPatch({ validFrom: e.target.value || null })}
            style={dateStyle}
          />
        </label>
        <label style={{ display: "grid", gap: 2, flex: "1 1 130px", minWidth: 0, fontSize: 12, color: "var(--navy-500)" }}>
          {SCHEDULE_ROOM_COPY.until}
          <input
            type="date"
            aria-label={`${label}: hasta la fecha`}
            value={row.validUntil ?? ""}
            min={row.validFrom ?? undefined}
            disabled={disabled}
            onChange={(e) => onPatch({ validUntil: e.target.value || null })}
            style={dateStyle}
          />
        </label>
      </div>
      <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{SCHEDULE_ROOM_COPY.help}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {hasValidity && (
          <button
            type="button"
            style={{ ...linkBtn, minHeight: 28, padding: "2px 4px", fontSize: 12 }}
            disabled={disabled}
            onClick={() => {
              onPatch({ validFrom: null, validUntil: null });
              onOpen(false);
            }}
          >
            {SCHEDULE_ROOM_COPY.backToAlways}
          </button>
        )}
        <button
          type="button"
          style={{ ...linkBtn, minHeight: 28, padding: "2px 4px", fontSize: 12 }}
          onClick={() => onOpen(false)}
        >
          Listo
        </button>
      </div>
    </div>
  );
}
