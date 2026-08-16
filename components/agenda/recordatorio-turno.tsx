/**
 * Recordatorio de turno — genera un documento HTML autocontenido y sobrio
 * (CSS inline, pensado para A5 / impresión) que el kine puede imprimir o
 * guardar como PDF desde el navegador para entregarle al paciente.
 *
 * Cero dependencias: se abre en una ventana nueva y se auto-imprime, así el
 * propio navegador ofrece "Guardar como PDF". No usa IA ni librerías.
 */

/** Shape mínimo que consume el recordatorio. Compatible estructuralmente
 *  con el `BookingDTO` del drawer (no se exporta, así que definimos lo
 *  justo que necesitamos). */
export type RecordatorioBooking = {
  patientName: string;
  serviceName: string;
  serviceColor: string | null;
  /** ISO string. */
  scheduledFor: string;
  durationMin: number;
  title: string | null;
  description: string | null;
};

/** Escape HTML para que texto libre (paciente, servicio, diagnóstico) no
 *  rompa el documento ni permita inyección de markup. */
function esc(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Fecha + hora en horario de Argentina, formateada inline. */
function fechaAR(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Devuelve el documento HTML completo del recordatorio. Se escribe tal cual
 * en `window.open(...).document.write(...)`.
 */
export function recordatorioHtml(booking: RecordatorioBooking): string {
  const color = booking.serviceColor || "#1F4FBE";
  const fecha = fechaAR(booking.scheduledFor);

  const diagnosticoRows =
    booking.title || booking.description
      ? `
        <div class="section">
          <div class="section-title">Diagnóstico</div>
          ${booking.title ? `<div class="value strong">${esc(booking.title)}</div>` : ""}
          ${booking.description ? `<div class="value muted">${esc(booking.description)}</div>` : ""}
        </div>`
      : "";

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Recordatorio de turno</title>
<style>
  @page { size: A5; margin: 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #0F1E33;
    background: #fff;
    padding: 24px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet { max-width: 420px; margin: 0 auto; }
  .header {
    padding-bottom: 14px;
    margin-bottom: 18px;
    border-bottom: 2px solid rgba(15,30,51,0.1);
  }
  .kicker {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #6B7A90;
  }
  .title { font-size: 20px; font-weight: 700; margin-top: 4px; color: #0F1E33; }
  .patient { font-size: 15px; font-weight: 600; margin: 18px 0 20px; }
  .patient .muted { color: #6B7A90; font-weight: 500; }
  .section { margin-bottom: 14px; }
  .section-title {
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #8A97A8;
    margin-bottom: 3px;
  }
  .value { font-size: 13.5px; color: #0F1E33; }
  .value.strong { font-weight: 600; }
  .value.muted { color: #4A5A70; }
  .service { display: inline-flex; align-items: center; gap: 8px; }
  .dot {
    width: 10px; height: 10px; border-radius: 999px;
    background: ${esc(color)}; flex-shrink: 0;
    display: inline-block;
  }
  .footer {
    margin-top: 24px;
    padding-top: 12px;
    border-top: 1px solid rgba(15,30,51,0.08);
    font-size: 11px;
    color: #8A97A8;
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="header">
      <div class="kicker">Recordatorio de turno</div>
      <div class="title">Te esperamos</div>
    </div>

    <div class="patient">
      <span class="muted">Paciente:</span> ${esc(booking.patientName)}
    </div>

    <div class="section">
      <div class="section-title">Servicio</div>
      <div class="value service"><span class="dot"></span>${esc(booking.serviceName)}</div>
    </div>

    <div class="section">
      <div class="section-title">Fecha y hora</div>
      <div class="value strong">${esc(fecha)}</div>
    </div>

    <div class="section">
      <div class="section-title">Duración</div>
      <div class="value">${booking.durationMin} min</div>
    </div>
${diagnosticoRows}
    <div class="footer">Ante cualquier cambio, comunicate con nosotros. ¡Gracias!</div>
  </div>
</body>
</html>`;
}
