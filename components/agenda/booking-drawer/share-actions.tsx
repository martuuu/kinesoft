"use client";

import { useEffect, useState } from "react";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { recordatorioHtml } from "@/components/agenda/recordatorio-turno";
import { useToast } from "@/components/ui/toast";
import { bookingReminderText, bookingShareUrl, shareNotice, type ShareContact } from "@/lib/booking-share";
import { miniGhostBtn, sectionCard } from "./styles";
import type { DrawerBooking } from "./types";

/**
 * Sección "Compartir": recordatorio por WhatsApp e imprimible / PDF. Solo lee
 * el turno; se muestra también con acceso básico.
 *
 * WA-0 (§21.6): el link de WhatsApp va al celular del paciente cuando el actor ve su contacto (lo decide el server en
 * `getPatientShareContact`: `full` y `admin`; la fila del drawer manda `admin` como "basic", por eso no alcanza con
 * `booking.patientAccess`). Si lo ve y no es un celular válido, aviso + el link sin destinatario de antes. «Copiar
 * mensaje» sirve para pegarlo en otro canal (o en WhatsApp Web, cuando el link no abre la app).
 */
export function ShareActions({ booking }: { booking: DrawerBooking }) {
  // EV1-C1: en Clínica general la sección del recordatorio dice «Motivo».
  const diagnostico = useTenantModules().has("diagnostico");
  const toast = useToast();
  const patientId = booking.patientId;
  // Sin paciente (turno guest) o con `none` no hay número que buscar: no se llama al server.
  const lookup = Boolean(patientId) && booking.patientAccess !== "none";
  const [contact, setContact] = useState<{ patientId: string; value: ShareContact } | null>(null);

  useEffect(() => {
    if (!lookup || !patientId) return;
    let alive = true;
    // Import diferido: la action arrastra `lib/session` (React `cache`) y el drawer solo la necesita al abrir un turno
    // con paciente; así tampoco suma al chunk del drawer.
    import("@/lib/booking-share-actions")
      .then((m) => m.getPatientShareContact(patientId))
      .then((value) => alive && setContact({ patientId, value }))
      // Sesión vencida o red caída: el link queda sin destinatario, como antes de WA-0. Sin toast: no es un error de
      // lo que la persona hizo, y el botón sigue andando.
      .catch(() => alive && setContact({ patientId, value: { status: "hidden" } }));
    return () => {
      alive = false;
    };
  }, [lookup, patientId]);

  // El contacto de OTRO turno (el drawer reusa el componente al cambiar de turno) no vale para este.
  const current = lookup && contact?.patientId === patientId ? contact.value : null;
  const loading = lookup && current === null;
  const notice = shareNotice(current);
  const href = bookingShareUrl(booking, current);

  // Recordatorio imprimible / PDF — abre una ventana nueva con el HTML
  // autocontenido y dispara el diálogo de impresión del navegador (que
  // ofrece "Guardar como PDF"). Evitamos `window.print()` sobre la página
  // actual para no imprimir toda la app.
  const printRecordatorio = () => {
    const w = window.open("", "_blank", "width=480,height=640");
    if (w) {
      w.document.write(recordatorioHtml(booking, { diagnostico }));
      w.document.close();
      w.focus();
      w.print();
    }
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(bookingReminderText(booking));
      toast.success("Mensaje copiado");
    } catch {
      // Sin permiso de portapapeles (http, iframe, Safari viejo).
      toast.error("No pudimos copiar el mensaje", { description: "Usá «Compartir por WhatsApp» o copialo a mano." });
    }
  };

  const btn = { ...miniGhostBtn, display: "inline-flex", alignItems: "center", gap: 6 } as const;

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
      {notice && (
        <div
          role="status"
          style={{
            display: "grid",
            gap: 2,
            padding: "8px 10px",
            borderRadius: 10,
            background: "var(--warn-bg)",
            border: "1px solid var(--warn-border)",
            color: "var(--warn-fg)",
            fontSize: 11.5,
          }}
        >
          <strong style={{ fontWeight: 650 }}>{notice.title}</strong>
          <span>{notice.detail}</span>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <a
          href={href}
          target="_blank"
          rel="noopener"
          aria-disabled={loading || undefined}
          // Mientras se busca el número (una lectura chica), un click saldría sin destinatario: se espera.
          onClick={(e) => loading && e.preventDefault()}
          style={{ ...btn, textDecoration: "none", opacity: loading ? 0.6 : 1, cursor: loading ? "progress" : "pointer" }}
        >
          Compartir por WhatsApp
        </a>
        <button type="button" onClick={copyMessage} style={btn}>
          Copiar mensaje
        </button>
        <button
          type="button"
          onClick={printRecordatorio}
          style={btn}
          title="Abre el recordatorio en una ventana para imprimir o guardar como PDF"
        >
          Imprimir / Guardar PDF
        </button>
      </div>
    </div>
  );
}
