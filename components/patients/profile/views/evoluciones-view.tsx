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
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { IconPlus } from "@/components/ui/icons";
import { NoteCard } from "@/components/clinical-notes/note-card";
import type { NoteEditorBooking, NoteEditorMode } from "@/components/clinical-notes/clinical-notes-ui";
import { getBookingClinicalNote, getPatientTimeline } from "@/lib/clinical-notes-read";

/** PF1.1 (C-PF2): el editor se baja al abrirlo; «Nueva evolución» lo precarga en hover/foco. */
const loadNoteEditor = () => import("@/components/clinical-notes/note-editor-drawer");
const NoteEditorDrawer = dynamic(() => loadNoteEditor().then((m) => m.NoteEditorDrawer), {
  ssr: false,
  loading: () => null,
});
function preloadNoteEditor() {
  void loadNoteEditor().catch(() => {});
}
import { bookingTargetDecision } from "@/lib/clinical-notes-logic";
import type { BookingClinicalNoteView } from "@/lib/clinical-notes-types";
import {
  CLINICAL_NOTE_COPY,
  TIMELINE_PAGE_SIZE,
  TIMELINE_QUERY_MAX,
  type ClinicalNoteDTO,
  type TimelineItem,
  type TimelineSessionDTO,
} from "@/lib/clinical-notes-types";
import { stripPlanIntentParams } from "@/lib/plans-deeplink";
import { formatDateAR } from "@/lib/format";
import type { BookingStatus } from "@prisma/client";

export const EVOLUCIONES_VIEW_COPY = {
  title: "Evoluciones",
  newNote: "Nueva evolución",
  print: "Imprimir historia clínica",
  searchLabel: "Buscar en las evoluciones",
  searchPlaceholder: "Buscar por título o texto…",
  loading: "Cargando evoluciones…",
  loadMore: "Cargar más",
  loadingMore: "Cargando…",
  loadFailed: "No pudimos cargar las evoluciones. Probá de nuevo.",
  retry: "Reintentar",
  empty: "Todavía no hay evoluciones de este paciente.",
  emptyWrite: "Cargá la primera con «Nueva evolución» o desde el turno en la agenda.",
  emptySearch: (q: string) => `No encontramos evoluciones con «${q}».`,
  sessionTitle: "Sesión del plan",
  sessionInNote: "Sesión registrada",
  bookingUnavailable: "No se puede cargar una evolución en ese turno.",
} as const;

/** Turno del deep link (`?turno=`), proyectado por la página: solo si es de ESTE paciente y del consultorio. */
export type DeepLinkBooking = NoteEditorBooking & { status: BookingStatus };

export type EvolucionesViewProps = {
  patientId: string;
  /** `canWriteClinicalNotes(caps, "full", actor.practitionerId)` (la UI solo esconde «Nueva evolución»). */
  canWrite: boolean;
  /** `?turno=` crudo validado por la página; null sin deep link. */
  deepLinkBookingId?: string | null;
  /** El turno del deep link si es de este paciente (null si no existe o es ajeno). */
  deepLinkBooking?: DeepLinkBooking | null;
  /** Se escribió algo (crear, editar, enmendar, anular): el shell relee el resumen. */
  onChanged?: () => void;
  /** Solo tests: primera página ya cargada (el efecto inicial no corre en render estático). */
  initialPage?: { items: TimelineItem[]; nextCursor: string | null } | null;
  /** Solo tests: reloj fijo para las tarjetas. */
  now?: Date;
  /** Solo tests: nota resaltada por un deep link (el efecto que la elige no corre en render estático). */
  highlightNoteId?: string | null;
};

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
`;

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
  initialPage = null,
  now,
  highlightNoteId = null,
}: EvolucionesViewProps) {
  const toast = useToast();
  const [items, setItems] = useState<TimelineItem[]>(initialPage?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "forbidden">(initialPage ? "ready" : "loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [editor, setEditor] = useState<NoteEditorMode | null>(null);
  // Búsqueda en curso con una lista ya en pantalla: la lista queda (aria-busy), no se vacía.
  const [searching, setSearching] = useState(false);
  // Nota que pidió el deep link (se busca cuando la lista está) y nota resaltada (2 s).
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(highlightNoteId);
  // ¿El paciente tiene alguna evolución? Decide si se ofrece imprimir. Sale de la lista sin filtro (una búsqueda sin
  // resultados no esconde el botón); con más páginas se asume que sí (la página siguiente puede tenerla).
  const [hasNotes, setHasNotes] = useState(
    () => !!initialPage && (initialPage.items.some((it) => it.type === "note") || initialPage.nextCursor != null)
  );
  const seq = useRef(0);
  const skipFirstLoad = useRef(initialPage != null);

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
        if (!q) setHasNotes(page.items.some((it) => it.type === "note") || page.nextCursor != null);
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

  // Primera página y cada búsqueda nueva.
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
    void (async () => {
      try {
        const view = await getBookingClinicalNote(deepLinkBooking.id);
        const out = deepLinkOutcome(view, deepLinkBooking, { patientId, canWrite, now: new Date() });
        if (out.kind === "focus") setFocusNoteId(out.noteId);
        else if (out.kind === "create") setEditor({ type: "create", patientId, booking: out.booking });
        else if (out.level === "error") toast.error(out.message);
        else toast.warning(out.message);
      } catch (e) {
        console.error("getBookingClinicalNote failed", e);
        toast.error(EVOLUCIONES_VIEW_COPY.loadFailed);
      }
    })();
  }, [deepLinkBookingId, deepLinkBooking, patientId, canWrite, toast]);

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

  const onEditorSaved = useCallback(
    (note: ClinicalNoteDTO, info: { type: NoteEditorMode["type"] }) => {
      if (info.type === "create") {
        setItems((prev) => insertNoteInItems(prev, note, nextCursor != null));
        setHasNotes(true);
      }
      else if (info.type === "amend") setItems((prev) => addAmendmentToItems(prev, note));
      else setItems((prev) => replaceNoteInItems(prev, note));
      onChanged?.();
    },
    [nextCursor, onChanged]
  );

  const printHref = `/pacientes/${encodeURIComponent(patientId)}/imprimir`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style dangerouslySetInnerHTML={{ __html: EVOLUCIONES_CSS }} />
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div className="k-display" style={{ fontSize: 16, fontWeight: 700, flex: 1, minWidth: 160 }}>
            {EVOLUCIONES_VIEW_COPY.title}
          </div>
          {hasNotes && (
            <a
              className="k-btn k-btn-ghost k-evo-head-btn"
              href={printHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, padding: "8px 12px", textDecoration: "none" }}
            >
              {EVOLUCIONES_VIEW_COPY.print}
            </a>
          )}
          {canWrite && (
            <Button
              type="button"
              variant="primary"
              className="k-evo-head-btn"
              onClick={() => setEditor({ type: "create", patientId })}
              onPointerEnter={preloadNoteEditor}
              onFocus={preloadNoteEditor}
              style={{ fontSize: 12, padding: "8px 12px" }}
            >
              <IconPlus size={14} /> {EVOLUCIONES_VIEW_COPY.newNote}
            </Button>
          )}
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

      {editor && (
        <NoteEditorDrawer open onClose={() => setEditor(null)} mode={editor} onSaved={onEditorSaved} />
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
