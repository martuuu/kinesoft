"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications";
import type { NotificationRow } from "@/lib/notifications-types";
import { IconBell } from "@/components/ui/icons";
import { useRealtime } from "@/components/providers/realtime-provider";
import {
  BELL_PAGE,
  BELL_VIEWPORT_QUERY,
  bellIsShown,
  createBellFeed,
  createBellGate,
  createBellLive,
  type BellFeedState,
} from "@/lib/notifications-live";
import dash from "./dashboard.module.css";

/**
 * [CF2-ZF4] El contenido del desplegable (`NotificationsPanel`) baja aparte (`./notifications-panel`): la campana va en
 * el first load de todas las rutas del equipo y el panel solo se ve abierto. Mismo patrón que el panel de «Vista» de la
 * agenda (`view-options-menu.tsx`, T3a-0z3): cargado, queda en `panelModule` y se dibuja directo (sin `React.lazy`,
 * que volvería a suspender un tick en cada apertura). Se pide en un idle apenas la campana visible arranca, y al pasar
 * el puntero / enfocar / tocar el botón: en la práctica, al abrir ya está.
 */
let panelModule: typeof import("./notifications-panel") | undefined;
let panelLoad: Promise<typeof import("./notifications-panel")> | undefined;
function loadPanel() {
  panelLoad ??= import("./notifications-panel").then(
    (m) => (panelModule = m),
    (err) => {
      // Un chunk que falló (red, deploy nuevo) se vuelve a pedir en la próxima apertura.
      panelLoad = undefined;
      throw err;
    }
  );
  return panelLoad;
}
const preloadPanel = () => void loadPanel().catch(() => {});

/**
 * Notification bell + dropdown.
 *
 * Optimistic on mark-read so the badge updates immediately.
 *
 * [AS-0c] En vivo: el contador se re-pide cada 60 s con la pestaña visible, al volver el foco y con cada lote de la
 * agenda en vivo (`createBellLive`). Con el desplegable abierto se re-piden también las filas. Fuera del
 * `RealtimeProvider` (`useRealtime` devuelve el valor apagado) queda solo el polling.
 *
 * [CF-F] CF-NOT (§28): filas, contador y estados los maneja `createBellFeed` (lib/notifications-live.ts, con su test):
 * con el desplegable cerrado, si cambia el contador se re-piden también las filas; el «Cargando…» ya no se traba
 * cuando un poll pisa la apertura y un error de red muestra «Reintentar». El panel es más alto, tiene pie con cuántas
 * hay, desvanecido abajo mientras queden filas por scrollear y «Ver anteriores» (hasta 50).
 *
 * `placement`: «below» (barra superior y dashboard: el panel cae debajo, alineado a la derecha), «side» (barra lateral:
 * sale a la derecha del botón por portal con `position: fixed`; dentro del `<aside>` sticky quedaría recortado o
 * debajo del contenido de la página) o «bar» (barra móvil, [ZF3]: por portal, debajo de la barra y pegado al borde
 * derecho con 16 px; anclado al botón se salía por la izquierda a 390 px porque el avatar queda a su derecha, y la
 * barra es `k-glass`: su `backdrop-filter` haría de caja del `fixed`).
 *
 * [ZF3] A1: solo la campana VISIBLE pide (`createBellGate`, lib/notifications-live.ts). El shell monta una por chrome
 * de escritorio y otra en la barra móvil, todas en el HTML; la oculta no arranca su feed.
 * [ZF3] M9: al abrir, el foco pasa al primer control del panel; Escape cierra y lo devuelve al botón.
 */
