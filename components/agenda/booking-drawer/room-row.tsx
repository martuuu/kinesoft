"use client";

/**
 * SR-U5b · fila "Sala" del drawer del turno: muestra la sala (o "Sin sala") y,
 * para quien opera el turno (`canOperate`, también la Secretaria con
 * `agenda.operateAll`: la sala es un dato operativo, no clínico), "Cambiar"
 * despliega un select con las salas activas DE LA SEDE DEL TURNO + "Sin sala".
 *
 * La sede no se cambia desde acá (D9): elegir una sala de otra sede rebotaría
 * en el server (`bad-room`, SR2a), así que el select ni la ofrece.
 *
 * Sin salas en la sede y sin sala en el turno, la fila no existe: el drawer
 * queda idéntico al de antes de SR (los render tests viejos lo afirman).
 *
 * Controlada: el borrador vive en `index.tsx` para que cuente en el
 * dirty-guard del Drawer y se resetee al abrir otro turno. Acá no se llama al
 * server; la decisión de qué hacer con la respuesta es `roomChangeOutcome`
 * (pura, testeada sin montar nada).
 */
import { useEffect, useRef } from "react";
import { NO_ROOM_LABEL } from "@/lib/rooms-constants";
import type { RoomOption } from "@/lib/rooms-types";
import {
  forcePromptConfirm,
  nextForcePrompt,
  withForce,
  type ForceableResult,
  type ForceFlags,
  type ForcePrompt,
} from "@/lib/booking-force-flags";
import { Row } from "./billing-rows";
import { miniGhostBtn } from "./styles";
import type { DrawerBooking } from "./types";

/** Valor del `<select>` para "Sin sala" (un `<option>` no puede valer null). */
export const NO_ROOM_VALUE = "";

/**
 * Sala de un turno que ya no está en el catálogo del bootstrap (que trae solo
 * salas activas de sedes activas): archivada. Mejor decirlo que mostrar un id o
 * hacerla pasar por "Sin sala" (que sería mentir: el turno sí tiene sala).
 */
// Una sola fuente del copy (FX2a): la agenda y el drawer dicen lo mismo.
export { ARCHIVED_ROOM_LABEL } from "../agenda-utils";
import { ARCHIVED_ROOM_LABEL } from "../agenda-utils";

export type DrawerRoomModel = {
  /** Fila visible: la sede del turno tiene salas o el turno ya tiene una. */
  visible: boolean;
  /** Sala actual (`null` = sin sala). */
  currentId: string | null;
  /** Texto de la fila: nombre, "Sin sala" o "Sala archivada". */
  label: string;
  /** Salas elegibles: activas de la sede del turno, en el orden del catálogo. */
  options: RoomOption[];
};

/**
 * Qué muestra la fila. La sede efectiva del turno es, en orden:
 *   1. `booking.locationId` (explícito; con sala siempre lo es, SR-D6);
 *   2. la sede de su sala (si la sala está en el catálogo);
 *   3. la sede principal (`locationId` null = principal en todo el server).
 * Sin poder resolverla (sin `primaryLocationId` y sin sede en el turno) no se
 * ofrece ninguna sala: adivinar la sede llevaría a un `bad-room`.
 */
export function drawerRoomModel(
  booking: Pick<DrawerBooking, "locationId" | "roomId">,
  rooms: readonly RoomOption[] | null | undefined,
  primaryLocationId: string | null | undefined
): DrawerRoomModel {
  const catalog = rooms ?? [];
  const currentId = typeof booking.roomId === "string" ? booking.roomId : null;
  const current = currentId ? catalog.find((r) => r.id === currentId) ?? null : null;
  const locationId = booking.locationId ?? current?.locationId ?? primaryLocationId ?? null;
  const options = locationId ? catalog.filter((r) => r.locationId === locationId) : [];
  return {
    visible: options.length > 0 || currentId !== null,
    currentId,
    label: currentId ? current?.name ?? ARCHIVED_ROOM_LABEL : NO_ROOM_LABEL,
    options,
  };
}

/** Lo que vuelve `updateBooking` en lo que a la fila le importa. */
export type RoomChangeResult = ({ ok: true } | { ok: false; error: string }) & ForceableResult;

export type RoomChangeOutcome =
  | { kind: "ok" }
  | {
      kind: "confirm";
      prompt: ForcePrompt;
      /** Flags del reintento si el usuario acepta (acumulados, como el resto del drawer). */
      next: ForceFlags;
      options: { title: string; message: string; confirmLabel: string; cancelLabel: string };
    }
  | { kind: "error"; error: string };

/**
 * Traduce la respuesta de `updateBooking({ id, roomId, … })`:
 *   - ok → "Sala cambiada";
 *   - `roomBusy` (sala llena de otros profesionales o bloqueada, §17.5) →
 *     `useConfirm` "Consultorio 2 está ocupado a esa hora. ¿Lo asignás igual?"
 *     [Asignar igual] [Elegir otra], y el reintento lleva `allowRoomConflict`
 *     (SR-D2: NO es sobreturno, no marca `isOverbooked`);
 *   - cualquier otro aviso forzable (no debería venir: cambiar la sala no mueve
 *     el horario) usa el mismo confirm genérico; un aviso ya forzado que vuelve
 *     es error real (`nextForcePrompt` no re-pregunta: sin loop);
 *   - el resto → error con el copy del server.
 */
