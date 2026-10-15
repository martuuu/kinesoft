"use client";

import { useMemo } from "react";
import { fmtMinutes } from "@/lib/reception-view-state";
import { practitionerPulse, type PractitionerPulse } from "@/lib/reception-desk-state";
import type { SalaLive } from "@/components/sala/sala-live-types";

/**
 * Franja de profesionales del escritorio (RX-1b, prototipo `strip()`/`proInfo()`): una tarjeta por profesional con
 * turnos hoy (RX-D9: en el orden de `listPractitioners`), con la demora («Libre», «Al día», «+12'»), qué está
 * haciendo («Con Martín S. · 18'», «Llamó a…», «Espera a…» o la sala del próximo turno) y el progreso del día.
 * Clic = filtrar por ese profesional; otro clic lo saca (`aria-pressed`).
 *
 * La lógica es pura (`practitionerPulse`); acá solo se dibuja. La monta cada cara (RX-2): en A va arriba a todo el
 * ancho, en B a la derecha de la línea de tiempo. El profesional se marca con iniciales (canal no cromático,
 * AGENTS §5); el color de la demora sale de los tokens de estado (`desk-css.ts`).
 *
 * Con muchos profesionales o en una columna, la franja scrollea en horizontal adentro suyo (nunca la página).
 */
export function DeskStrip({
  live,
  proFilter,
  onProFilter,
}: {
  live: Pick<SalaLive, "rows" | "practitioners" | "clock" | "roomById">;
  proFilter: string | null;
  onProFilter: (id: string | null) => void;
}) {
  const pulse = useMemo(
    () => practitionerPulse(live.rows, live.practitioners, live.clock, live.roomById),
    [live.rows, live.practitioners, live.clock, live.roomById]
  );
  if (pulse.length === 0) return null;
  return (
    <section className="desk-strip" aria-label="Profesionales de hoy (tocá uno para filtrar)">
      {pulse.map((p) => (
        <DeskProCard key={p.id} pulse={p} pressed={proFilter === p.id} onClick={() => onProFilter(proFilter === p.id ? null : p.id)} />
      ))}
    </section>
  );
}

/** Texto del chip de demora. */
export function pulseBadge(p: Pick<PractitionerPulse, "status" | "delayMin">): string {
  if (p.status === "free") return "Libre";
  if (p.status === "on-time") return "Al día";
  return `+${fmtMinutes(p.delayMin)}`;
}

function PulseLine({ line, done, total }: Pick<PractitionerPulse, "line" | "done" | "total">) {
  switch (line.kind) {
    case "with":
      return (
        <>
          Con <b>{line.patient}</b> · {fmtMinutes(line.minutes)}
        </>
      );
    case "called":
      return (
        <>
          Llamó a <b>{line.patient}</b>
        </>
      );
    case "waiting-for":
      return (
        <>
          Espera a <b>{line.patient}</b>
        </>
      );
    case "room":
      return <>{line.room}</>;
    case "idle":
      // Sin nadie adentro ni sala asignada: lo único útil es cuánto del día ya pasó.
      return (
        <>
          {done} de {total} terminados
        </>
      );
  }
}

function DeskProCard({ pulse: p, pressed, onClick }: { pulse: PractitionerPulse; pressed: boolean; onClick: () => void }) {
  const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <button type="button" className="desk-pro" aria-pressed={pressed} data-pro={p.id} onClick={onClick}>
      <span className="desk-av" aria-hidden="true">
        {p.initials}
      </span>
      <span className="desk-pro-txt">
        <span className="desk-pro-l1">
          <span className="desk-pro-name">{p.name}</span>
          <span className="desk-delay" data-status={p.status} title={p.status === "late" || p.status === "very-late" ? "Demora estimada" : undefined}>
            {pulseBadge(p)}
          </span>
        </span>
        <span className="desk-pro-l2">
          <PulseLine line={p.line} done={p.done} total={p.total} />
        </span>
      </span>
      <span className="desk-pro-prog" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="desk-sr">
        , {p.done} de {p.total} turnos terminados
      </span>
    </button>
  );
}
