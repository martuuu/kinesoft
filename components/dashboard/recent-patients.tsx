"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import type { DashboardData } from "@/lib/dashboard";
import styles from "./dashboard.module.css";

// PF1.1-dashboard (C-PF2): el menú «⋯» se baja al abrirlo y se precarga en hover/foco del botón.
const loadQuickMenu = () => import("./recent-patient-menu");
const preloadQuickMenu = () => void loadQuickMenu();
const QuickMenu = dynamic(() => loadQuickMenu().then((m) => m.QuickMenu), { ssr: false, loading: () => null });

/**
 * Recent patients widget with a per-row quick-action menu (open HC,
 * confirmar próximo turno, marcar ausente, agendar nuevo turno).
 *
 * A2b-S-vis:
 *  - Filas `access: "basic"` (paciente de otro profesional, sin share): sin
 *    diagnóstico ni progreso, y el menú es de solo lectura (ver ficha + hora
 *    del próximo turno). El servidor igual rechaza cualquier mutación.
 *  - Cambios de estado con optimistic lock (`nextBookingUpdatedAt`): si el
 *    turno cambió desde que se cargó el dashboard, el server devuelve
 *    "stale" y refrescamos en vez de pisar el cambio ajeno.
 *  - `conflict` / `patientOverlap` / `blocked` / `outOfHours` se confirman
 *    con `useConfirm` y se re-llama con el override, igual que el BookingDrawer.
 */
export function RecentPatients({ items, className }: { items: DashboardData["recent"]; className?: string }) {
  return (
    <Card className={className} style={{ padding: 18, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--navy-700)" }}>Pacientes recientes</h2>
          <div style={{ fontSize: 11, color: "var(--navy-400)" }}>
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
          <div style={{ color: "var(--navy-400)", fontSize: 13, padding: 12 }}>
            Todavía no se cargaron sesiones recientes.
          </div>
        )}
        {/* S5: `id` es el del PACIENTE y un paciente con dos sesiones recientes (dos planes) salía dos veces con la
            misma key (aviso de React y filas que se reciclaban mal). */}
        {items.map((p, i) => (
          <RecentRow key={`${p.id}:${i}`} p={p} />
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
          <div className={styles.ellipsis} title={p.name} style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>
            {p.name}
          </div>
          <div className={styles.ellipsis} style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
            {p.access === "basic" ? "Acceso básico" : p.cond || "Sin diagnóstico cargado"}
          </div>
        </div>
        {p.access === "full" && (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div className="k-mono" style={{ fontSize: 11, color: "var(--navy-400)" }}>
              Sesión
            </div>
            <div
              className="k-mono"
              style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}
            >
              {p.sessionsDone} / {p.sessionsTotal}
            </div>
          </div>
        )}
      </Link>

      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        onPointerEnter={preloadQuickMenu}
        onFocus={preloadQuickMenu}
        aria-label={`Acciones rápidas: ${p.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={{
          width: 32,
          height: 32,
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

      {menuOpen && <QuickMenu patient={p} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}

