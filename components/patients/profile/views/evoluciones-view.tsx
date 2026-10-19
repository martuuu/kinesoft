"use client";

/**
 * EV2-3a · Pestaña «Evoluciones» del perfil (EV2-D4: línea de tiempo unificada de evoluciones + sesiones completadas).
 *
 * - La página trae `getPatientTimeline` de a `TIMELINE_PAGE_SIZE` con «Cargar más» (cursor keyset del server). No se
 *   reordena nada que no sea lo que ya está en pantalla: el orden y la agrupación nota ↔ sesión del mismo turno los
 *   decide `mergeTimeline` en el server (C-EV2-2). Acá solo se reemplaza/inserta lo que devuelve una action.
 * - Búsqueda con debounce: cada consulta nueva vuelve a la primera página; una respuesta vieja no pisa a una nueva
 *   (`seq`, mismo patrón que `reloadPlans` del shell).
 * - Después de una escritura NO se refresca la ruta (H-SLOW): el DTO de la action entra en la lista y el shell relee
 *   el resumen (contador de la pestaña y «Última evolución» de Resumen) con `onChanged`.
 * - Deep link `?turno=<bookingId>` (`clinicalNoteDeepLink`, Recepción/sala/agenda/Seguimiento): se consume una vez y
 *   se saca de la URL. EV2-Z M4: si el turno ya tiene evolución viva se la lleva a la vista y se la resalta 2 s
 *   (`[data-note-id]`), sin abrir el editor ni avisar: el link es «Ver evolución», no «Editar» (antes abría el editor
 *   o tiraba el toast «ya tiene evolución» sobre algo que el usuario fue a mirar). Sin nota y con `canCreate` abre
 *   crear. La barrera es la action: esto solo elige qué abrir. Lógica en `deepLinkOutcome` (pura, con test).
 * - Búsqueda (EV2-Z): una consulta nueva NO vacía la lista: la anterior queda con `aria-busy` hasta que llega la
 *   respuesta (antes parpadeaba «Cargando…» por cada búsqueda). 16 px en mobile (iOS hace zoom con menos) y botones
 *   del encabezado de 44 px en mobile (tamaño táctil).
 * - «Imprimir historia clínica» solo con al menos una evolución (anulada incluida): sin notas imprimía una hoja vacía.
 * - Nunca se monta sin `clinical.read` + acceso `full` + módulo `evoluciones` (lo filtra `profileTabsFor`); igual, si
 *   la lectura devuelve `null` se muestra el rechazo genérico (no revela nada).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { NoteCard } from "@/components/clinical-notes/note-card";
import type { NoteEditorBooking } from "@/components/clinical-notes/clinical-notes-ui";
// Estático a propósito (§24.9, FC-UI-D9): el composer inline está en el first load; lo que se tipea antes de hidratar
// queda en el `<textarea>` de `HcEditorField` (no controlado). Lo pesado (Tiptap, picker) lo difiere FichaForm adentro.
import { FichaForm } from "@/components/fichas/ficha-form";
import { ComposerBar } from "@/components/fichas/composer-bar";
import { HcHeaderActions } from "@/components/fichas/hc-header-actions";
import { HC_HOME_COPY } from "@/components/fichas/fichas-copy";
import type {
  FichaBackupScope,
  FichaBookingOption,
  FichaDraftScope,
  FichaDrawerProps,
  FichaFormCreateMode,
} from "@/components/fichas/fichas-ui-types";
import { getBookingClinicalNote, getPatientTimeline } from "@/lib/clinical-notes-read";

/** Mobile (FC-UI-D9): `FichaDrawer` a alto completo, diferido; la barra lo precarga en hover/foco/touch. */
const loadFichaDrawer = () => import("@/components/fichas/ficha-drawer");
const FichaDrawer = dynamic<FichaDrawerProps>(() => loadFichaDrawer().then((m) => m.FichaDrawer), {
  ssr: false,
  loading: () => null,
});
function preloadFichaDrawer() {
  void loadFichaDrawer().catch(() => {});
}
import { bookingTargetDecision } from "@/lib/clinical-notes-logic";
import type { BookingClinicalNoteView, PatientClinicalHome } from "@/lib/clinical-notes-types";
import {
  CLINICAL_NOTE_COPY,
  TIMELINE_PAGE_SIZE,
  TIMELINE_QUERY_MAX,
  type ClinicalNoteDTO,
  type TimelineItem,
  type TimelinePage,
  type TimelineSessionDTO,
} from "@/lib/clinical-notes-types";
import { stripPlanIntentParams } from "@/lib/plans-deeplink-params";
import { formatDateAR } from "@/lib/format";
import type { BookingStatus } from "@prisma/client";

