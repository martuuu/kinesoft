"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_IN_OUT, EASE_OUT } from "@/lib/motion";
import { useToast } from "@/components/ui/toast";
import { IconBell } from "@/components/ui/icons";
import { useTweaksOptional } from "@/components/layout/tweaks-context";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { ReceptionLayout } from "@/lib/preferences-constants";
import { applyReceptionAction, type ReceptionAction, type ReceptionState } from "@/lib/reception-state";
import { deskKpis, deskShortcut, type DeskEntry, type DeskViewer } from "@/lib/reception-desk-state";
import { shortPatientName } from "@/lib/sala-board-state";
import type { SalaLive } from "@/components/sala/sala-live-types";
import { DESK_CSS } from "./desk-css";
import { DeskHeader } from "./desk-header";
import { DeskActionsProvider, deskActionToast, type DeskActionsApi } from "./desk-actions";
import { DeskPayModal } from "./desk-pay-modal";
import { DeskList } from "./desk-list";
import { DeskFlow } from "./desk-flow";

/** «Nuevo turno» (RX-D3): el modal de alta de la agenda (`agenda/page.tsx` → `autoCreate` → `BookingModal`). */
export const DESK_NEW_BOOKING_HREF = "/agenda?new=1";
/** Debajo de este alto de ventana el escritorio deja de calzar: alto natural y la página scrollea (§4.4). */
export const DESK_MIN_FIT_HEIGHT = 560;
/** Aire debajo del escritorio, sumado a su `top` medido (§4.4: `getBoundingClientRect().top + 14`). */
const DESK_BOTTOM_GAP = 14;
/** Lo que dura el toast «Deshacer» (prototipo: 6 s). */
const UNDO_TOAST_MS = 6_000;

/**
 * Cómo calza el escritorio en la ventana (puro, para el test). `top` = distancia del documento al borde de arriba
 * del escritorio (topbar, banda de soporte o de facturación): lo que queda es el alto del escritorio.
 */
export function deskFit(innerHeight: number, top: number): { natural: true } | { natural: false; deskTopPx: number } {
  if (innerHeight < DESK_MIN_FIT_HEIGHT) return { natural: true };
  return { natural: false, deskTopPx: Math.max(0, Math.round(top)) + DESK_BOTTOM_GAP };
}

/** Una acción en vuelo cuyo resultado decide si sale el toast «Deshacer». */
export type DeskUndoCheck = { id: string; action: ReceptionAction; name: string; prevUpdatedAt: string; to: ReceptionState };

/**
 * ¿La acción se guardó? `live.act` no devuelve el resultado (rollback y toasts de error son suyos), así que se mira
 * la fila después: ya no está en vuelo, el server le dio un `updatedAt` nuevo y quedó en el estado que la acción
 * prometía. Un rollback deja el `updatedAt` viejo; un «cambió en otra sesión» re-pide la fila, que puede tener otro
 * `updatedAt` pero no el estado de la acción. `"wait"` = todavía en vuelo.
 */
