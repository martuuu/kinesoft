"use client";

import { nextRadioValue, ROOM_FILTER_NONE } from "@/lib/agenda-client-state";
import { NO_ROOM_LABEL } from "@/lib/rooms-constants";
import type { RoomOption } from "@/lib/rooms-types";

/**
 * Filtro de sala de la agenda (SR-U3, decisiones D2/D3 del relevamiento).
 * Presentacional y controlado: `value` = `agendaPrefs.roomId` ya pasado por
 * `effectiveRoomFilter` (null = todas, "none" = Sin sala) y `onChange` lo
 * persiste el caller (`updateAgendaViewPrefs({ roomId })`).
 *
 * Selección ÚNICA (D3): por eso es un radiogroup y no los chips multi-select
 * de profesionales. Con menos de 2 salas no se dibuja: filtrar por la única
 * sala no saca nada útil, y un consultorio sin salas ve la agenda igual que
 * hoy. `rooms` son las del alcance (`roomsInScope`), en el orden del catálogo.
 *
 * Canal no cromático (AGENTS §5): la sala es texto; el activo usa el mismo
 * navy que los chips de profesionales, sin color nuevo. Envuelve en mobile
 * (flex-wrap) para no meter scroll horizontal a 360 px.
 *
 * `counts` (opcional) = `countByRoom(applyAgendaFilters(..., { except: ["roomId"] }))`:
 * turnos por sala con los demás filtros puestos; la clave "none" es Sin sala.
 * `total` (opcional) = los no cancelados de esa misma base: es el número de
 * "Todas las salas" (SRZ B1). No sale de sumar las opciones porque con "Todas
 * las sedes" hay turnos en salas de otra sede (o de una sala archivada) que
 * no tienen opción propia y sí están en pantalla. Sin `total`, la suma.
 */
const ALL = "all";

export function RoomFilter({
  rooms,
  value,
  onChange,
  counts,
  total,
}: {
  rooms: ReadonlyArray<RoomOption>;
  value: string | null;
  onChange: (roomId: string | null) => void;
  counts?: Readonly<Record<string, number>>;
  total?: number;
}) {
  if (rooms.length < 2) return null;

  const options: { key: string; label: string; count: number | null }[] = [
    { key: ALL, label: "Todas las salas", count: null },
    ...rooms.map((r) => ({ key: r.id, label: r.name, count: counts ? counts[r.id] ?? 0 : null })),
    { key: ROOM_FILTER_NONE, label: NO_ROOM_LABEL, count: counts ? counts[ROOM_FILTER_NONE] ?? 0 : null },
  ];
  if (counts) options[0].count = total ?? options.slice(1).reduce((n, o) => n + (o.count ?? 0), 0);

  const keys = options.map((o) => o.key);
  // Un valor que no está en la lista (sala ajena/archivada) se ve como "Todas".
  const current = value && keys.includes(value) ? value : ALL;
  const select = (key: string) => onChange(key === ALL ? null : key);

  return (
    <div
      role="radiogroup"
      aria-label="Filtrar por sala"
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}
    >
      {options.map((o) => {
        const on = o.key === current;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            aria-label={o.count == null ? undefined : `${o.label}, ${o.count} ${o.count === 1 ? "turno" : "turnos"}`}
            data-room={o.key}
            title={o.label}
            onClick={() => select(o.key)}
            onKeyDown={(e) => {
              const next = nextRadioValue(keys, current, e.key);
              if (!next) return;
              e.preventDefault();
              if (next !== current) select(next);
              const group = e.currentTarget.parentElement;
              requestAnimationFrame(() => group?.querySelector<HTMLElement>(`[data-room="${CSS.escape(next)}"]`)?.focus());
            }}
            style={chipStyle(on)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>
              {o.label}
            </span>
            {o.count != null && <Count n={o.count} active={on} />}
          </button>
        );
      })}
    </div>
  );
}

function Count({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className="k-mono"
      aria-hidden
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        minWidth: 18,
        textAlign: "center",
        borderRadius: 999,
        padding: "0 5px",
        background: active ? "rgba(255,255,255,0.18)" : "rgba(15,30,51,0.06)",
        color: active ? "#fff" : "var(--navy-500)",
      }}
    >
      {n}
    </span>
  );
}

/** Mismo look que los chips de profesionales (`practitioner-chips.tsx`). */
function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    padding: "0 12px",
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 600,
    border: `1px solid ${active ? "var(--navy-900)" : "rgba(15,30,51,0.12)"}`,
    background: active ? "var(--navy-900)" : "rgba(255,255,255,0.7)",
    color: active ? "#fff" : "var(--navy-700)",
    cursor: "pointer",
    maxWidth: "100%",
  };
}