export const EVOLUCIONES_VIEW_COPY = {
  // FC-3e1: los textos del inicio de la HC salen de `HC_HOME_COPY` (fichas-copy.ts); acá quedan los de la timeline.
  title: HC_HOME_COPY.tabLabel,
  newNote: HC_HOME_COPY.composerBar,
  print: HC_HOME_COPY.print,
  searchLabel: "Buscar en las fichas",
  searchPlaceholder: "Buscar por título o texto…",
  loading: "Cargando fichas…",
  loadMore: HC_HOME_COPY.loadMore,
  loadingMore: "Cargando…",
  loadFailed: "No pudimos cargar las fichas. Probá de nuevo.",
  retry: "Reintentar",
  empty: HC_HOME_COPY.empty,
  emptyWrite: HC_HOME_COPY.emptyHint,
  emptySearch: (q: string) => `No encontramos fichas con «${q}».`,
  sessionTitle: "Sesión del plan",
  sessionInNote: "Sesión registrada",
  bookingUnavailable: "No se puede cargar una ficha en ese turno.",
} as const;

/** Turno del deep link (`?turno=`), proyectado por la página: solo si es de ESTE paciente y del consultorio. */
export type DeepLinkBooking = NoteEditorBooking & { status: BookingStatus };

export type EvolucionesViewProps = {
  patientId: string;
  /** `canWriteClinicalNotes(caps, "full", actor.practitionerId)` (la UI solo esconde el composer; la barrera es la action). */
  canWrite: boolean;
  /** `?turno=` crudo validado por la página; null sin deep link. */
  deepLinkBookingId?: string | null;
  /** El turno del deep link si es de este paciente (null si no existe o es ajeno). */
  deepLinkBooking?: DeepLinkBooking | null;
  /** Se escribió algo (crear, editar, enmendar, anular, importar): el shell relee el resumen. */
  onChanged?: () => void;
  /**
   * FC-3e1 (FC-UI-D10): la «clinical home» que el loader leyó en la tx 3 del perfil (`getPatientClinicalHome`):
   * primera página (10 ítems, 60k caracteres), candidatos del composer y la vista del deep link. Con ella la vista NO
   * hace ninguna lectura al montar. `null` = sin acceso (rechazo genérico). `undefined` = el caller todavía no la pasa
   * (transición mientras FC-3d la cablea): se cae a la lectura al montar de EV2.
   */
  clinicalHome?: PatientClinicalHome | null;
  /** Nombre para el import de Word y el formulario («Paciente: …»). */
  patientName?: string;
  /** `actor.practitionerId`: el chip del turno pone los propios primero. */
  viewerPractitionerId?: string | null;
  /**
   * Usuario + consultorio del viewer: alcance del borrador en memoria del composer (§24.7) y del handle de la carpeta
   * de respaldo (§24.6). null = sin borrador y sin «Carpeta de respaldo».
   */
  viewerScope?: { tenantId: string; userId: string } | null;
  /** Borrador sin guardar en el composer o el Drawer: el shell pinta el punto en la pestaña (FC-3d). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Solo tests: primera página ya cargada (el efecto inicial no corre en render estático). */
  initialPage?: { items: TimelineItem[]; nextCursor: string | null } | null;
  /** Solo tests: reloj fijo para las tarjetas. */
  now?: Date;
  /** Solo tests: nota resaltada por un deep link (el efecto que la elige no corre en render estático). */
  highlightNoteId?: string | null;
};

