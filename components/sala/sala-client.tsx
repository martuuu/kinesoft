"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useTweaksOptional } from "@/components/layout/tweaks-context";
import type { SalaWireRow, SalaPractitioner, SalaRoom, SalaViewer } from "@/lib/sala-board-state";
import type { DeskViewer } from "@/lib/reception-desk-state";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { ReceptionLayout, SalaGroupBy } from "@/lib/preferences-constants";
import { useSalaLive } from "./use-sala-live";
import { useAttendedNoteToast } from "@/components/agenda/reception/use-attended-note-toast";
import { SalaBoardSkeleton, SalaDeskSkeleton } from "./sala-skeleton";
import { loadBoardFace, loadReceptionDesk, preloadSalaFace } from "./sala-faces";
import { DisplaysContext } from "./displays/displays-button";
import { SalaLocationContext, persistSalaLocation, type SalaLocationValue } from "./sala-location-context";
import {
  atSalaLocation,
  salaLocationScope,
  scopeSalaRooms,
  scopeSalaRows,
  type SalaLocationOption,
} from "@/lib/sala-location-filter";

/*
 * PF1.1-sala (C-PF2): solo se baja la cara elegida. Las tres van con `next/dynamic` CON SSR (el default): el HTML del
 * server ya trae la cara y la hidratación la conserva mientras llega su chunk, así que no hay hueco ni CLS (C-PF2
 * prohíbe apagar el SSR en el primer pintado). El `loading` solo se ve al cambiar de cara desde Apariencia.
 *
 * Un solo `ReceptionDesk` para «Lista y panel» y «Flujo» (no un dynamic por cara): pasar de una a otra no remonta el
 * shell y no se pierden la búsqueda ni el filtro por profesional. Su cara interna (`desk-list`/`desk-flow`) es otro
 * chunk; `preloadSalaFace(layout)` lo pide junto con el shell para no encadenar dos idas a la red.
 */
const NO_LOCATIONS: ReadonlyArray<SalaLocationOption> = [];

const SalaBoardFace = dynamic(() => loadBoardFace().then((mod) => mod.SalaBoardFace), {
  loading: () => <SalaBoardSkeleton />,
});
const ReceptionDesk = dynamic(() => loadReceptionDesk().then((mod) => mod.ReceptionDesk), {
  loading: () => <SalaDeskSkeleton />,
});

/**
 * Cliente de /sala. Los datos vivos (filas de HOY, optimista con rollback,
 * realtime + polling en off, reloj, diff de llegadas y llamados, banda «Pase …»)
 * viven en `useSalaLive` (RX-1a, extraído de acá sin cambio de comportamiento);
 * este componente solo elige la cara:
 *
 * - `board` → el Tablero por columnas (SV10a, plan §18.5; `sala-board-face.tsx`);
 * - `list` / `flow` → el escritorio de Recepción (A «Lista y panel», B «Flujo»).
 *
 * Cada cara es un chunk aparte (PF1.1-sala, ver arriba).
 *
 * La cara sale de Apariencia (`useTweaksOptional()?.receptionLayout`, optimista
 * y sin recargar); sin provider (tests, demo) de `initialLayout` que lee la page
 * de las prefs del server; sin nada, el Tablero. El hook vive ACÁ y no en cada
 * cara: cambiar de cara no re-pide ni pierde overrides en vuelo.
 *
 * EV2-3c: `canReadClinical` (`caps.has("clinical.read")`, de la page) + el
 * `practitionerId` del viewer → al marcar «Atendido» en un turno propio, toast
 * «Cargar evolución» en las tres caras (`useAttendedNoteToast`, vía
 * `onCommitted` del hook). PD-13 intacto: el toast solo usa ids, estado y el
 * nombre que ya viajan en la fila; ningún texto clínico entra a /sala.
 *
 * CF2 (D-CF2-5): con ≥2 sedes, `live` se recorta a la sede de `agendaPrefs.locationId` (la de la agenda) ANTES de
 * llegar a las caras: filas, entradas del escritorio y salas. El hook sigue con el día entero (realtime, polling y
 * optimistas no cambian, y cambiar de sede no re-pide). El selector lo montan los headers por `SalaLocationContext`.
 */
