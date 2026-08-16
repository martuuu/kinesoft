"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications";
import type { NotificationRow } from "@/lib/notifications-types";
import { IconBell, IconCheck } from "@/components/ui/icons";

/**
 * Notification bell + dropdown.
 *
 * Lazy: only hits the server once the dropdown opens, then keeps a small
 * in-memory cache (refreshes on each open). Optimistic on mark-read so
 * the badge updates immediately.
 */
export function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pending, start] = useTransition();
  const popRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // Initial unread count.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await listNotifications(0); // 0 → only fetch count, but our impl still returns rows; cheap enough
      if (cancelled) return;
      setUnread(data.unread);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh on open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const data = await listNotifications(20);
      if (cancelled) return;
      setRows(data.rows);
      setUnread(data.unread);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

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
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onRowClick = (row: NotificationRow) => {
    if (!row.readAt) {
      // Optimistic — snapshot the prior state so we can roll back if the
      // server action fails (e.g. session lost, RPC 401).
      const prevRows = rows;
      const prevUnread = unread;
      setRows((s) => s.map((r) => (r.id === row.id ? { ...r, readAt: new Date() } : r)));
      setUnread((n) => Math.max(0, n - 1));
      start(async () => {
        const r = await markNotificationRead(row.id);
        if (!r.ok) {
          // Rollback.
          setRows(prevRows);
          setUnread(prevUnread);
        }
      });
    }
    if (row.link) {
      setOpen(false);
      router.push(row.link);
    }
  };

  const onMarkAll = () => {
    const prevRows = rows;
    const prevUnread = unread;
    setRows((s) => s.map((r) => (r.readAt ? r : { ...r, readAt: new Date() })));
    setUnread(0);
    start(async () => {
      const r = await markAllNotificationsRead();
      if (!r.ok) {
        setRows(prevRows);
        setUnread(prevUnread);
      }
    });
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notificaciones"
        aria-haspopup="true"
        aria-expanded={open}
        className="k-glass"
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

      <AnimatePresence>
        {open && (
        <motion.div
          ref={popRef}
          role="dialog"
          aria-label="Notificaciones"
          className="k-glass-strong"
          initial={{ opacity: 0, scale: 0.96, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -4 }}
          transition={{ duration: DUR.fast, ease: EASE_OUT }}
          style={{
            position: "absolute",
            top: 44,
            right: 0,
            width: 340,
            maxHeight: 420,
            overflowY: "auto",
            borderRadius: 16,
            padding: 12,
            zIndex: 30,
            transformOrigin: "top right",
          }}
        >
          <header
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
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
              <button
                type="button"
                onClick={onMarkAll}
                disabled={pending}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--sky-700)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Marcar todas como leídas
              </button>
            )}
          </header>

          {!loaded ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--navy-300)", fontSize: 12 }}>
              Cargando…
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--navy-300)", fontSize: 12 }}>
              No tenés notificaciones todavía.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {rows.map((r) => (
                <NotificationItem key={r.id} row={r} onClick={() => onRowClick(r)} />
              ))}
            </div>
          )}
        </motion.div>
        )}
      </AnimatePresence>
    </div>
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
