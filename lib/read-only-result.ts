/**
 * BO3-F (handoff 3, clase A): traducir el `ReadOnlyModeError` a un `ActionResult` fallido.
 *
 * Por qué: el error lo tira `runWithRls` (25006 de la tx en solo lectura) o `assertWritable` cuando el consultorio
 * está en modo lectura o cuando entra un superadmin como soporte. Si la server action no lo atrapa, en producción Next
 * redacta el mensaje de toda excepción («An error occurred in the Server Components render…» + digest): el usuario
 * ve un error genérico en vez de «Entraste como soporte: acá solo podés mirar.» o el copy del modo lectura. Y las
 * actions que sí tienen catch lo tapaban con su copy genérico («No pudimos crear el turno.»).
 *
 * Módulo puro (sin `"use server"` ni `server-only`): solo depende de `lib/tenant-access.ts`, que también es puro.
 * Solo atrapa `ReadOnlyModeError`: cualquier otro error se re-tira tal cual (no cambia el contrato de las actions
 * que tiran a propósito, p. ej. `getActor` sin sesión).
 */
import { ReadOnlyModeError } from "@/lib/tenant-access";

/** `{ ok:false, error }` con el copy del modo lectura/soporte si `e` es un `ReadOnlyModeError`; si no, null. */
export function readOnlyFailure(e: unknown): { ok: false; error: string } | null {
  return e instanceof ReadOnlyModeError ? { ok: false, error: e.message } : null;
}

/**
 * Corre el cuerpo de una action y convierte un `ReadOnlyModeError` en `{ ok:false, error }`. Para las actions que no
 * tienen un try/catch propio alrededor de todas sus escrituras. Es solo un catch: no suma queries (el techo de
 * statements de createBooking no cambia).
 */
export async function withReadOnlyResult<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await fn();
  } catch (e) {
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    throw e;
  }
}