/**
 * Estado inicial de la lista (pura, con test). FC-3e1: con la clinical home del SSR la lista sale pintada y NO se
 * lee nada al montar (antes la pestaña montaba en «Cargando…» y pedía la timeline: un round-trip más con la HC como
 * pestaña inicial, hallazgo 3 de §24.2).
 */
export function firstLoadState(input: {
  initialPage?: TimelinePage | null;
  clinicalHome?: PatientClinicalHome | null;
}): { status: "loading" | "ready" | "forbidden"; page: TimelinePage | null; fetchOnMount: boolean } {
  if (input.initialPage) return { status: "ready", page: input.initialPage, fetchOnMount: false };
  if (input.clinicalHome === null) return { status: "forbidden", page: null, fetchOnMount: false };
  if (input.clinicalHome?.firstPage) return { status: "ready", page: input.clinicalHome.firstPage, fetchOnMount: false };
  // Sin home (caller viejo) o una home armada sin timeline (`timeline: false`): la lectura de EV2.
  return { status: "loading", page: null, fetchOnMount: true };
}

/** ¿El paciente tiene alguna ficha? (decide imprimir/descargar). Con más páginas se asume que sí. */
export function pageHasNotes(page: TimelinePage | null): boolean {
  return !!page && (page.items.some((it) => it.type === "note") || page.nextCursor != null);
}

/** Turno del deep link → opción del chip fijo del composer (no es del candidato: no se sabe el profesional). */
export function deepLinkFixedBooking(b: NoteEditorBooking & { status: BookingStatus }): FichaBookingOption {
  return { id: b.id, scheduledFor: b.scheduledFor, serviceName: b.serviceName, status: b.status, practitionerId: null, hasLiveNote: false };
}

/** Breakpoint del composer (FC-UI-D9): inline desde 640 px; abajo, barra + Drawer. */
export const COMPOSER_INLINE_MIN_PX = 640;

/** Cuánto dura el resaltado de la nota del deep link (EV2-Z M4). */
export const DEEP_LINK_HIGHLIGHT_MS = 2000;

/** Qué hace el deep link `?turno=` con la respuesta de `getBookingClinicalNote` (EV2-Z M4). */
export type DeepLinkOutcome =
  | { kind: "focus"; noteId: string }
  | { kind: "create"; booking: NoteEditorBooking }
  | { kind: "toast"; level: "error" | "warning"; message: string };

export function deepLinkOutcome(
  view: BookingClinicalNoteView | null,
  booking: DeepLinkBooking,
  ctx: { patientId: string; canWrite: boolean; now: Date }
): DeepLinkOutcome {
  if (!view) return { kind: "toast", level: "error", message: CLINICAL_NOTE_COPY.forbidden };
  // Con nota viva: se muestra, nunca se abre el editor ni se avisa (M4).
  if (view.note) return { kind: "focus", noteId: view.note.id };
  if (view.canCreate) {
    return { kind: "create", booking: { id: booking.id, scheduledFor: booking.scheduledFor, serviceName: booking.serviceName } };
  }
  if (!ctx.canWrite) return { kind: "toast", level: "error", message: CLINICAL_NOTE_COPY.forbidden };
  // Por qué no: el mismo orden de razones que la action (cancelado → ausente → futuro).
  const d = bookingTargetDecision(
    { patientId: ctx.patientId, status: booking.status, scheduledFor: new Date(booking.scheduledFor) },
    ctx.patientId,
    ctx.now
  );
  const message = d.ok
    ? EVOLUCIONES_VIEW_COPY.bookingUnavailable
    : d.reason === "cancelled"
      ? CLINICAL_NOTE_COPY.bookingCancelled
      : d.reason === "no-show"
        ? CLINICAL_NOTE_COPY.bookingNoShow
        : d.reason === "future"
          ? CLINICAL_NOTE_COPY.future
          : EVOLUCIONES_VIEW_COPY.bookingUnavailable;
  return { kind: "toast", level: "warning", message };
}

/**
 * Mobile: búsqueda a 16 px (con menos, iOS Safari hace zoom al enfocar) y botones del encabezado de 44 px (tamaño
 * táctil). Es CSS local porque son media queries y el resto de la vista va con estilos inline.
 */
