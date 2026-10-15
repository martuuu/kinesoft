import { Card } from "@/components/ui/card";
import { EyebrowLabel } from "@/components/ui/eyebrow";

/**
 * Configuración → «Exportar datos» (BO5-C, plan §19.5; BO-D4). Solo para el OWNER: el export completo es la vía
 * más corta para sacar toda la PHI del consultorio y llevársela es decisión del titular (ADMIN no lo ve; la ruta
 * igual lo rechaza con 403, esto es UX).
 *
 * Sin estado ni actions: el botón es un link de descarga a `GET /api/consultorio/export` (OWNER, 3 por hora por
 * consultorio, soporte → 403). Es un `<a download>` y no un `fetch`: el navegador baja el archivo en streaming sin
 * cargarlo entero en la memoria de la pestaña. `tenantId` va en la URL solo cuando el que lo monta lo pasa (p. ej.
 * /suspendido, donde no hay consultorio activo).
 *
 * Lo que incluye y lo que no sale de `EXPORT_FIELDS` (lib/tenant-export-logic.ts); si cambia allá, cambia acá.
 */
export const EXPORT_ROUTE = "/api/consultorio/export";

export function exportHref(tenantId?: string | null): string {
  return tenantId ? `${EXPORT_ROUTE}?tenant=${encodeURIComponent(tenantId)}` : EXPORT_ROUTE;
}

const LIST_STYLE = {
  margin: "10px 0 0",
  paddingLeft: 18,
  display: "grid",
  gap: 6,
  fontSize: 13.5,
  lineHeight: 1.5,
  color: "var(--navy-700)",
} as const;

export function ExportPanel({ tenantId }: { tenantId?: string | null }) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Qué incluye</EyebrowLabel>
        <p style={{ margin: "10px 0 0", fontSize: 13.5, lineHeight: 1.5, color: "var(--navy-700)" }}>
          Un archivo con <strong>todos los datos de tu consultorio</strong>, para guardarlo o llevarlo a otro sistema:
        </p>
        <ul style={LIST_STYLE}>
          <li>Datos del consultorio, sedes, salas, servicios y obras sociales.</li>
          <li>Equipo y profesionales (nombre, email, rol), con sus horarios y bloqueos.</li>
          <li>Pacientes con sus coberturas y contactos de emergencia, archivados incluidos.</li>
          <li>Turnos y pagos.</li>
          <li>Planes de tratamiento, sesiones y ejercicios de cada sesión.</li>
          <li>Historia clínica: diagnósticos, evaluaciones, EVA y notas.</li>
          <li>El registro de actividad de los últimos 12 meses.</li>
        </ul>
      </Card>

      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Qué no incluye</EyebrowLabel>
        <ul style={LIST_STYLE}>
          <li>
            <strong>Los archivos adjuntos</strong> (PDF, imágenes, estudios): solo su nombre, tipo, tamaño y fecha. Cada
            archivo se descarga desde la ficha del paciente.
          </li>
          <li>Contraseñas, links de invitación y datos de las cuentas de acceso.</li>
          <li>El detalle técnico de Mercado Pago (los pagos sí están, con monto y estado).</li>
        </ul>
      </Card>

      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Descargar</EyebrowLabel>
        <p style={{ margin: "10px 0 14px", fontSize: 13.5, lineHeight: 1.5, color: "var(--navy-700)" }}>
          El archivo es un <strong>JSON</strong> (formato estándar que cualquier sistema puede leer). Tiene datos de
          salud de tus pacientes: guardalo en un lugar seguro y no lo mandes por mail ni chat.
        </p>
        <a
          href={exportHref(tenantId)}
          download
          className="k-btn k-btn-primary"
          data-export-download
          style={{ display: "inline-flex", textDecoration: "none" }}
        >
          Descargar export
        </a>
        <p style={{ margin: "12px 0 0", fontSize: 12.5, lineHeight: 1.5, color: "var(--navy-500)" }}>
          Con muchos pacientes puede tardar unos minutos: dejá la pestaña abierta hasta que termine. Podés descargarlo
          hasta 3 veces por hora. Cada descarga queda registrada.
        </p>
      </Card>
    </div>
  );
}