export function SalaClient({
  dayKey,
  initialNow,
  initialRows,
  practitioners,
  rooms,
  viewer: viewerProp,
  initialGroupBy,
  initialLayout,
  canReadClinical = false,
  canManageDisplays = false,
  locations = NO_LOCATIONS,
  initialLocationId = null,
}: {
  dayKey: string;
  initialNow: string;
  /** Ya proyectadas en el server (`listSalaBookings`): sin claves clínicas. */
  initialRows: ReadonlyArray<SalaWireRow>;
  practitioners: SalaPractitioner[];
  /** CF2: con `locationId` (catálogo de `listRoomOptions`) las salas se recortan a la sede elegida. */
  rooms: Array<SalaRoom & { locationId?: string }>;
  /** `deskViewer(...)` de la page; un `SalaViewer` pelado (tests del Tablero) se toma como «no cobra». */
  viewer: SalaViewer & { canCollect?: boolean; canCollectAll?: boolean };
  initialGroupBy: SalaGroupBy;
  /** `agendaPrefs.receptionLayout` del server (la page). */
  initialLayout?: ReceptionLayout;
  /** EV2-3c: `caps.has("clinical.read")`. Sin la prop, sin toast «Cargar evolución». */
  canReadClinical?: boolean;
  /**
   * TV-2w2: `agenda.operateAll` sin sesión de soporte (la page). Llega a «Pantallas» de los dos headers por
   * `DisplaysContext` y no como prop de cada cara (son chunks aparte). Sin la prop, sin botón.
   */
  canManageDisplays?: boolean;
  /** CF2: sedes activas (`listLocations`, la page). Con menos de 2 no hay filtro ni selector. */
  locations?: ReadonlyArray<SalaLocationOption>;
  /** CF2: `agendaPrefs.locationId` (la misma preferencia que la agenda). */
  initialLocationId?: string | null;
}) {
  const { practitionerId, canReception, canOperateAll, canCollect = false, canCollectAll = false } = viewerProp;
  // Identidad estable por valor: `viewer` es dep de `buildBoard`/`deskEntries` en cada render.
  const viewer = useMemo<DeskViewer>(
    () => ({ practitionerId, canReception, canOperateAll, canCollect, canCollectAll }),
    [practitionerId, canReception, canOperateAll, canCollect, canCollectAll]
  );
  const onCommitted = useAttendedNoteToast({ practitionerId, canReadClinical });
  const live = useSalaLive({ dayKey, initialNow, initialRows, practitioners, rooms, viewer, onCommitted });
  const layout: ReceptionLayout = useTweaksOptional()?.receptionLayout ?? initialLayout ?? "board";

  // En el render (no en un effect): durante la hidratación así sale a la vez que el chunk del shell. Idempotente.
  preloadSalaFace(layout);
  const displays = useMemo(() => ({ canManage: canManageDisplays }), [canManageDisplays]);

  // CF2: sede. Optimista y en silencio (ver `sala-location-context.ts`): el filtro cambia al toque y se guarda de fondo.
  const [savedLocationId, setSavedLocationId] = useState<string | null>(initialLocationId);
  const scope = useMemo(() => salaLocationScope(locations, savedLocationId), [locations, savedLocationId]);
  const setLocationId = useCallback((id: string | null) => {
    setSavedLocationId(id);
    void persistSalaLocation(id);
  }, []);
  const locationCtx = useMemo<SalaLocationValue | null>(
    () => (scope ? { ...scope, setLocationId } : null),
    [scope, setLocationId]
  );
  // Memo por pieza: sin sede elegida son los MISMOS arrays del hook y los `useMemo` de las caras no recalculan.
  const rows = useMemo(() => scopeSalaRows(live.rows, scope) as BookingDTO[], [live.rows, scope]);
  const entries = useMemo(() => {
    if (!scope?.locationId) return live.entries;
    const { locationId, primaryLocationId } = scope;
    return live.entries.filter((e) => atSalaLocation(e.row, locationId, primaryLocationId));
  }, [live.entries, scope]);
  // Del prop (que trae `locationId`) y no de `live.rooms` (tipado sin sede); sin sede elegida, el del hook tal cual.
  const scopedRooms = useMemo(
    () => (scope?.locationId ? (scopeSalaRooms(rooms, scope) as SalaRoom[]) : live.rooms),
    [rooms, live.rooms, scope]
  );
  const scoped =
    rows === live.rows && entries === live.entries && scopedRooms === live.rooms
      ? live
      : { ...live, rows, entries, rooms: scopedRooms };

  return (
    <DisplaysContext.Provider value={displays}>
      <SalaLocationContext.Provider value={locationCtx}>
        {layout === "board" ? (
          <SalaBoardFace live={scoped} initialGroupBy={initialGroupBy} />
        ) : (
          <ReceptionDesk live={scoped} layout={layout} viewer={viewer} />
        )}
      </SalaLocationContext.Provider>
    </DisplaysContext.Provider>
  );
}