const EVOLUCIONES_CSS = `
@media (max-width: 640px) {
  .k-evo-search { font-size: 16px !important; min-height: 44px; }
  .k-evo-head-btn { min-height: 44px; display: inline-flex !important; align-items: center; }
}
@media (max-width: 639.98px) { .k-hc-composer-inline { display: none !important; } }
@media (min-width: 640px) { .k-hc-composer-bar { display: none !important; } }
`;

/**
 * ¿Ancho ≥ 640? null hasta hidratar: en el SSR y el primer render van los DOS (composer inline y barra) y el CSS
 * decide cuál se ve, así a 1024 el composer está en el HTML y se puede escribir antes de que cargue el JS. Después de
 * hidratar, abajo de 640 se DESMONTA el inline (oculto pero montado competiría con el Drawer por el mismo borrador y
 * el mismo `beforeunload`); en mobile nadie pudo tipear en él porque nunca se vio.
 */
function useComposerInline(): boolean | null {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia?.(`(min-width: ${COMPOSER_INLINE_MIN_PX}px)`);
    if (!mq) {
      setWide(true);
      return;
    }
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return wide;
}

// ─── Helpers puros (los usa el render test) ──────────────────────────────────────────────────────────────────────

/** Orden de `mergeTimeline`: (at DESC, key DESC), comparando la clave por unidades de código (igual que el server). */
function compareItems(a: TimelineItem, b: TimelineItem): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

/** Reemplaza una nota (raíz o enmienda) por id. Si cambió la fecha de una raíz, el ítem se reubica. */
export function replaceNoteInItems(items: TimelineItem[], note: ClinicalNoteDTO): TimelineItem[] {
  let moved = false;
  const next = items.map((it) => {
    if (it.type !== "note") return it;
    if (it.note.id === note.id) {
      moved = it.at !== note.occurredAt;
      return { ...it, note, at: note.occurredAt };
    }
    if (it.amendments.some((a) => a.id === note.id)) {
      return { ...it, amendments: it.amendments.map((a) => (a.id === note.id ? note : a)) };
    }
    return it;
  });
  return moved ? [...next].sort(compareItems) : next;
}

/** Agrega una enmienda al final de las de su raíz (orden `createdAt ASC`, como `mergeTimeline`). */
export function addAmendmentToItems(items: TimelineItem[], amendment: ClinicalNoteDTO): TimelineItem[] {
  return items.map((it) =>
    it.type === "note" && it.note.id === amendment.amendsNoteId && !it.amendments.some((a) => a.id === amendment.id)
      ? { ...it, amendments: [...it.amendments, amendment] }
      : it
  );
}

/**
 * Inserta una evolución recién creada. Si en pantalla está suelta la sesión de su turno, la absorbe (misma regla que
 * `mergeTimeline`). Si su fecha cae más atrás de lo cargado y hay más páginas, no se inserta: aparece al «Cargar más»
 * (insertarla ahí rompería el corte del cursor).
 */
export function insertNoteInItems(items: TimelineItem[], note: ClinicalNoteDTO, hasMore: boolean): TimelineItem[] {
  if (items.some((it) => it.type === "note" && it.note.id === note.id)) return replaceNoteInItems(items, note);
  const item: TimelineItem = { type: "note", key: `n:${note.id}`, at: note.occurredAt, note, amendments: [], session: null };
  const last = items[items.length - 1];
  if (hasMore && last && compareItems(item, last) > 0) return items;
  let rest = items;
  if (note.bookingId) {
    const loose = items.find((it) => it.type === "session" && it.session.bookingId === note.bookingId);
    if (loose && loose.type === "session") {
      item.session = loose.session;
      rest = items.filter((it) => it !== loose);
    }
  }
  return [...rest, item].sort(compareItems);
}

/** Línea de detalle de una sesión completada: «8/10 ejercicios · RPE 6 · EVA 7 → 4». */
export function sessionDetailLine(s: TimelineSessionDTO): string {
  const parts: string[] = [];
  if (s.exercisesTotal > 0) parts.push(`${s.exercisesDone}/${s.exercisesTotal} ejercicios`);
  if (s.rpe != null) parts.push(`RPE ${s.rpe}`);
  if (s.paInPre != null || s.paInPost != null) parts.push(`EVA ${s.paInPre ?? "—"} → ${s.paInPost ?? "—"}`);
  return parts.join(" · ");
}

