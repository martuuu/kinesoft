/**
 * T3e-2p (plan §23.9) · filtro por obra social de /pacientes (`?os=`). Lógica pura: la usa `listPatients`
 * (lib/patients.ts, "use server": no puede exportar constantes) y la página arma el `<select>` con la misma clave.
 */

/** Valor de `?os=` para «Particular». No choca con un `Insurer.id` (cuid de 25 caracteres). */
export const PARTICULAR_INSURER_KEY = "particular";

/** Lo mínimo de la cobertura vigente que hace falta para decidir. */
export type CoverageForOsFilter = {
  insurerId: string | null;
  insurerRef: { isParticular: boolean } | null;
} | null | undefined;

/**
 * ¿La cobertura VIGENTE (la más reciente, `coverages[0]` con `orderBy id desc`) corresponde a `key`?
 *  - id del catálogo: `insurerId === key`;
 *  - «Particular»: sin cobertura, cobertura de texto libre (`insurerId` null: el turno cobra como particular) o la fila
 *    `isParticular` del catálogo.
 * El pre-filtro SQL matchea CUALQUIER cobertura del paciente; esto evita que una cobertura vieja lo haga aparecer.
 */
export function matchesInsurerKey(current: CoverageForOsFilter, key: string): boolean {
  if (key === PARTICULAR_INSURER_KEY) {
    return !current || current.insurerId == null || current.insurerRef?.isParticular === true;
  }
  return current?.insurerId === key;
}
