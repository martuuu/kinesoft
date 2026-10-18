/**
 * HF-1b (§22.2 H-RT1, agravante «PWA abierta varios deploys»): `import()` con un reintento.
 *
 * Por qué: Vercel deploya `main` y los chunks del build anterior dejan de existir. Una pestaña (o la PWA instalada)
 * que lleva horas abierta pide `realtime-hub.<hash>.js` y recibe 404: el `import()` rechaza con `ChunkLoadError` y,
 * sin esto, el realtime quedaba en polling para siempre sin decir por qué. Un fallo suelto de red se arregla con un
 * reintento (webpack borra el chunk fallido de su tabla y el segundo `import()` lo vuelve a pedir); si el segundo
 * también falla, no es la red: hay una versión nueva y solo recargar la trae. Eso es `StaleBuildError`, que el hub y
 * el indicador traducen a «Hay una versión nueva · Recargá».
 *
 * Sin dependencias a propósito: lo importa estáticamente `realtime-provider.tsx`, que va en el first-load de TODAS
 * las rutas del workspace (§18.10 punto 7).
 */

/** Espera antes del único reintento: lo que tarda en volver una red que parpadeó, sin dejar la sala congelada. */
export const CHUNK_RETRY_DELAY_MS = 5_000;

/** El chunk no cargó dos veces: deploy nuevo con la pestaña vieja. Se reconoce por `name` (cruza chunks). */
export class StaleBuildError extends Error {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    super(detail ? `Hay una versión nueva: ${detail}` : "Hay una versión nueva");
    this.name = "StaleBuildError";
  }
}

export function isStaleBuildError(err: unknown): boolean {
  return err instanceof Error && err.name === "StaleBuildError";
}

export type ImportRetryOptions = {
  delayMs?: number;
  /** Inyectable en tests; por defecto `setTimeout` del host (leído en cada llamada: `vi.useFakeTimers` lo reemplaza). */
  wait?: (ms: number) => Promise<void>;
};

const defaultWait = (ms: number) => new Promise<void>((r) => globalThis.setTimeout(r, ms));

/**
 * Corre `load()`; si rechaza, espera `delayMs` y lo corre una vez más. Si el segundo también rechaza, tira
 * `StaleBuildError` (con el mensaje del último error, sin stack: el beacon lo recorta igual).
 */
export async function importWithRetry<T>(load: () => Promise<T>, opts: ImportRetryOptions = {}): Promise<T> {
  try {
    return await load();
  } catch {
    await (opts.wait ?? defaultWait)(opts.delayMs ?? CHUNK_RETRY_DELAY_MS);
    try {
      return await load();
    } catch (err) {
      throw new StaleBuildError(err);
    }
  }
}
