/**
 * [MB-1f · C-MB3 Plataforma] Lógica pura del botón «Filtros (n)» que bajo 768 px reemplaza los filtros en línea de
 * las listas de Plataforma (consultorios, facturación, auditoría). Fuera del componente para el unit test.
 */

/** Cuántos filtros están activos: cuenta los valores no vacíos (`""`, `null`, `undefined` y `false` no cuentan). */
export function activeFilterCount(values: ReadonlyArray<string | number | boolean | null | undefined>): number {
  return values.filter((v) => v !== "" && v !== null && v !== undefined && v !== false).length;
}

/** Rótulo del botón: «Filtros» sin filtros activos, «Filtros (n)» con n activos. */
export function filtersButtonLabel(count: number): string {
  return count > 0 ? `Filtros (${count})` : "Filtros";
}
