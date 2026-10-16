"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useTweaksOptional } from "@/components/layout/tweaks-context";
import type { SalaWireRow, SalaPractitioner, SalaRoom, SalaViewer } from "@/lib/sala-board-state";
import type { DeskViewer } from "@/lib/reception-desk-state";
import type { ReceptionLayout, SalaGroupBy } from "@/lib/preferences-constants";
import { useSalaLive } from "./use-sala-live";
import { useAttendedNoteToast } from "@/components/agenda/reception/use-attended-note-toast";
import { SalaBoardSkeleton, SalaDeskSkeleton } from "./sala-skeleton";
import { loadBoardFace, loadReceptionDesk, preloadSalaFace } from "./sala-faces";

/*
 * PF1.1-sala (C-PF2): solo se baja la cara elegida. Las tres van con `next/dynamic` CON SSR (el default): el HTML del
 * server ya trae la cara y la hidratación la conserva mientras llega su chunk, así que no hay hueco ni CLS (C-PF2
 * prohíbe apagar el SSR en el primer pintado). El `loading` solo se ve al cambiar de cara desde Apariencia.
 *
 * Un solo `ReceptionDesk` para «Lista y panel» y «Flujo» (no un dynamic por cara): pasar de una a otra no remonta el
 * shell y no se pierden la búsqueda ni el filtro por profesional. Su cara interna (`desk-list`/`desk-flow`) es otro
 * chunk; `preloadSalaFace(layout)` lo pide junto con el shell para no encadenar dos idas a la red.
 */
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
}: {
  dayKey: string;
  initialNow: string;
  /** Ya proyectadas en el server (`listSalaBookings`): sin claves clínicas. */
  initialRows: ReadonlyArray<SalaWireRow>;
  practitioners: SalaPractitioner[];
  rooms: SalaRoom[];
  /** `deskViewer(...)` de la page; un `SalaViewer` pelado (tests del Tablero) se toma como «no cobra». */
  viewer: SalaViewer & { canCollect?: boolean };
  initialGroupBy: SalaGroupBy;
  /** `agendaPrefs.receptionLayout` del server (la page). */
  initialLayout?: ReceptionLayout;
  /** EV2-3c: `caps.has("clinical.read")`. Sin la prop, sin toast «Cargar evolución». */
  canReadClinical?: boolean;
}) {
  const { practitionerId, canReception, canOperateAll, canCollect = false } = viewerProp;
  // Identidad estable por valor: `viewer` es dep de `buildBoard`/`deskEntries` en cada render.
  const viewer = useMemo<DeskViewer>(
    () => ({ practitionerId, canReception, canOperateAll, canCollect }),
    [practitionerId, canReception, canOperateAll, canCollect]
  );
  const onCommitted = useAttendedNoteToast({ practitionerId, canReadClinical });
  const live = useSalaLive({ dayKey, initialNow, initialRows, practitioners, rooms, viewer, onCommitted });
  const layout: ReceptionLayout = useTweaksOptional()?.receptionLayout ?? initialLayout ?? "board";

  // En el render (no en un effect): durante la hidratación así sale a la vez que el chunk del shell. Idempotente.
  preloadSalaFace(layout);
  if (layout === "board") return <SalaBoardFace live={live} initialGroupBy={initialGroupBy} />;
  return <ReceptionDesk live={live} layout={layout} viewer={viewer} />;
}