// ─── Vista ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function EvolucionesView({
  patientId,
  canWrite,
  deepLinkBookingId = null,
  deepLinkBooking = null,
  onChanged,
  clinicalHome,
  patientName = "",
  viewerPractitionerId = null,
  viewerScope = null,
  onDirtyChange,
  initialPage = null,
  now,
  highlightNoteId = null,
}: EvolucionesViewProps) {
  const toast = useToast();
  // Se calcula una vez: la home es del SSR de ESTA visita; las escrituras posteriores entran por los DTO de las
  // actions, nunca re-leyendo la home.
  const [first] = useState(() => firstLoadState({ initialPage, clinicalHome }));
  const [items, setItems] = useState<TimelineItem[]>(first.page?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(first.page?.nextCursor ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "forbidden">(first.status);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  // Búsqueda en curso con una lista ya en pantalla: la lista queda (aria-busy), no se vacía.
  const [searching, setSearching] = useState(false);
  // Nota que pidió el deep link (se busca cuando la lista está) y nota resaltada (2 s).
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(highlightNoteId);
  // ¿El paciente tiene alguna ficha? Decide si se ofrece imprimir/descargar y el tipo por defecto del composer
  // (FC-UI-D5). Sale de la lista sin filtro (una búsqueda sin resultados no lo cambia).
  const [hasNotes, setHasNotes] = useState(() => pageHasNotes(first.page));
  // Composer: turno fijo (deep link `?turno=` sin ficha) y Drawer de mobile.
  const [fixedBooking, setFixedBooking] = useState<FichaBookingOption | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inlineDirty, setInlineDirty] = useState(false);
  const [drawerDirty, setDrawerDirty] = useState(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const inlineWide = useComposerInline();
  const seq = useRef(0);
  const skipFirstLoad = useRef(!first.fetchOnMount);

  const candidates = useMemo(() => clinicalHome?.composer?.candidates ?? [], [clinicalHome]);
  const draftScope = useMemo<FichaDraftScope | null>(
    () => (viewerScope ? { tenantId: viewerScope.tenantId, userId: viewerScope.userId, patientId } : null),
    [viewerScope, patientId]
  );
  const backupScope = useMemo<FichaBackupScope | null>(
    () => (viewerScope ? { tenantId: viewerScope.tenantId, userId: viewerScope.userId } : null),
    [viewerScope]
  );
  // Memo: FichaForm arma su estado inicial desde `mode`; un objeto nuevo por render lo re-inicializaría.
  const composerMode = useMemo<FichaFormCreateMode>(
    () => ({ type: "create", patientId, patientName: patientName || undefined, patientHasNotes: hasNotes, bookings: candidates, fixedBooking }),
    [patientId, patientName, hasNotes, candidates, fixedBooking]
  );

  useEffect(() => {
    onDirtyChange?.(inlineDirty || drawerDirty);
  }, [inlineDirty, drawerDirty, onDirtyChange]);

  const loadFirst = useCallback(
    async (q: string) => {
      const mine = ++seq.current;
      // Con una lista ya en pantalla no se pasa a «Cargando…» (parpadeo): queda la anterior con aria-busy.
      setStatus((s) => (s === "ready" ? s : "loading"));
      setSearching(true);
      setMoreError(false);
      try {
        const page = await getPatientTimeline({ patientId, q: q || null, limit: TIMELINE_PAGE_SIZE });
        if (mine !== seq.current) return;
        if (!page) {
          setStatus("forbidden");
          return;
        }
        setItems(page.items);
        setNextCursor(page.nextCursor);
        if (!q) setHasNotes(pageHasNotes(page));
        setStatus("ready");
      } catch (e) {
        console.error("getPatientTimeline failed", e);
        if (mine === seq.current) setStatus("error");
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    },
    [patientId]
  );

  // Primera página (solo sin home del SSR) y cada búsqueda nueva.
  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }
    void loadFirst(activeQuery);
  }, [loadFirst, activeQuery]);

  // Debounce de la búsqueda (300 ms): no una lectura por tecla.
  useEffect(() => {
    const q = query.trim();
    if (q === activeQuery) return;
    const t = setTimeout(() => setActiveQuery(q), 300);
    return () => clearTimeout(t);
  }, [query, activeQuery]);

  // «Cargar más» de a 20 (FC-UI-D10): la primera página del SSR es de 10 (o menos, por el tope de 60k caracteres) y
  // su `nextCursor` sigue exactamente donde cortó; el resto va con el tamaño de página de la timeline.
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const mine = seq.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await getPatientTimeline({ patientId, cursor: nextCursor, q: activeQuery || null, limit: TIMELINE_PAGE_SIZE });
      if (mine !== seq.current) return;
      if (!page) {
        setStatus("forbidden");
        return;
      }
      // Dedupe por clave: una nota creada acá que el server también devuelve no se duplica.
      setItems((prev) => {
        const seen = new Set(prev.map((it) => it.key));
        return [...prev, ...page.items.filter((it) => !seen.has(it.key))];
      });
      setNextCursor(page.nextCursor);
    } catch (e) {
      console.error("getPatientTimeline (más) failed", e);
      if (mine === seq.current) setMoreError(true);
    } finally {
      if (mine === seq.current) setLoadingMore(false);
    }
  }, [nextCursor, patientId, activeQuery]);

  const onNoteChange = useCallback(
    (note: ClinicalNoteDTO) => {
      setItems((prev) => replaceNoteInItems(prev, note));
      onChanged?.();
    },
    [onChanged]
  );
  const onAmendmentAdded = useCallback(
    (amendment: ClinicalNoteDTO) => {
      setItems((prev) => addAmendmentToItems(prev, amendment));
      onChanged?.();
    },
    [onChanged]
  );

  /** Ficha nueva (composer, Drawer o import): entra en la lista sin refrescar la ruta (H-SLOW). */
  const onCreated = useCallback(
    (notes: ClinicalNoteDTO[]) => {
      if (notes.length === 0) return;
      setItems((prev) => notes.reduce((acc, n) => insertNoteInItems(acc, n, nextCursor != null), prev));
      setHasNotes(true);
      onChanged?.();
    },
    [nextCursor, onChanged]
  );
  const onComposerSaved = useCallback(
    (note: ClinicalNoteDTO) => {
      // El turno fijo del deep link se usó: el próximo composer vuelve a los candidatos.
      setFixedBooking(null);
      onCreated([note]);
    },
    [onCreated]
  );

  // ── Deep link `?turno=`: una sola vez, y se limpia la URL (un refresh no lo vuelve a abrir) ──────────────────
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkConsumed.current || !deepLinkBookingId) return;
    deepLinkConsumed.current = true;
    try {
      window.history.replaceState(window.history.state, "", stripPlanIntentParams(window.location.href));
    } catch {
      // Sin history (tests): el deep link igual se consume una vez.
    }
    if (!deepLinkBooking) {
      toast.error(CLINICAL_NOTE_COPY.bookingNotFound);
      return;
    }
    const apply = (view: BookingClinicalNoteView | null) => {
      const out = deepLinkOutcome(view, deepLinkBooking, { patientId, canWrite, now: new Date() });
      if (out.kind === "focus") setFocusNoteId(out.noteId);
      else if (out.kind === "create") {
        // Crear en ESE turno: el chip queda fijo. Desde 640 px es el composer inline (se lo lleva a la vista); abajo,
        // el Drawer a alto completo con el mismo formulario.
        setFixedBooking(deepLinkFixedBooking(deepLinkBooking));
        const wide = window.matchMedia?.(`(min-width: ${COMPOSER_INLINE_MIN_PX}px)`).matches ?? true;
        if (wide) {
          const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          requestAnimationFrame(() => composerRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }));
        } else setDrawerOpen(true);
      } else if (out.level === "error") toast.error(out.message);
      else toast.warning(out.message);
    };
    // FC-3e1: la vista del deep link ya vino en la home (misma tx del perfil); sin home, la lectura de EV2.
    if (clinicalHome !== undefined) {
      apply(clinicalHome?.deepLink ?? null);
      return;
    }
    void (async () => {
      try {
        apply(await getBookingClinicalNote(deepLinkBooking.id));
      } catch (e) {
        console.error("getBookingClinicalNote failed", e);
        toast.error(EVOLUCIONES_VIEW_COPY.loadFailed);
      }
    })();
  }, [deepLinkBookingId, deepLinkBooking, patientId, canWrite, toast, clinicalHome]);

  // Nota del deep link: cuando la lista está, se la lleva a la vista y se la resalta. Si no está en lo cargado (más
  // vieja que la primera página) no se fuerza nada: aparece con «Cargar más».
  useEffect(() => {
    if (!focusNoteId || status !== "ready") return;
    setFocusNoteId(null);
    if (!items.some((it) => it.type === "note" && it.note.id === focusNoteId)) return;
    setHighlighted(focusNoteId);
    const el = document.querySelector(`[data-note-id="${CSS.escape(focusNoteId)}"]`);
    // Con «reducir movimiento» el salto es instantáneo; el resaltado no se anima nunca (solo un borde).
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }, [focusNoteId, status, items]);
  useEffect(() => {
    if (!highlighted) return;
    const t = setTimeout(() => setHighlighted(null), DEEP_LINK_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [highlighted]);

  // Composer solo con escritura y si la vista no está rechazada. `inlineWide === false` = mobile ya hidratado.
  const showComposer = canWrite && status !== "forbidden";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style dangerouslySetInnerHTML={{ __html: EVOLUCIONES_CSS }} />
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 className="k-display" style={{ margin: 0, fontSize: 16, fontWeight: 700, flex: 1, minWidth: 160 }}>
            {EVOLUCIONES_VIEW_COPY.title}
          </h2>
          <HcHeaderActions
            patientId={patientId}
            patientName={patientName}
            hasNotes={hasNotes}
            canWrite={canWrite}
            backupScope={backupScope}
            onImported={onCreated}
          />
        </div>
        <input
          type="search"
          className="k-evo-search"
          aria-label={EVOLUCIONES_VIEW_COPY.searchLabel}
          placeholder={EVOLUCIONES_VIEW_COPY.searchPlaceholder}
          value={query}
          maxLength={TIMELINE_QUERY_MAX}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid rgba(15,30,51,0.12)",
            fontSize: 13,
            background: "var(--card-bg)",
          }}
        />
      </Card>

      {showComposer && inlineWide !== false && (
        <div ref={composerRef} className="k-hc-composer-inline" data-hc-composer="inline">
          <Card style={{ padding: 16 }}>
            <FichaForm
              mode={composerMode}
              variant="inline"
              viewerPractitionerId={viewerPractitionerId}
              draftScope={draftScope}
              onSaved={onComposerSaved}
              onCancel={fixedBooking ? () => setFixedBooking(null) : undefined}
              onDirtyChange={setInlineDirty}
              now={now}
            />
          </Card>
        </div>
      )}
      {showComposer && inlineWide !== true && (
        <ComposerBar
          className="k-hc-composer-bar"
          candidates={candidates}
          fixedBooking={fixedBooking}
          viewerPractitionerId={viewerPractitionerId}
          onOpen={() => setDrawerOpen(true)}
          onPreload={preloadFichaDrawer}
          dirty={drawerDirty}
          now={now}
        />
      )}

      {status === "loading" && (
        <div role="status" aria-busy="true" style={{ fontSize: 13, color: "var(--navy-500)", padding: 12 }}>
          {EVOLUCIONES_VIEW_COPY.loading}
        </div>
      )}
      {status === "forbidden" && (
        <Card style={{ padding: 16, fontSize: 13, color: "var(--navy-500)" }}>{CLINICAL_NOTE_COPY.forbidden}</Card>
      )}
      {status === "error" && (
        <Card style={{ padding: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "var(--danger-fg)" }}>{EVOLUCIONES_VIEW_COPY.loadFailed}</span>
          <Button type="button" variant="ghost" onClick={() => void loadFirst(activeQuery)}>
            {EVOLUCIONES_VIEW_COPY.retry}
          </Button>
        </Card>
      )}

      {status === "ready" && items.length === 0 && (
        <Card style={{ padding: 18, fontSize: 13, color: "var(--navy-500)" }} data-testid="timeline-empty">
          {activeQuery ? (
            EVOLUCIONES_VIEW_COPY.emptySearch(activeQuery)
          ) : (
            <>
              <p style={{ margin: 0 }}>{EVOLUCIONES_VIEW_COPY.empty}</p>
              {canWrite && <p style={{ margin: "6px 0 0" }}>{EVOLUCIONES_VIEW_COPY.emptyWrite}</p>}
            </>
          )}
        </Card>
      )}

      {status === "ready" && items.length > 0 && (
        <ol aria-label="Línea de tiempo" aria-busy={searching || undefined} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
          {items.map((it) => (
            <li
              key={it.key}
              data-timeline-item={it.type}
              data-highlighted={it.type === "note" && it.note.id === highlighted ? "" : undefined}
              style={
                it.type === "note" && it.note.id === highlighted
                  ? { outline: "2px solid var(--sky-300)", outlineOffset: 4, borderRadius: "var(--r-md)" }
                  : undefined
              }
            >
              {it.type === "note" ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <NoteCard
                    note={it.note}
                    amendments={it.amendments}
                    onNoteChange={onNoteChange}
                    onAmendmentAdded={onAmendmentAdded}
                    now={now}
                  />
                  {it.session && <SessionBlock session={it.session} nested />}
                </div>
              ) : (
                <SessionBlock session={it.session} />
              )}
            </li>
          ))}
        </ol>
      )}

      {status === "ready" && nextCursor && (
        <div style={{ display: "flex", justifyContent: "center", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" onClick={loadMore} disabled={loadingMore} style={{ fontSize: 12 }}>
            {loadingMore ? EVOLUCIONES_VIEW_COPY.loadingMore : EVOLUCIONES_VIEW_COPY.loadMore}
          </Button>
          {moreError && <span style={{ fontSize: 12, color: "var(--danger-fg)" }}>{EVOLUCIONES_VIEW_COPY.loadFailed}</span>}
        </div>
      )}

      {/* Montado mientras haya borrador: cerrar el Drawer sin guardar no lo pierde (el borrador vive en memoria). */}
      {showComposer && (drawerOpen || drawerDirty) && (
        <FichaDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          mode={composerMode}
          viewerPractitionerId={viewerPractitionerId}
          draftScope={draftScope}
          onSaved={(note) => {
            setDrawerOpen(false);
            setDrawerDirty(false);
            onComposerSaved(note);
          }}
          onDirtyChange={setDrawerDirty}
          now={now}
        />
      )}
    </div>
  );
}

