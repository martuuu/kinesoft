"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import type { AgendaZoom, SlotCell as SlotCellData } from "@/lib/agenda-layout";
import { NO_ROOM_COLUMN_ID, type RoomColumn, type RoomDayLayout } from "@/lib/agenda-layout-rooms";
import { formatWallTime } from "@/lib/availability/day";
import type { AgendaHighlight } from "@/lib/agenda-highlight";
import { ROOM_KIND_LABEL, roomCapacityText } from "@/lib/rooms-constants";
import { SlotCell, slotStateText, type PractitionerDayBooking } from "../grid/slot-cell";
import { LockIcon } from "../grid/unavailable-overlay";
import { DayColumnsGrid, gridDayLabel } from "./day-columns-grid";
import { blockedRunStarts, columnHighlightCount, columnMinWidth } from "./practitioner-day-view";

/**
 * Vista "Por sala" (SR-U4, plan §17): un día, una COLUMNA por sala de la sede.
 * Responde la pregunta de la Secretaria "¿quién está en qué consultorio y
 * dónde hay lugar?" sin recorrer profesional por profesional.
 *
 * ── Contrato (presentacional y controlado, como `PractitionerDayView`) ────
 * - `layout`: salida de `buildRoomColumns` (`lib/agenda-layout-rooms.ts`). Las
 *   columnas se dibujan en ese orden (el de `rooms` del bootstrap = sede y
 *   `sortOrder`), con "Sin sala" al final si hay turnos sin sala.
 * - `practitionerById`: iniciales y nombre por profesional (lo mismo que la
 *   vista Día recibe como `practitionerById`). Se usan en el header ("Asignada:
 *   AP 9–13 · BF 14–18") y en cada card: en una sala hay varios profesionales,
 *   así que la card dice de quién es. Canal NO cromático (AGENTS §5).
 * - `onSlotClick(roomId, iso)`: click/Enter en el hueco → alta con esa sala y
 *   esa hora. `roomId` = `"none"` en la columna "Sin sala" (alta sin sala).
 *   No se dispara en celdas bloqueadas (la celda queda `aria-disabled`).
 * - `onBookingClick(booking)`, `highlight`, `zoom`, `density`, `now`: igual que
 *   en "Por profesional".
 * - `fallbackLocationName?`: con "Todas las sedes" el caller muestra las salas
 *   de la sede principal; con valor, la vista lo dice arriba.
 * - `canConfigureRooms?` (SRZ B3): quien mira puede cargar salas
 *   (`tenant.admin` o `schedule.configure`). Solo cambia el copy del vacío: a
 *   la Secretaria no se la manda a Configuración, que no puede abrir. Default
 *   false (falla hacia no prometer una pantalla).
 *
 * Celda: `used/cap` = profesionales a la vez en la sala (SR-D1, §17.5). Sin
 * nadie asignado a esa hora la celda es "sin profesional asignado" (gris, como
 * fuera de horario) pero SÍ abre el alta: el modal avisa y el staff decide.
 */
