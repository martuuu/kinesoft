/**
 * Columnas del directorio de pacientes (EV1-B). Las comparten el encabezado
 * (`app/(app)/pacientes/page.tsx`, server) y las filas (`patients-list.tsx`,
 * cliente): si se desalinean, cada celda cae bajo el título equivocado. Va en un
 * módulo puro porque una función exportada desde un archivo `"use client"` no
 * se puede llamar desde un Server Component.
 *
 * Con `planes` (Kine): checkbox · Paciente · Plan activo · Obra social ·
 * Próx. turno · Última visita · Estado · acciones. Sin `planes` (General) se va
 * la columna «Plan activo» y Paciente/Obra social absorben el ancho.
 */
export function patientsGridColumns(plansEnabled: boolean): string {
  return plansEnabled
    ? "28px 1.6fr 1fr 1fr 1.2fr 100px 90px 40px"
    : "28px 2fr 1.2fr 1.2fr 100px 90px 40px";
}
