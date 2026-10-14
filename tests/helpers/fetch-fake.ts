/**
 * `fetch` fake para el publisher realtime (SV04a; patrón de
 * `tests/unit/rate-limit.test.ts:163-180`).
 *
 * Registro a mano (`calls`), no `vi.fn`: con vitest 2.1.9 un `vi.fn` que tira a
 * través de un mock rompía el test aunque el código bajo test atrapara el error.
 *
 * Respeta `init.signal`: si se aborta antes de responder, rechaza con un
 * `AbortError` (lo que hace el fetch de Node). Con `delayMs: Infinity` nunca
 * responde solo, así el único final posible es el timeout del caller. El delay
 * usa `setTimeout`, así que `vi.useFakeTimers()` lo controla.
 */
export type FetchFakeCall = {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  /** `init.body` parseado como JSON (o el string crudo si no es JSON). */
  body: unknown;
};

export type FetchFakeOptions = {
  status?: number;
  delayMs?: number;
  rejectWith?: unknown;
};

function abortError(): Error {
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  return e;
}

function headersOf(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (out[k] = v));
  return out;
}

export function makeFetchFake(opts: FetchFakeOptions = {}): {
  fetch: typeof fetch;
  calls: FetchFakeCall[];
} {
  const calls: FetchFakeCall[] = [];
  const status = opts.status ?? 202;
  const delayMs = opts.delayMs ?? 0;

  const fake = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    let body: unknown = init.body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(input), init, headers: headersOf(init), body });

    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) return reject(abortError());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = () => {
        signal?.removeEventListener("abort", onAbort);
        if (opts.rejectWith !== undefined) reject(opts.rejectWith);
        else resolve(new Response(null, { status }));
      };
      if (delayMs === Infinity) return;
      if (delayMs > 0) timer = setTimeout(finish, delayMs);
      else finish();
    });
  };

  return { fetch: fake as typeof fetch, calls };
}