export function undoCheckOutcome(
  check: DeskUndoCheck,
  entry: Pick<DeskEntry, "state" | "row"> | undefined,
  pending: boolean
): "wait" | "saved" | "dropped" {
  if (pending) return "wait";
  if (!entry) return "dropped";
  return entry.row.updatedAt !== check.prevUpdatedAt && entry.state === check.to ? "saved" : "dropped";
}

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/**
 * Escritorio de Recepción en `/sala` (RX-1b, brief RX §1.1 y §4.4): el shell común de las caras A «Lista y panel»
 * (`DeskList`) y B «Flujo» (`DeskFlow`). Los datos vivos son de `useSalaLive` (`live`, C-RX4): realtime, polling,
 * optimista con rollback, reloj único y banda de llamado; el shell no pide nada.
 *
 * Qué pone el shell:
 *   - el alto: `.desk-frame` calza en la ventana sin scroll de página (§4.4); su `top` se mide en el mount y con
 *     `resize`, así absorbe la banda de soporte o de facturación; con menos de 560 px de alto, alto natural;
 *   - el header (`DeskHeader`): KPIs, buscador con `/`, «Nuevo turno» con `N` (→ `/agenda?new=1`), reloj y «Vista»
 *     (abre Apariencia con `set("minimised", false)`, solo si hay provider);
 *   - la banda «Pase …» (8 s, del hook) flotando sobre el cuerpo, con «Cerrar»;
 *   - el toast con «Deshacer» después de cada acción guardada (`act(row, "deshacer")`);
 *   - el modal de cobro (`DeskPayModal`, solo con `billing.manage`), montado FUERA de `.desk` (ver desk-css.ts);
 *   - el estado de la búsqueda y del filtro por profesional, que reciben las caras (C-RX5);
 *   - `DeskActionsProvider`: el botón primario y el menú ⋯ de cada fila llaman acá sin callbacks por props.
 *
 * Atajos (`deskShortcut`, puro): `/` enfoca el buscador, `N` va a «Nuevo turno», `Esc` limpia el buscador. Nada con
 * Ctrl/Cmd/Alt, con un modal, drawer o menú abierto, ni escribiendo en un campo.
 *
 * PD-13: las filas ya llegan limpias del server (`toSalaWire`/`fromSalaWire`) y acá tampoco se lee nada clínico.
 */
