"use server";

/**
 * CF-RT (§28 E) · la referencia del cliente a `mintRealtimeToken`, importada ESTÁTICA por `RealtimeProvider`.
 *
 * Por qué existe:
 * - Next 14.2 no registra en `server-reference-manifest.json` una action que el cliente solo alcanza por `import()`
 *   (AUDIT:2333). La del token la importaba el hub (dinámico) y en prod el server respondía «Failed to find Server
 *   Action» con el MISMO build. Con un import estático desde el provider (en el layout de `(app)`) queda registrada
 *   para todas las rutas del workspace; `scripts/check-server-actions.mjs` lo verifica tras cada build.
 * - Por qué un módulo aparte y no `@/lib/realtime-token` directo en el provider: el provider lo importan 8 componentes
 *   (todos los que usan `useRealtime`) y en los tests de render (vitest, React de cliente) un import estático de
 *   `lib/realtime-token` evalúa `lib/session` (`cache()` de React server) y rompe la colección de cualquier test que
 *   renderice uno de ellos («cache is not a function»). Acá el módulo real entra recién al LLAMAR, en el server.
 *
 * No agrega lógica ni permisos: toda la barrera (getActor, acceso, capability, rate limit) es de `mintRealtimeToken`.
 */
import type { mintRealtimeToken } from "@/lib/realtime-token";

export async function mintRealtimeTokenAction(): ReturnType<typeof mintRealtimeToken> {
  const { mintRealtimeToken: mint } = await import("@/lib/realtime-token");
  return mint();
}