export function NotificationsBell({ placement = "below" }: { placement?: "below" | "side" | "bar" } = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [feedState, setFeedState] = useState<BellFeedState<NotificationRow>>({
    rows: [],
    unread: 0,
    status: "idle",
    limit: BELL_PAGE,
  });
  const { rows, unread } = feedState;
  const [pending, start] = useTransition();
  const [anchor, setAnchor] = useState<{ top: number; left?: number; right?: number } | null>(null);
  // [ZF3] A1: false hasta medir (server y primer render): ninguna campana pide antes de saber si se ve.
  const [shown, setShown] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const feedRef = useRef<ReturnType<typeof createBellFeed<NotificationRow>> | null>(null);

  const { subscribe } = useRealtime();
  // [CF2-ZF4] Re-render cuando llega el chunk del panel (si se abrió antes de que estuviera).
  const [, setPanelReady] = useState(Boolean(panelModule));

  // [ZF3] A1: ¿se ve esta campana? Se vuelve a mirar al cruzar los 768 px (un frame después, con el CSS ya aplicado).
  useEffect(() => {
    const gate = createBellGate({
      isShown: () => bellIsShown(btnRef.current),
      watch: (recheck) => {
        const mq = typeof window.matchMedia === "function" ? window.matchMedia(BELL_VIEWPORT_QUERY) : null;
        if (!mq) return () => {};
        const onChange = () => requestAnimationFrame(recheck);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
      },
      onActive: (v) => {
        setShown(v);
        if (!v) setOpen(false);
      },
    });
    return () => gate.stop();
  }, []);

  // Contador inicial + campana en vivo (AS-0c). Solo la campana visible (A1).
  useEffect(() => {
    if (!shown) return;
    const feed = createBellFeed<NotificationRow>({
      fetchRows: (limit) => listNotifications(limit),
      fetchCount: () => countUnreadNotifications(),
      onChange: setFeedState,
    });
    feedRef.current = feed;
    feed.refresh();
    const live = createBellLive({ refresh: () => feed.refresh(), isVisible: () => document.visibilityState !== "hidden" });
    live.start();
    const onVis = () => live.handleVisibility(document.visibilityState !== "hidden");
    const onFocus = () => live.handleFocus();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    const unsub = subscribe(() => live.handleRealtime());
    return () => {
      feed.stop();
      feedRef.current = null;
      live.stop();
      unsub();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }, [subscribe, shown]);

  // Refresh on open.
  useEffect(() => {
    feedRef.current?.setOpen(open);
  }, [open]);

  // [CF2-ZF4] El panel: en un idle apenas la campana se ve, y sí o sí al abrir.
  useEffect(() => {
    if (panelModule || (!shown && !open)) return;
    let alive = true;
    const go = () =>
      void loadPanel().then(
        () => alive && setPanelReady(true),
        () => {}
      );
    if (open) {
      go();
      return () => {
        alive = false;
      };
    }
    const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback : null;
    const id = ric ? ric(go, { timeout: 4000 }) : window.setTimeout(go, 1500);
    return () => {
      alive = false;
      if (ric) window.cancelIdleCallback(id);
      else window.clearTimeout(id);
    };
  }, [shown, open]);

  // «side»: posición fija al lado del botón, medida al abrir (el sidebar es sticky: no se mueve con el scroll).
  useEffect(() => {
    if (!open || placement === "below" || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setAnchor(placement === "side" ? { top: r.top, left: r.right + 12 } : { top: r.bottom + 8, right: 16 });
  }, [open, placement]);

  // [ZF3] M9: al abrir, foco al primer control del panel (el panel aparece por AnimatePresence, o tras medir el
  // ancla: se espera al frame siguiente). Sin controles todavía («Cargando…»), al panel mismo (tabIndex -1).
  const portaled = placement !== "below";
  useEffect(() => {
    if (!open || (portaled && !anchor)) return;
    const raf = requestAnimationFrame(() => {
      const pop = popRef.current;
      if (!pop) return;
      const first = pop.querySelector<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
      (first ?? pop).focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, portaled, anchor]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current && !popRef.current.contains(t) && btnRef.current && !btnRef.current.contains(t)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // M9: el foco vuelve a la campana (si no, queda en el panel que se desmonta y salta al <body>).
      btnRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onRowClick = (row: NotificationRow) => {
    const feed = feedRef.current;
    if (!row.readAt && feed) {
      // Optimistic — snapshot the prior state so we can roll back if the
      // server action fails (e.g. session lost, RPC 401).
      const prevRows = rows;
      const prevUnread = unread;
      feed.patch((s) => ({
        rows: s.rows.map((r) => (r.id === row.id ? { ...r, readAt: new Date() } : r)),
        unread: Math.max(0, s.unread - 1),
      }));
      start(async () => {
        const r = await markNotificationRead(row.id).catch(() => ({ ok: false as const }));
        if (!r.ok) feed.patch(() => ({ rows: prevRows, unread: prevUnread }));
      });
    }
    if (row.link) {
      setOpen(false);
      router.push(row.link);
    }
  };

  const onMarkAll = () => {
    const feed = feedRef.current;
    if (!feed) return;
    const prevRows = rows;
    const prevUnread = unread;
    feed.patch((s) => ({ rows: s.rows.map((r) => (r.readAt ? r : { ...r, readAt: new Date() })), unread: 0 }));
    start(async () => {
      const r = await markAllNotificationsRead().catch(() => ({ ok: false as const }));
      if (!r.ok) feed.patch(() => ({ rows: prevRows, unread: prevUnread }));
    });
  };

  const side = placement === "side";
  const popover = (
    <AnimatePresence>
      {open && (!portaled || anchor) && (
        <m.div
          ref={popRef}
          role="dialog"
          aria-label="Notificaciones"
          tabIndex={-1}
          className="k-glass-strong"
          initial={{ opacity: 0, scale: 0.96, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -4 }}
          transition={{ duration: DUR.fast, ease: EASE_OUT }}
          style={{
            ...(side && anchor
              ? {
                  position: "fixed",
                  top: anchor.top,
                  left: anchor.left,
                  // El panel no se sale por abajo aunque la campana quede baja en una pantalla chica.
                  maxHeight: `min(560px, calc(100vh - ${Math.round(anchor.top) + 16}px))`,
                  zIndex: 40,
                  transformOrigin: "top left",
                }
              : portaled && anchor
                ? {
                    position: "fixed",
                    top: anchor.top,
                    right: anchor.right,
                    maxHeight: `min(560px, calc(100dvh - ${Math.round(anchor.top) + 16}px - var(--k-bottom-nav-h, 0px)))`,
                    zIndex: 40,
                    transformOrigin: "top right",
                  }
                : {
                  position: "absolute",
                  top: 44,
                  right: 0,
                  // [CF-F1] Antes 420 px: entraban ~4,9 filas.
                  maxHeight: "min(560px, 70vh)",
                  zIndex: 30,
                  transformOrigin: "top right",
                }),
            // PF1.0-a (clase A mobile): a 390 px un ancho fijo de 340 anclado a la derecha se salía por la izquierda.
            width: "min(340px, calc(100vw - 32px))",
            display: "flex",
            flexDirection: "column",
            borderRadius: 16,
            padding: 12,
          }}
        >
          {panelModule ? (
            <panelModule.NotificationsPanel
              state={feedState}
              pending={pending}
              onRow={onRowClick}
              onMarkAll={onMarkAll}
              onMore={() => feedRef.current?.loadMore()}
              onRetry={() => feedRef.current?.retry()}
            />
          ) : (
            // Lo mismo que el panel muestra mientras carga (sin el chunk todavía no hay filas que dibujar).
            <div style={{ padding: 20, textAlign: "center", color: "var(--navy-300)", fontSize: 12 }}>Cargando…</div>
          )}
        </m.div>
      )}
    </AnimatePresence>
  );

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onPointerEnter={preloadPanel}
        onPointerDown={preloadPanel}
        onFocus={preloadPanel}
        aria-label="Notificaciones"
        aria-haspopup="true"
        aria-expanded={open}
        // MB-1d: `.tap` = 44 px de área táctil < 768.
        className={`k-glass ${dash.tap}`}
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--navy-700)",
          position: "relative",
          border: "none",
          cursor: "pointer",
        }}
      >
        <IconBell size={16} />
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: 4,
              right: 6,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 8,
              background: "var(--lime-400)",
              color: "var(--navy-900)",
              fontSize: 9,
              fontWeight: 800,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid rgba(255,255,255,0.85)",
              boxSizing: "content-box",
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {portaled ? (typeof document !== "undefined" ? createPortal(popover, document.body) : null) : popover}
    </div>
  );
}
