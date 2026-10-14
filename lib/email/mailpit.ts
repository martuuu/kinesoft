/**
 * Transporte de desarrollo: Mailpit, un buzón local (IAM-0b, C-IAM1).
 *
 * Levantarlo: `docker compose --profile mail up -d mailpit` (UI en
 * http://localhost:8025) y `EMAIL_TRANSPORT=mailpit` en `.env.local`. Así se ve
 * cada mail tal como le llegaría a la persona, con los links clickeables, sin
 * que salga nada de la máquina.
 *
 * Por la API HTTP de Mailpit (`POST /api/v1/send`), no por SMTP: el mismo
 * patrón de `fetch` que Resend, sin dependencias (el repo no agrega `nodemailer`).
 *
 * Mailpit caído NO es un error de la app: devuelve `mailpit_unreachable` y
 * `index.ts` lo registra como `log` (skipped). Que Mailpit RECHACE el mensaje
 * (4xx/5xx) sí es un fallo: es un payload nuestro roto y tiene que verse igual
 * que un rechazo de Resend.
 */
import "server-only";

export const MAILPIT_DEFAULT_URL = "http://localhost:8025";

/** Mailpit es local: si en 3 s no contestó, está caído y no vale colgar el request. */
export const MAILPIT_TIMEOUT_MS = 3000;

export type MailpitMessage = {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
};

export type MailpitResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: "mailpit_unreachable" }
  | { ok: false; reason: "provider_error"; status: number };

/** `MAILPIT_URL` o el default, sin barra final. */
export function mailpitBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.MAILPIT_URL?.trim() || MAILPIT_DEFAULT_URL).replace(/\/+$/, "");
}

/** `Kine Sur vía KineSoft <a@b>` / `"Kine, S.A." <a@b>` / `a@b` → el formato de Mailpit. */
export function parseMailbox(raw: string): { Email: string; Name?: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<\s*([^<>\s]+)\s*>\s*$/);
  if (!m) return { Email: raw.trim() };
  const name = m[1].trim();
  return name ? { Name: name, Email: m[2] } : { Email: m[2] };
}

export async function sendViaMailpit(
  msg: MailpitMessage,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<MailpitResult> {
  const base = opts.baseUrl ?? mailpitBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? MAILPIT_TIMEOUT_MS);
  const f = opts.fetchImpl ?? globalThis.fetch;
  try {
    const res = await f(`${base}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: parseMailbox(msg.from),
        To: [parseMailbox(msg.to)],
        ...(msg.replyTo ? { ReplyTo: [parseMailbox(msg.replyTo)] } : {}),
        Subject: msg.subject,
        HTML: msg.html,
        Text: msg.text,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, reason: "provider_error", status: res.status };
    try {
      const data = (await res.json()) as { ID?: unknown };
      return { ok: true, id: typeof data?.ID === "string" ? data.ID : null };
    } catch {
      return { ok: true, id: null };
    }
  } catch {
    // Conexión rechazada, DNS o timeout: para el dev es lo mismo, Mailpit no está.
    return { ok: false, reason: "mailpit_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
