"use client";

/**
 * [BO-Z B10] Red de escrituras rechazadas con el consultorio en solo lectura REAL (`enforce` + prueba vencida,
 * impago o baja). La monta `app/(app)/layout.tsx` solo en ese caso (y nunca en soporte, que tiene la suya en la
 * banda de soporte: las dos juntas mostrarían dos Toasts por el mismo rechazo).
 *
 * Por qué: con `enforce`, `runWithRls`/`assertWritable` tiran `ReadOnlyModeError`; muchas pantallas no atrapan el
 * throw y en producción Next lo redacta a un Error con `digest`, así que «Guardar» no hacía nada visible. Acá se
 * muestra «No se guardó» con el mismo copy del error (`READ_ONLY_MESSAGE`). No renderiza nada.
 */
import { READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import { isWriteRejection, useWriteRejectionToast } from "@/hooks/use-write-rejection-toast";

export function isReadOnlyWriteRejection(reason: unknown): boolean {
  return isWriteRejection(reason, [READ_ONLY_MESSAGE]);
}

const readOnlyDescription = () => READ_ONLY_MESSAGE;

export function ReadOnlyWriteGuard() {
  useWriteRejectionToast({ enabled: true, matches: isReadOnlyWriteRejection, description: readOnlyDescription });
  return null;
}
