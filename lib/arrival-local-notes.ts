/**
 * Registro de acciones de Recepción hechas por ESTA pestaña (SV11b).
 *
 * Vive aparte de `components/providers/arrival-alerts.tsx` a propósito: ese
 * provider importa la server action del token realtime (y con ella
 * `lib/session.ts`); Recepción y `/sala` solo necesitan avisar "esto lo hice
 * yo" y no tienen que arrastrar ese grafo (rompía los render tests y sumaba
 * peso al chunk de la agenda). El motor de avisos se registra acá al montar.
 */
export type LocalReceptionResult = { arrivedAt?: string | Date | null; calledAt?: string | Date | null };

type Listener = (bookingId: string, result: LocalReceptionResult) => void;

let listener: Listener | null = null;

/** El motor de avisos se registra; devuelve la baja. Un solo motor por pestaña. */
export function registerLocalReceptionListener(fn: Listener): () => void {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/**
 * Llamar después de un `markReceptionAction` OK (Recepción, `/sala`) con su
 * resultado: la pestaña que marcó «Llegó»/«Llamar» no se avisa a sí misma.
 */
export function noteLocalReception(bookingId: string, result: LocalReceptionResult): void {
  listener?.(bookingId, result);
}