/**
 * Sesión completada de un plan. Suelta (sin evolución de su turno en la página) va como tarjeta propia; dentro de una
 * evolución, indentada debajo (es el registro del plan: ejercicios, RPE, EVA), sin acciones: se edita en Seguimiento.
 */
function SessionBlock({ session, nested = false }: { session: TimelineSessionDTO; nested?: boolean }) {
  const detail = sessionDetailLine(session);
  return (
    <section
      data-session-id={session.id}
      style={{
        display: "grid",
        gap: 4,
        padding: nested ? "8px 12px" : 14,
        marginLeft: nested ? 16 : 0,
        borderRadius: "var(--r-md)",
        background: "rgba(246,249,253,0.8)",
        border: "1px dashed rgba(15,30,51,0.12)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12, color: "var(--navy-700)" }}>
          {nested ? EVOLUCIONES_VIEW_COPY.sessionInNote : EVOLUCIONES_VIEW_COPY.sessionTitle}
          {session.programTitle ? ` · ${session.programTitle}` : ""}
        </strong>
        <span style={{ fontSize: 12, color: "var(--navy-400)" }}>{formatDateAR(session.completedAt, "longDateTime")}</span>
      </div>
      {detail && <span style={{ fontSize: 12, color: "var(--navy-500)" }}>{detail}</span>}
      {session.notes && (
        <p style={{ margin: 0, fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--navy-700)" }}>
          {session.notes}
        </p>
      )}
    </section>
  );
}