export type RoomDayViewProps<B extends PractitionerDayBooking = PractitionerDayBooking> = {
  dayKey: string;
  layout: RoomDayLayout<B>;
  zoom: AgendaZoom;
  density: "comfortable" | "compact";
  now: Date;
  onSlotClick: (roomId: string, iso: string) => void;
  onBookingClick: (booking: B) => void;
  highlight?: AgendaHighlight | null;
  practitionerById: Readonly<Record<string, { initials: string; name: string }>>;
  fallbackLocationName?: string | null;
  canConfigureRooms?: boolean;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Estado de una celda de sala para lectores de pantalla. Cambia respecto de
 * `slotStateText` lo que en la sala significa otra cosa: "fuera de horario" =
 * nadie tiene la sala asignada, y el cupo son profesionales, no pacientes.
 */
export function roomSlotStateText(
  cell: Pick<SlotCellData, "state" | "used" | "cap" | "blockReason" | "overbooked" | "total">
): string {
  const pros = (n: number) => (n === 1 ? "profesional" : "profesionales");
  switch (cell.state) {
    case "fuera-de-horario":
      return cell.total > 0
        ? `sin profesional asignado, ${plural(cell.total, "turno", "turnos")}`
        : "sin profesional asignado";
    case "sobreturno":
      return `con más profesionales que lugares, ${cell.used} de ${cell.cap}`;
    case "lleno":
      return `lleno, ${cell.used} de ${cell.cap} ${pros(cell.cap ?? 0)}`;
    case "parcial":
      return cell.cap == null
        ? plural(cell.total, "turno", "turnos")
        : `${cell.used} de ${cell.cap} ${pros(cell.cap)} a la vez`;
    default:
      return slotStateText(cell);
  }
}

/**
 * Chip de bloqueo del header de una sala: todas las filas bloqueadas →
 * "Bloqueado"; alguna → "Parcial"; ninguna → null (sin chip). No usa
 * `columnDayStatus` porque en una sala "fuera de horario" es "sin asignar", no
 * "no atiende": una sala sin asignar y bloqueada entera igual está bloqueada.
 */
export function roomBlockStatus(
  column: Pick<RoomColumn, "slots">
): { status: "locked" | "partial"; label: string; detail: string | null } | null {
  const blocked = column.slots.filter((s) => s.blocked);
  if (blocked.length === 0) return null;
  const detail = blocked.find((s) => s.blockReason)?.blockReason ?? null;
  return blocked.length === column.slots.length
    ? { status: "locked", label: "Bloqueado", detail }
    : { status: "partial", label: "Parcial", detail };
}

/** "9–13" / "9:30–13" (minutos de pared AR). */
function shortHour(min: number): string {
  const t = formatWallTime(min);
  return t.endsWith(":00") ? String(Number(t.slice(0, 2))) : t.replace(/^0/, "");
}

/** "Asignada: AP 9–13 · BF 14–18" / "Sin asignar". */
export function roomAssignmentText(
  assignments: RoomColumn["assignments"],
  practitionerById: RoomDayViewProps["practitionerById"]
): string {
  if (assignments.length === 0) return "Sin asignar";
  const parts = assignments.map(
    (a) => `${practitionerById[a.practitionerId]?.initials ?? "?"} ${shortHour(a.startMin)}–${shortHour(a.endMin)}`
  );
  return `Asignada: ${parts.join(" · ")}`;
}

export function RoomDayView<B extends PractitionerDayBooking>({
  dayKey,
  layout,
  zoom,
  density,
  now,
  onSlotClick,
  onBookingClick,
  highlight = null,
  practitionerById,
  fallbackLocationName = null,
  canConfigureRooms = false,
}: RoomDayViewProps<B>) {
  const { rows, columns } = layout;
  const runStarts = useMemo(() => columns.map((c) => blockedRunStarts(c)), [columns]);
  const practitionerOf = useMemo(
    () => (b: B) => practitionerById[b.practitionerId] ?? null,
    [practitionerById]
  );

  if (columns.length === 0) {
    return (
      <Card style={{ padding: 24, height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)", textAlign: "center" }}>
          {canConfigureRooms
            ? "Esta sede no tiene salas. Cargalas en Configuración › Sedes."
            : "Esta sede no tiene salas. Pedile a quien administra el consultorio que las cargue."}
        </p>
      </Card>
    );
  }

  const grid = (
    <DayColumnsGrid<RoomColumn<B>>
      dayKey={dayKey}
      rows={rows}
      window={layout.window}
      columns={columns}
      columnKey={(col) => col.roomId}
      columnMinWidth={columnMinWidth(density)}
      zoom={zoom}
      density={density}
      now={now}
      ariaLabel={`Agenda del ${gridDayLabel(dayKey)} por sala`}
      renderHeader={(col, c) => (
        <RoomHeader
          column={col}
          colIndex={c}
          density={density}
          assignmentText={col.roomId === NO_ROOM_COLUMN_ID ? null : roomAssignmentText(col.assignments, practitionerById)}
          highlightCount={columnHighlightCount(col, highlight)}
        />
      )}
      renderCell={(col, r, c, nav) => {
        const none = col.roomId === NO_ROOM_COLUMN_ID;
        return (
          <SlotCell<B>
            cell={col.slots[r]}
            dayKey={dayKey}
            columnId={col.roomId}
            columnLabel={col.name}
            columnKind="room"
            createAriaLabel={(time, state) =>
              none ? `Nuevo turno sin sala a las ${time} (${state})` : `Nuevo turno en ${col.name} a las ${time} (${state})`
            }
            stateTextOf={roomSlotStateText}
            practitionerOf={practitionerOf}
            rowIndex={r}
            colIndex={c}
            tabbable={nav.tabbable}
            rowMin={nav.rowMin}
            density={density}
            showBlockLabel={runStarts[c].has(r)}
            highlight={highlight}
            onSlotClick={onSlotClick}
            onBookingClick={onBookingClick}
            onFocusCell={nav.onFocusCell}
            onGridKeyDown={nav.onGridKeyDown}
          />
        );
      }}
    />
  );

  if (!fallbackLocationName) return grid;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>
        Mostrando las salas de {fallbackLocationName}. Elegí otra sede arriba.
      </p>
      <div style={{ flex: 1, minHeight: 0 }}>{grid}</div>
    </div>
  );
}

function RoomHeader<B extends PractitionerDayBooking>({
  column,
  colIndex,
  density,
  assignmentText,
  highlightCount,
}: {
  column: RoomColumn<B>;
  colIndex: number;
  density: "comfortable" | "compact";
  /** null en "Sin sala". */
  assignmentText: string | null;
  highlightCount: number | null;
}) {
  const compact = density === "compact";
  const none = column.roomId === NO_ROOM_COLUMN_ID;
  const count = column.bookingCount;
  // Bloqueo de sala: solo lectura acá (el candado del día es del profesional).
  const status = none ? null : roomBlockStatus(column);
  const showLock = status != null;
  const statusTitle = status?.detail ? `${status.label} · ${status.detail}` : status?.label;
  const muted = { fontSize: 10.5, color: "var(--navy-300)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

  return (
    <div
      role="columnheader"
      aria-colindex={colIndex + 2}
      data-room={column.roomId}
      style={{
        minWidth: 0,
        padding: compact ? "6px 8px" : "8px 10px",
        borderLeft: "1px solid rgba(15,30,51,0.06)",
      }}
    >
      <div
        title={column.name}
        style={{
          fontSize: compact ? 12 : 13,
          fontWeight: 700,
          color: "var(--navy-900)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {column.name}
      </div>
      {none ? (
        <div style={muted}>Turnos sin sala asignada</div>
      ) : (
        <>
          <div style={muted} title={column.capacity != null ? roomCapacityText(column.capacity) : undefined}>
            {column.kind ? ROOM_KIND_LABEL[column.kind] : ""} · hasta {column.capacity}
          </div>
          <div
            data-assignments
            title={assignmentText ?? undefined}
            style={{ ...muted, color: column.assignments.length > 0 ? "var(--navy-500)" : "var(--navy-300)" }}
          >
            {assignmentText}
          </div>
        </>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
        <span className="k-mono" data-count={count} style={{ fontSize: 10.5, color: "var(--navy-500)" }}>
          {plural(count, "turno", "turnos")}
        </span>
        {highlightCount != null && (
          <span
            className="k-mono"
            data-highlight-count={highlightCount}
            style={{ fontSize: 10.5, fontWeight: 700, color: highlightCount > 0 ? "var(--navy-900)" : "var(--navy-300)" }}
          >
            · {plural(highlightCount, "resaltado", "resaltados")}
          </span>
        )}
        {showLock && status && (
          <span
            role="img"
            title={statusTitle}
            aria-label={`Sala: ${statusTitle}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10.5,
              fontWeight: 600,
              borderRadius: 999,
              padding: "1px 7px",
              whiteSpace: "nowrap",
              color: "var(--navy-700)",
              background: "rgba(15,30,51,0.05)",
              border: "1px dashed rgba(15,30,51,0.3)",
            }}
          >
            <LockIcon locked={status.status === "locked"} partial={status.status === "partial"} size={11} />
            <span>{status.label}</span>
          </span>
        )}
      </div>
    </div>
  );
}