export function roomChangeOutcome(r: RoomChangeResult, sent: ForceFlags = {}): RoomChangeOutcome {
  if (r.ok) return { kind: "ok" };
  const prompt = nextForcePrompt(r, sent);
  if (!prompt) return { kind: "error", error: r.error };
  const base = forcePromptConfirm(prompt, "assignRoom");
  return {
    kind: "confirm",
    prompt,
    next: withForce(sent, prompt),
    options: {
      title: base.title,
      message: prompt.kind === "roomBusy" ? "¿Lo asignás igual?" : base.message,
      confirmLabel: base.confirmLabel,
      cancelLabel: "Elegir otra",
    },
  };
}

/**
 * Payload de `updateBooking` para cambiar la sala: SOLO `roomId` + los flags
 * aceptados + el lock optimista. Sin horario ni sede el server no recalcula la
 * sala por defecto (SR2a) y nada más del turno se pisa.
 */
export function roomUpdatePayload(
  booking: Pick<DrawerBooking, "id" | "updatedAt">,
  roomId: string | null,
  force: ForceFlags = {}
): { id: string; roomId: string | null; expectedUpdatedAt: string } & ForceFlags {
  return { id: booking.id, roomId, ...force, expectedUpdatedAt: booking.updatedAt };
}

/** Borrador del select → valor del payload (`""` = "Sin sala" = null). */
export function roomDraftToId(draft: string): string | null {
  return draft === NO_ROOM_VALUE ? null : draft;
}

/**
 * B2 (revisión b de SR): "Cambiar" se desmonta al abrir el form y el form se
 * desmonta al Cancelar/Guardar, así que el foco caía al `body` del Drawer y el
 * lector de pantalla/teclado perdía el lugar. Al pasar de editando a cerrado
 * se le devuelve a "Cambiar". Solo en esa transición: al montar el drawer o al
 * abrir el form (donde manda el `autoFocus` del select) no se mueve nada.
 */
export function shouldReturnRoomFocus(wasEditing: boolean, editing: boolean): boolean {
  return wasEditing && !editing;
}

export function RoomRow({
  model,
  canOperate,
  cancelled,
  pending,
  editing,
  draft,
  onOpen,
  onCancel,
  onDraftChange,
  onSubmit,
}: {
  model: DrawerRoomModel;
  canOperate: boolean;
  /** Turno cancelado: "Cambiar" deshabilitado, igual que Reprogramar / Editar. */
  cancelled: boolean;
  pending: boolean;
  editing: boolean;
  /** Valor del select (`NO_ROOM_VALUE` = "Sin sala"). */
  draft: string;
  onOpen: () => void;
  onCancel: () => void;
  onDraftChange: (value: string) => void;
  onSubmit: (roomId: string | null) => void;
}) {
  const changeRef = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (shouldReturnRoomFocus(wasEditing.current, editing)) changeRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  if (!model.visible) return null;
  const currentValue = model.currentId ?? NO_ROOM_VALUE;
  // La sala actual archivada no está entre las opciones: va igual en el select
  // (si no, el `<select>` mostraría otra cosa como elegida).
  const archivedCurrent =
    model.currentId !== null && !model.options.some((r) => r.id === model.currentId) ? model.currentId : null;
  return (
    <Row label="Sala">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span>{model.label}</span>
        {canOperate && !editing && (
          <button
            ref={changeRef}
            type="button"
            onClick={onOpen}
            disabled={pending || cancelled}
            aria-label="Cambiar la sala"
            title={cancelled ? "El turno está cancelado" : "Elegir otra sala de esta sede"}
            style={{ ...miniGhostBtn, padding: "2px 10px" }}
          >
            Cambiar
          </button>
        )}
      </div>
      {canOperate && editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft !== currentValue) onSubmit(roomDraftToId(draft));
          }}
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}
        >
          <select
            aria-label="Sala del turno"
            // B2: el form reemplaza a "Cambiar"; sin esto el foco quedaba en el body.
            autoFocus
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            disabled={pending}
            style={{
              flex: "1 1 160px",
              minWidth: 0,
              maxWidth: "100%",
              padding: "6px 8px",
              borderRadius: 10,
              border: "1px solid rgba(15,30,51,0.15)",
              background: "#fff",
              fontSize: 12.5,
              color: "var(--navy-900)",
            }}
          >
            <option value={NO_ROOM_VALUE}>{NO_ROOM_LABEL}</option>
            {archivedCurrent && <option value={archivedCurrent}>{ARCHIVED_ROOM_LABEL}</option>}
            {model.options.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button type="submit" disabled={pending || draft === currentValue} style={miniGhostBtn}>
            Guardar
          </button>
          <button type="button" onClick={onCancel} disabled={pending} style={miniGhostBtn}>
            Cancelar
          </button>
        </form>
      )}
    </Row>
  );
}
