"use client";

import { useMemo } from "react";
import type { ReceptionAction } from "@/lib/reception-state";
import type { SalaColumn as SalaColumnModel, SalaEntry, SalaPractitioner, SalaRoom } from "@/lib/sala-board-state";
import type { SalaGroupBy } from "@/lib/preferences-constants";
import { SalaColumn } from "./sala-column";

// El CSS vive en un módulo sin "use client" (lo usa también `loading.tsx`, que
// es server component). Se re-exporta por compatibilidad con los imports viejos.
export { SALA_CSS } from "./sala-css";

/**
 * Tablero de columnas de /sala (SV10a). Presentacional: recibe las columnas ya
 * armadas (`buildBoard`) y el estado de animación del cliente. En desktop las
 * columnas (mín. 260 px) scrollean en horizontal dentro del tablero; debajo
 * de 640 px se apilan a todo el ancho sin scroll horizontal de la página
 * (ver `SALA_CSS`).
 *
 * Densidad (FX2a · M5): cada `SalaColumn` es `memo` con comparación por firma
 * (`salaEntryKey`), así el tictac del reloj y un lote realtime que toca UNA
 * columna no re-renderizan (ni re-miden con framer) las otras cuatro.
 */
export function SalaBoard({
  columns,
  now,
  groupBy,
  practitioners,
  rooms,
  pendingIds,
  pulses,
  changes,
  laterOpen,
  onToggleLater,
  onAction,
}: {
  columns: ReadonlyArray<SalaColumnModel>;
  now: Date;
  groupBy: SalaGroupBy;
  practitioners: ReadonlyArray<SalaPractitioner>;
  rooms: ReadonlyArray<SalaRoom>;
  pendingIds: ReadonlySet<string>;
  pulses: Readonly<Record<string, string>>;
  changes: number;
  laterOpen: ReadonlySet<string>;
  onToggleLater: (columnId: string) => void;
  onAction: (entry: SalaEntry, action: ReceptionAction) => void;
}) {
  const practitionerById = useMemo(() => new Map(practitioners.map((p) => [p.id, p])), [practitioners]);
  const roomNameById = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  return (
    <div className="sala-board k-scroll" data-group={groupBy}>
      {columns.map((c) => (
        <SalaColumn
          key={`${groupBy}:${c.id}`}
          column={c}
          now={now}
          groupBy={groupBy}
          practitionerById={practitionerById}
          roomNameById={roomNameById}
          pendingIds={pendingIds}
          pulses={pulses}
          changes={changes}
          laterOpen={laterOpen.has(c.id)}
          onToggleLater={onToggleLater}
          onAction={onAction}
        />
      ))}
    </div>
  );
}
