"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { NotificationRow } from "@/lib/notifications-types";
import { IconCheck } from "@/components/ui/icons";
import { bellFooter, type BellFeedState } from "@/lib/notifications-live";

/**
 * [CF2-ZF4] Contenido del desplegable de la campana, fuera del módulo de la campana a propósito: la campana está en el
 * layout `(app)` (first load de TODAS las rutas del equipo) y el panel solo existe abierto. Con el panel adentro, CF2
 * dejó `/agenda` en 180,2 de 180 kB. Lo baja `notifications-bell.tsx` con `import()` en cuanto la campana visible
 * arranca (en un idle, después del primer pintado) y, por las dudas, al pasar el puntero, enfocar o tocar el botón:
 * al abrir ya está. Si se abre antes de que llegue la red, la campana dibuja el mismo «Cargando…» del panel.
 */
/** Filas que entran sin scroll en el alto nuevo (~74 px por fila): hasta acá no se muestra el desvanecido inicial. */
const BELL_FOLD = 6;

const quietLink: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--sky-700)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
};

/** [ZF3] B19: «Marcar todas como leídas» y «Ver anteriores» se tocan con el pulgar: 44 px de alto como mínimo. */
const quietAction: CSSProperties = { ...quietLink, padding: "8px 10px", minHeight: 44 };

/**
 * Contenido del panel (cabecera, lista con scroll y pie). Exportado para el render test [CF-F1]: el panel de la campana
 * solo existe abierto, y los render tests no corren effects ni clicks.
 */
export function NotificationsPanel({
  state,
  pending = false,
  onRow,
  onMarkAll,
  onMore,
  onRetry,
}: {
  state: BellFeedState<NotificationRow>;
  pending?: boolean;
  onRow: (row: NotificationRow) => void;
  onMarkAll: () => void;
  onMore: () => void;
  onRetry: () => void;
}) {
  const { rows, unread, status, limit } = state;
  const listRef = useRef<HTMLDivElement | null>(null);
  // Desvanecido abajo mientras quede lista por scrollear (en macOS la barra de scroll no se ve hasta que se scrollea).
  const [atEnd, setAtEnd] = useState(rows.length <= BELL_FOLD);
  const measure = () => {
    const el = listRef.current;
    if (el) setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 4);
  };
  useEffect(measure, [rows.length]);
  const footer = bellFooter(rows.length, limit);
  const showRows = rows.length > 0;

  return (
    <>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--navy-500)",
          }}
        >
          Notificaciones {unread > 0 && <span style={{ color: "var(--sky-700)" }}>· {unread} sin leer</span>}
        </div>
        {unread > 0 && (
          <button type="button" onClick={onMarkAll} disabled={pending} style={quietAction}>
            Marcar todas como leídas
          </button>
        )}
      </header>

      {!showRows && (status === "idle" || status === "loading") ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--navy-300)", fontSize: 12 }}>Cargando…</div>
      ) : !showRows && status === "error" ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--navy-500)", fontSize: 12 }}>
          No pudimos cargar las notificaciones.{" "}
          <button type="button" onClick={onRetry} style={quietLink}>
            Reintentar
          </button>
        </div>
      ) : !showRows ? (
        <div style={{ padding: 20, textAlign: "center", color: "var(--navy-300)", fontSize: 12 }}>
          No tenés notificaciones todavía.
        </div>
      ) : (
        <div
          ref={listRef}
          onScroll={measure}
          data-bell-list=""
          style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}
        >
          {rows.map((r) => (
            <NotificationItem key={r.id} row={r} onClick={() => onRow(r)} />
          ))}
          {!atEnd && (
            <div
              aria-hidden
              data-bell-more=""
              style={{
                position: "sticky",
                bottom: 0,
                flexShrink: 0,
                height: 32,
                marginTop: -32,
                pointerEvents: "none",
                background: "linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,0.92))",
              }}
            />
          )}
        </div>
      )}

      {footer && (
        <footer
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid rgba(15,30,51,0.08)",
            fontSize: 11,
            color: "var(--navy-500)",
          }}
        >
          <span>
            {footer.label}
            {!atEnd && " · deslizá para ver más"}
          </span>
          {footer.canLoadMore && (
            <button type="button" onClick={onMore} disabled={status === "loading"} style={quietAction}>
              Ver anteriores
            </button>
          )}
        </footer>
      )}
    </>
  );
}

function NotificationItem({
  row,
  onClick,
}: {
  row: NotificationRow;
  onClick: () => void;
}) {
  const fmt = row.createdAt.toLocaleString("es-AR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid rgba(15,30,51,0.06)",
        background: row.readAt ? "rgba(255,255,255,0.5)" : "rgba(31,79,190,0.05)",
        cursor: "pointer",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          marginTop: 6,
          background: row.readAt ? "rgba(15,30,51,0.18)" : "var(--lime-400)",
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>{row.title}</div>
        {row.body && (
          <div style={{ fontSize: 11.5, color: "var(--navy-500)", lineHeight: 1.4, marginTop: 2 }}>
            {row.body}
          </div>
        )}
        <div className="k-mono" style={{ fontSize: 10, color: "var(--navy-300)", marginTop: 4 }}>
          {fmt}
        </div>
      </div>
      {row.readAt && <IconCheck size={11} stroke={3} />}
    </button>
  );
}
