/**
 * [BO-Z B8] Rebase de un form de Plataforma cuando el server trae una versión nueva con el Drawer abierto (un
 * guardado que rebotó por CAS, u otro superadmin / el titular desde Configuración guardó en el medio).
 *
 * Antes el efecto de `detail.updatedAt` cambiaba la baseline pero dejaba el form como estaba: los campos que el
 * superadmin NO tocó quedaban con el valor viejo, distinto de la baseline nueva, y el payload «solo lo cambiado» los
 * mandaba igual: el reintento pisaba en silencio lo que había guardado la otra sesión.
 *
 * Regla: un campo que en el form sigue igual a la baseline VIEJA (no se tocó) toma el valor de la baseline nueva; uno
 * tocado se queda con lo que cargó el superadmin. `changed` = la otra sesión cambió algo (para avisarle).
 * Puro y genérico (lo usan «Editar datos» y «Editar suscripción»); comparación con `===` (los forms son planos:
 * strings, booleans y enums).
 */
export const REBASED_FORM_COPY = "Cambió en otra sesión: actualizamos los campos que no tocaste. Revisá y volvé a guardar.";

export function rebaseForm<T extends Record<string, unknown>>(
  oldBase: T,
  newBase: T,
  form: T
): { form: T; changed: boolean } {
  const out = { ...form };
  let changed = false;
  for (const k of Object.keys(newBase) as (keyof T)[]) {
    if (oldBase[k] !== newBase[k]) changed = true;
    if (form[k] === oldBase[k]) out[k] = newBase[k];
  }
  return { form: out, changed };
}
