"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconPlus } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { setBookingStatus, deleteBooking } from "@/lib/bookings";
import { toARDateKey } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import { BookingStatusTag } from "../ui";
import type { PatientBookingFull } from "@/lib/patients-types";

/** Turnos tab columns: Fecha+hora · Servicio · Obra social · Copago · Duración · Estado · acciones. */
const TURNOS_COLS = "120px 1.2fr 1fr 90px 72px 96px 40px";

export function TurnosView({
  patientId,
  bookings,
  loading,
  patchBooking,
  dropBooking,
}: {
  patientId: string;
  bookings: PatientBookingFull[] | null;
  loading: boolean;
  patchBooking: (id: string, partial: Partial<PatientBookingFull>) => void;
  dropBooking: (id: string) => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();

  // "Nuevo turno" opens the agenda's create flow pre-filled with this patient
  // (the /agenda?new=1&patient= deep-link is already handled by AgendaClient).
  const header = (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <Link href={`/agenda?new=1&patient=${patientId}`} style={{ textDecoration: "none" }}>
        <Button variant="primary">
          <IconPlus size={14} /> Nuevo turno
        </Button>
      </Link>
    </div>
  );

  if (loading || bookings === null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {header}
        <Card glass style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Cargando turnos…
        </Card>
      </div>
    );
  }
  if (bookings.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {header}
        <Card style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
          Este paciente no tiene turnos cargados.
        </Card>
      </div>
    );
  }

  // Nearest → farthest: upcoming ascending (soonest first), then past
  // descending (most recent first) so the next turno sits at the top.
  const now = Date.now();
  const sorted = [...bookings].sort((a, b) => {
    const ta = +new Date(a.scheduledFor);
    const tb = +new Date(b.scheduledFor);
    const aUp = ta >= now;
    const bUp = tb >= now;
    if (aUp && bUp) return ta - tb;
    if (!aUp && !bUp) return tb - ta;
    return aUp ? -1 : 1;
  });

  const setStatus = (b: PatientBookingFull, status: PatientBookingFull["status"]) => {
    const prev = b.status;
    patchBooking(b.id, { status });
    start(async () => {
      const r = await setBookingStatus(b.id, status);
      if (!r.ok) {
        patchBooking(b.id, { status: prev });
        toast.error("No pudimos actualizar el turno", { description: r.error });
      }
    });
  };
  const remove = (b: PatientBookingFull) => {
    if (!window.confirm("¿Eliminar este turno? Esta acción es definitiva.")) return;
    dropBooking(b.id);
    start(async () => {
      const r = await deleteBooking(b.id);
      if (!r.ok) toast.error("No pudimos eliminar el turno", { description: r.error });
      else toast.success("Turno eliminado");
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {header}
      <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "12px 18px", display: "grid", gridTemplateColumns: TURNOS_COLS, gap: 14, fontSize: 10, fontWeight: 700, color: "var(--navy-300)", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
        <span>Fecha y hora</span>
        <span>Servicio</span>
        <span>Obra social</span>
        <span>Copago</span>
        <span>Duración</span>
        <span>Estado</span>
        <span />
      </div>
      {sorted.map((b) => {
        const d = new Date(b.scheduledFor);
        const cancelled = b.status === "CANCELLED";
        return (
          <div
            key={b.id}
            style={{ padding: "14px 18px", display: "grid", gridTemplateColumns: TURNOS_COLS, gap: 14, alignItems: "center", fontSize: 13, borderBottom: "1px solid rgba(15,30,51,0.04)", opacity: cancelled ? 0.55 : 1 }}
          >
            <span className="k-mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-700)" }}>
              {d.toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Argentina/Buenos_Aires" })}
            </span>
            <span style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.serviceName}</span>
            <span style={{ color: "var(--navy-500)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.obraSocial.toLowerCase() === "particular" ? "—" : b.obraSocial}
            </span>
            <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)", fontWeight: 600 }}>{formatARS(b.copagoCents)}</span>
            <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>{b.durationMin} min</span>
            <BookingStatusTag status={b.status} />
            <TurnoActionsMenu booking={b} onStatus={(s) => setStatus(b, s)} onDelete={() => remove(b)} disabled={pending} />
          </div>
        );
      })}
      </Card>
    </div>
  );
}

function TurnoActionsMenu({
  booking,
  onStatus,
  onDelete,
  disabled,
}: {
  booking: PatientBookingFull;
  onStatus: (s: PatientBookingFull["status"]) => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dateKey = toARDateKey(new Date(booking.scheduledFor));
  const itemStyle: React.CSSProperties = {
    width: "100%", textAlign: "left", border: "none", background: "transparent", cursor: "pointer",
    fontSize: 12.5, fontWeight: 600, color: "var(--navy-700)", padding: "8px 10px", borderRadius: 8, display: "block",
  };
  const Item = ({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => { setOpen(false); onClick(); }} style={{ ...itemStyle, color: danger ? "#9F1F1F" : "var(--navy-700)" }}>
      {label}
    </button>
  );

  return (
    <div ref={ref} style={{ position: "relative", justifySelf: "end" }}>
      <button
        type="button"
        aria-label="Acciones del turno"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ width: 30, height: 30, borderRadius: 8, border: "none", background: open ? "rgba(15,30,51,0.06)" : "transparent", cursor: "pointer", color: "var(--navy-500)", fontSize: 18, lineHeight: 1, fontWeight: 700 }}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="k-glass-strong" style={{ position: "absolute", top: 32, right: 0, width: 190, borderRadius: 12, padding: 6, zIndex: 30, display: "grid", gap: 2 }}>
          <Item label="Confirmar" onClick={() => onStatus("CONFIRMED")} />
          <Item label="Marcar hecho" onClick={() => onStatus("COMPLETED")} />
          <Item label="Marcar ausente" onClick={() => onStatus("NO_SHOW")} />
          <Item label="Cancelar turno" onClick={() => onStatus("CANCELLED")} />
          <Link href={`/agenda?view=timeline&date=${dateKey}`} style={itemStyle} onClick={() => setOpen(false)}>
            Abrir en agenda
          </Link>
          <div style={{ height: 1, background: "rgba(15,30,51,0.08)", margin: "2px 0" }} />
          <Item label="Eliminar" onClick={onDelete} danger />
        </div>
      )}
    </div>
  );
}
