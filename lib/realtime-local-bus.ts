import "server-only";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";

/**
 * Bus en memoria del driver `local` (SV04a, §18.2). Solo para dev
 * (`REALTIME_DRIVER=local`; `lib/env.ts` lo prohíbe en Production, SV-D11):
 * el publisher emite acá y la ruta SSE `app/api/realtime/local` (SV07b)
 * se suscribe por `actor.tenantId` y reenvía al browser.
 *
 * Por qué en `globalThis` y no en una variable de módulo: en `next dev` el HMR
 * re-evalúa los módulos que cambian; con un `Map` de módulo, la ruta SSE
 * quedaba suscrita a la instancia vieja y el publisher emitía a una nueva
 * (nadie escuchaba, sin error visible). `globalThis` sobrevive al HMR.
 * Es un bus de UN proceso: con varias instancias no sirve, y no tiene que
 * servir (en Vercel el driver es `supabase`).
 */

export type LocalBusListener = (messages: RealtimeAgendaMessage[]) => void;

declare global {
  // eslint-disable-next-line no-var
  var __kinesoftRealtimeBus: Map<string, Set<LocalBusListener>> | undefined;
}

function bus(): Map<string, Set<LocalBusListener>> {
  return (globalThis.__kinesoftRealtimeBus ??= new Map());
}

/** Suscribe `fn` a los mensajes del consultorio; devuelve la baja (idempotente). */
export function subscribe(tenantId: string, fn: LocalBusListener): () => void {
  const b = bus();
  let set = b.get(tenantId);
  if (!set) {
    set = new Set();
    b.set(tenantId, set);
  }
  set.add(fn);
  return () => {
    const cur = bus().get(tenantId);
    if (!cur) return;
    cur.delete(fn);
    // Sin esto, cada consultorio que alguna vez abrió una pestaña deja un Set vacío.
    if (cur.size === 0) bus().delete(tenantId);
  };
}

/**
 * Entrega `messages` a los suscriptos de ESE consultorio (nunca a otro).
 * Cada listener en su try: un stream SSE ya cerrado que tira no puede cortar
 * la entrega a las otras pestañas ni subir hasta la action que publicó.
 */
export function emit(tenantId: string, messages: RealtimeAgendaMessage[]): void {
  const set = bus().get(tenantId);
  if (!set || messages.length === 0) return;
  for (const fn of Array.from(set)) {
    try {
      fn(messages);
    } catch {
      // el listener es de otra pestaña: no hay a quién avisar desde acá
    }
  }
}

/** Cantidad de suscriptos (tests y la ruta SSE para verificar que la baja limpia). */
export function listenerCount(tenantId: string): number {
  return bus().get(tenantId)?.size ?? 0;
}
