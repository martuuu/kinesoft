"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { IconArrow, IconCheck, IconPlus } from "@/components/ui/icons";
import { setBookingStatus } from "@/lib/bookings";
import type { DashboardData } from "@/lib/dashboard";

/**
 * Recent patients widget with a per-row quick-action menu (open HC,
 * confirmar próximo turno, marcar ausente, agendar nuevo turno).
 */
export function RecentPatients({ items }: { items: DashboardData["recent"] }) {
  return (
    <Card style={{ padding: 18, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-700)" }}>
            Pacientes recientes
          </div>
          <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
            Últimas sesiones registradas
          </div>
        </div>
        <Link
          href="/pacientes"
          style={{ fontSize: 12, color: "var(--sky-700)", fontWeight: 600, textDecoration: "none" }}
        >
          Ver todos →
        </Link>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
        {items.length === 0 && (
          <div style={{ color: "var(--navy-300)", fontSize: 13, padding: 12 }}>
            Todavía no se cargaron sesiones recientes.
          </div>
        )}
        {items.map((p) => (
          <RecentRow key={p.id} p={p} />
        ))}
      </div>
    </Card>
  );
}

function RecentRow({ p }: { p: DashboardData["recent"][number] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 10px",
        borderRadius: 12,
        background: "rgba(246,249,253,0.7)",
      }}
    >
      <Link
        href={`/pacientes/${p.id}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flex: 1,
          minWidth: 0,
          textDecoration: "none",
          color: "inherit",
        }}
      >
        <Avatar name={p.name} size={36} tone="sky" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{p.name}</div>
          <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{p.cond}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="k-mono" style={{ fontSize: 11, color: "var(--navy-300)" }}>
            Sesión
          </div>
          <div
            className="k-mono"
            style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}
          >
            {p.sessionsDone} / {p.sessionsTotal}
          </div>
        </div>
      </Link>

      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Acciones rápidas"
        aria-haspopup="true"
        aria-expanded={menuOpen}
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          border: "none",
          background: menuOpen ? "rgba(31,79,190,0.1)" : "transparent",
          color: "var(--navy-500)",
          cursor: "pointer",
          fontSize: 16,
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        ⋯
      </button>

      <AnimatePresence>
        {menuOpen && (
          <QuickMenu patient={p} onClose={() => setMenuOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

function QuickMenu({
  patient,
  onClose,
}: {
  patient: DashboardData["recent"][number];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setStatus = (status: "CONFIRMED" | "COMPLETED" | "NO_SHOW") => {
    if (!patient.nextBookingId) return;
    setError(null);
    start(async () => {
      const r = await setBookingStatus(patient.nextBookingId!, status);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <motion.div
      role="menu"
      className="k-glass-strong"
      initial={{ opacity: 0, scale: 0.96, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: -4 }}
      transition={{ duration: DUR.fast, ease: EASE_OUT }}
      style={{
        position: "absolute",
        top: 44,
        right: 6,
        width: 220,
        borderRadius: 12,
        padding: 6,
        zIndex: 25,
        transformOrigin: "top right",
      }}
    >
      <MenuLink
        href={`/pacientes/${patient.id}`}
        icon={<IconArrow size={12} />}
        label="Abrir historia clínica"
      />
      {patient.nextBookingAt && (
        <>
          <Divider />
          <div
            style={{
              padding: "8px 12px",
              fontSize: 10.5,
              color: "var(--navy-300)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            Próximo turno · {patient.nextBookingAt.toLocaleString("es-AR", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "America/Argentina/Buenos_Aires",
            })}
          </div>
          <MenuButton
            disabled={pending}
            icon={<IconCheck size={12} stroke={3} />}
            label="Marcar realizado"
            onClick={() => setStatus("COMPLETED")}
          />
          <MenuButton
            disabled={pending}
            icon={<span style={{ color: "#9F1F1F", fontWeight: 700 }}>✕</span>}
            label="Marcar ausente"
            onClick={() => setStatus("NO_SHOW")}
          />
        </>
      )}
      <Divider />
      <MenuLink
        href={`/agenda?new=1&patient=${patient.id}`}
        icon={<IconPlus size={12} />}
        label="Nuevo turno"
      />
      {error && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11,
            color: "#9F1F1F",
          }}
        >
          {error}
        </div>
      )}
    </motion.div>
  );
}

function MenuLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 12px",
        borderRadius: 8,
        fontSize: 13,
        color: "var(--navy-700)",
        textDecoration: "none",
        fontWeight: 500,
      }}
    >
      {icon} {label}
    </Link>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 12px",
        borderRadius: 8,
        fontSize: 13,
        color: "var(--navy-700)",
        background: "transparent",
        border: "none",
        fontWeight: 500,
        cursor: disabled ? "wait" : "pointer",
        textAlign: "left",
      }}
    >
      {icon} {label}
    </button>
  );
}

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "rgba(15,30,51,0.06)",
        margin: "4px 0",
      }}
    />
  );
}