export function ReceptionDesk({
  live,
  layout,
  viewer: viewerProp,
}: {
  live: SalaLive;
  layout: Exclude<ReceptionLayout, "board">;
  /** El de la page (`deskViewer`). Si no viene, el de `live` (son el mismo objeto en `SalaClient`). */
  viewer?: DeskViewer;
}) {
  const viewer = viewerProp ?? live.viewer;
  const router = useRouter();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tweaks = useTweaksOptional();

  const [query, setQuery] = useState("");
  const [proFilter, setProFilter] = useState<string | null>(null);
  const [payId, setPayId] = useState<string | null>(null);
  const [undoCheck, setUndoCheck] = useState<DeskUndoCheck | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // Lo vigente para los callbacks estables (las filas memoizadas de las caras comparan por identidad).
  const liveRef = useRef(live);
  liveRef.current = live;

  const kpis = useMemo(() => deskKpis(live.entries), [live.entries]);
  const proNames = useMemo(() => new Map(live.practitioners.map((p) => [p.id, p.name])), [live.practitioners]);
  const practitionerName = useCallback((id: string) => proNames.get(id) ?? "Profesional", [proNames]);

  // Un filtro por un profesional que ya no tiene turnos hoy (lo dieron de baja, se cancelaron todos) dejaría la cara
  // vacía sin chip apretado para sacarlo.
  useEffect(() => {
    if (proFilter && !live.rows.some((r) => r.practitionerId === proFilter && r.status !== "CANCELLED")) setProFilter(null);
  }, [proFilter, live.rows]);

  // ── Alto sin scroll de página (§4.4) ──
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => {
      const fit = deskFit(window.innerHeight, el.getBoundingClientRect().top + window.scrollY);
      if (fit.natural) {
        el.dataset.fit = "natural";
        el.style.height = "";
        return;
      }
      delete el.dataset.fit;
      // Inline (no custom property): ver desk-css.ts. En stack, el `!important` del CSS le gana.
      el.style.height = `calc(100dvh - ${fit.deskTopPx}px)`;
    };
    measure();
    // Una vuelta más después del primer paint: fuentes y bandas del layout terminan de acomodarse.
    const raf = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, []);

  // ── Acciones con «Deshacer» ──
  const run = useCallback((entry: DeskEntry, action: ReceptionAction) => {
    const cur = liveRef.current;
    // La fila VIGENTE: la entry de una fila memoizada puede ser de un render anterior.
    const row = cur.rows.find((r) => r.id === entry.row.id) ?? entry.row;
    const t = applyReceptionAction(row, action, new Date());
    void cur.act(row, action).then(() => {
      if (action === "deshacer" || !t.ok) return;
      setUndoCheck({ id: row.id, action, name: shortPatientName(row.patientName), prevUpdatedAt: row.updatedAt, to: t.to });
    });
  }, []);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!undoCheck) return;
    const entry = live.entries.find((e) => e.row.id === undoCheck.id);
    const outcome = undoCheckOutcome(undoCheck, entry, live.pendingIds.has(undoCheck.id));
    if (outcome === "wait") return;
    setUndoCheck(null);
    if (outcome !== "saved" || !entry) return;
    const text = deskActionToast(undoCheck.action, undoCheck.name, live.clock);
    if (!text) return;
    const canUndo = entry.salaActions.includes("deshacer");
    toastRef.current.show("success", text, {
      // Un solo «Deshacer» a la vez: el de la última acción reemplaza al anterior (deshacer uno viejo confunde).
      id: "desk-undo",
      duration: UNDO_TOAST_MS,
      action: canUndo
        ? {
            label: "Deshacer",
            onClick: () => {
              const fresh = liveRef.current.entries.find((e) => e.row.id === undoCheck.id);
              if (fresh?.salaActions.includes("deshacer")) runRef.current(fresh, "deshacer");
            },
          }
        : undefined,
    });
  }, [undoCheck, live.entries, live.pendingIds, live.clock]);

  // ── Cobro ──
  const collect = useCallback(
    (entry: DeskEntry) => {
      if (!viewer.canCollect) return;
      setPayId(entry.row.id);
    },
    [viewer.canCollect]
  );
  const payRow: BookingDTO | null = payId ? live.rows.find((r) => r.id === payId) ?? null : null;
  const closePay = useCallback(() => setPayId(null), []);

  // ── Atajos ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      const overlayOpen = document.querySelector("[aria-modal], [role=menu], [role=dialog]") != null;
      const s = deskShortcut(e.key, {
        typing: isEditable(e.target),
        modifier: e.ctrlKey || e.metaKey || e.altKey,
        overlayOpen,
      });
      if (s === "search") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (s === "new-booking") {
        e.preventDefault();
        router.push(DESK_NEW_BOOKING_HREF);
      } else if (s === "clear" && e.target === searchRef.current) {
        e.preventDefault();
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const api = useMemo<DeskActionsApi>(
    () => ({ viewer, dayKey: live.dayKey, now: live.clock, pendingIds: live.pendingIds, practitionerName, run, collect }),
    [viewer, live.dayKey, live.clock, live.pendingIds, practitionerName, run, collect]
  );

  const faceProps = { live, query, proFilter, onProFilter: setProFilter };

  return (
    <>
      <div className="desk" data-layout={layout}>
        <style>{DESK_CSS}</style>
        <div className="desk-frame" ref={frameRef}>
          <DeskHeader
            dayKey={live.dayKey}
            clock={live.clock}
            kpis={kpis}
            query={query}
            onQuery={setQuery}
            searchRef={searchRef}
            onNewBooking={() => router.push(DESK_NEW_BOOKING_HREF)}
            onOpenView={tweaks ? () => tweaks.set("minimised", false) : null}
          />

          {/* La región existe siempre (un aria-live que se monta con su texto no se anuncia en todos los lectores).
              Flota sobre el cuerpo: no lo empuja al aparecer ni a los 8 s al irse. */}
          <div className="desk-call" role="status" aria-live="polite" aria-atomic="true">
            <AnimatePresence mode="wait" initial={false}>
              {live.call && (
                <motion.div
                  key={live.call.key}
                  className="desk-call-inner"
                  initial={{ opacity: 0, y: -8, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: DUR.base, ease: EASE_OUT } }}
                  exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: DUR.fast, ease: EASE_IN_OUT } }}
                >
                  <IconBell size={20} />
                  <span className="desk-call-text">{live.call.text}</span>
                  <button type="button" className="desk-call-close" onClick={live.dismissCall}>
                    Cerrar
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="desk-sr" aria-live="polite">
            {live.announce}
          </div>

          <DeskActionsProvider value={api}>
            <div className="desk-body">{layout === "list" ? <DeskList {...faceProps} /> : <DeskFlow {...faceProps} />}</div>
          </DeskActionsProvider>
        </div>
      </div>

      <DeskPayModal
        row={payRow}
        practitionerName={payRow ? practitionerName(payRow.practitionerId) : ""}
        viewer={viewer}
        onClose={closePay}
        onSaved={live.replaceRow}
      />
    </>
  );
}
