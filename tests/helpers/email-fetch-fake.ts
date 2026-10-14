/**
 * `fetch` fake para los transportes de mail (IAM-0b: Resend y Mailpit).
 *
 * Es el mismo patrón que `tests/helpers/fetch-fake.ts` (SV), con dos cosas que
 * ese no tiene y que el mail necesita: un body JSON de respuesta (Resend
 * devuelve `{ id }`, Mailpit `{ ID }`) y headers de respuesta (`retry-after`
 * en el 429). No se extiende el de SV porque es de otra sesión.
 *
 * Registro a mano (`calls`), no `vi.fn`: con vitest 2.1.9 un `vi.fn` que tira a
 * través de un mock rompe el test aunque el código bajo test atrape el error.
 * Respeta `init.signal` (rechaza con `AbortError`); con `delayMs: Infinity`
 * nunca responde solo, así el único final posible es el timeout del caller.
 */
export type EmailFetchCall = {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: unknown;
};

export type EmailFetchOptions = {
  status?: number;
  json?: unknown;
  responseHeaders?: Record<string, string>;
  delayMs?: number;
  rejectWith?: unknown;
};

function abortError(): Error {
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  return e;
}

export function makeEmailFetchFake(opts: EmailFetchOptions = {}): {
  fetch: typeof fetch;
  calls: EmailFetchCall[];
} {
  const calls: EmailFetchCall[] = [];
  const status = opts.status ?? 200;
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
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), init, headers, body });

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
        if (opts.rejectWith !== undefined) return reject(opts.rejectWith);
        const payload = opts.json === undefined ? null : JSON.stringify(opts.json);
        resolve(
          new Response(status === 204 ? null : payload, {
            status,
            headers: { "content-type": "application/json", ...(opts.responseHeaders ?? {}) },
          }),
        );
      };
      if (delayMs === Infinity) return;
      if (delayMs > 0) timer = setTimeout(finish, delayMs);
      else finish();
    });
  };

  return { fetch: fake as typeof fetch, calls };
}
