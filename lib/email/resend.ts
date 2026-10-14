/**
 * Resend por su API REST (IAM-0b, C-IAM1). Sin SDK ni dependencias: un `fetch`.
 *
 * Es el ÚNICO archivo del repo que conoce `api.resend.com` (lo fija el guard de
 * `tests/unit/email-transport.test.ts`): todo mail pasa por `sendEmail`
 * (`index.ts`), que es quien decide si se llega hasta acá (`transport.ts`).
 *
 * Tres reglas, heredadas de los incidentes de Traze (19-sep):
 *  1. **Timeout de 5 s con AbortController.** Sin él, un Resend colgado se comía
 *     la invocación serverless entera y con ella lo que venía después (la
 *     auditoría, la respuesta al usuario). Resend contesta en < 1 s.
 *  2. **Nunca tira.** Devuelve un resultado tipado; quien llama decide.
 *  3. **Ni la key ni el body van a ningún lado.** El body de un 4xx de Resend
 *     puede repetir el destinatario ("…is not allowed to send to ana@…"); de él
 *     solo se extrae `name` (un código como `validation_error`), que sirve para
 *     el diagnóstico y no lleva datos. Este módulo no loguea: el log (enmascarado)
 *     lo hace `index.ts`, en un solo lugar.
 */
import "server-only";

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const RESEND_TIMEOUT_MS = 5000;

export type ResendMessage = {
  /** Remitente ya compuesto por `composeFrom` (`transport.ts`). */
  from: string;
  /** Un destinatario ya validado. */
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  /**
   * Header `Idempotency-Key` de Resend (24 h): un reintento con la misma clave no
   * duplica el mail. Opcional; lo usarán los reenvíos de IAM-2 si hace falta.
   */
  idempotencyKey?: string | null;
};

export type ResendResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: "no_api_key" | "timeout" | "network_error" }
  | {
      ok: false;
      reason: "rate_limited" | "provider_error";
      status: number;
      /** Segundos del header `Retry-After` (429), o null si no vino. */
      retryAfterSec: number | null;
      /** `name` del body de error de Resend (`validation_error`, …), o null. Nunca el mensaje. */
      errorName: string | null;
    };

/** `Retry-After` en segundos: acepta segundos o una fecha HTTP. null si no se entiende. */
export function parseRetryAfter(raw: string | null | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

async function errorNameOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { name?: unknown };
    const n = typeof body?.name === "string" ? body.name : "";
    // Solo un identificador: si Resend algún día mete otra cosa, no pasa.
    return /^[a-z_]{1,48}$/.test(n) ? n : null;
  } catch {
    return null;
  }
}

export async function sendViaResend(
  msg: ResendMessage,
  opts: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<ResendResult> {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) return { ok: false, reason: "no_api_key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? RESEND_TIMEOUT_MS);
  // Se lee en cada llamada (no al importar) para que los tests puedan stubear el global.
  const f = opts.fetchImpl ?? globalThis.fetch;

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (msg.idempotencyKey) headers["Idempotency-Key"] = msg.idempotencyKey.slice(0, 256);

    const res = await f(RESEND_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: msg.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      return {
        ok: false,
        reason: res.status === 429 ? "rate_limited" : "provider_error",
        status: res.status,
        retryAfterSec: parseRetryAfter(res.headers.get("retry-after")),
        errorName: await errorNameOf(res),
      };
    }
    let id: string | null = null;
    try {
      const data = (await res.json()) as { id?: unknown };
      id = typeof data?.id === "string" ? data.id : null;
    } catch {
      // 200 sin body JSON: salió igual; sin id para EmailLog.
    }
    return { ok: true, id };
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return { ok: false, reason: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
