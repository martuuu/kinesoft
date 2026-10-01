"use client";

import { formatDateAR } from "@/lib/format";
import { recordatorioHtml } from "@/components/agenda/recordatorio-turno";
import { miniGhostBtn, sectionCard } from "./styles";
import type { DrawerBooking } from "./types";

/**
 * Sección "Compartir": recordatorio por WhatsApp e imprimible / PDF. Solo lee
 * el turno; se muestra también con acceso básico.
 */
export function ShareActions({ booking }: { booking: DrawerBooking }) {
  // Recordatorio imprimible / PDF — abre una ventana nueva con el HTML
  // autocontenido y dispara el diálogo de impresión del navegador (que
  // ofrece "Guardar como PDF"). Evitamos `window.print()` sobre la página
  // actual para no imprimir toda la app.
  const printRecordatorio = () => {
    const w = window.open("", "_blank", "width=480,height=640");
    if (w) {
      w.document.write(recordatorioHtml(booking));
      w.document.close();
      w.focus();
      w.print();
    }
  };

  return (
    <div style={{ ...sectionCard, display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gap: 2 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--navy-300)",
          }}
        >
          Compartir
        </div>
        <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
          Enviale al paciente un recordatorio de este turno.
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(
            `Hola ${booking.patientName}, te recordamos tu turno para ${booking.serviceName} el ${formatDateAR(
              booking.scheduledFor,
              "longDateTime"
            )} (duración ${booking.durationMin} min). ¡Te esperamos!`
          )}`}
          target="_blank"
          rel="noopener"
          style={{
            ...miniGhostBtn,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            textDecoration: "none",
          }}
        >
          Compartir por WhatsApp
        </a>
        <button
          type="button"
          onClick={printRecordatorio}
          style={{ ...miniGhostBtn, display: "inline-flex", alignItems: "center", gap: 6 }}
          title="Abre el recordatorio en una ventana para imprimir o guardar como PDF"
        >
          Imprimir / Guardar PDF
        </button>
      </div>
    </div>
  );
}
