import { z } from "zod";
import { env } from "@/lib/env";
import { clientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { isAllowedOrigin } from "@/lib/safe-next";
import { redact } from "@/lib/redact";
import { captureException } from "@/lib/observability";
import {
  CLIENT_ERROR_KINDS,
  CLIENT_ERROR_LIMITS,
  scrubClientPath,
  scrubTokenPaths,
} from "@/lib/client-error-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BO1-D — receptor de `reportClientError` (beacon de los error boundaries). Reemplaza al SDK de Sentry de
 * cliente, que AUDIT §5.23 no deja entrar sin presupuesto de bundle.
 *
 * Es un endpoint SIN sesión que escribe en nuestros logs/Sentry, así que:
 *   - Origin propio (`isAllowedOrigin`, el mismo chequeo de sign-in/sign-out): un sitio ajeno no puede
 *     usar a los visitantes como cañón para llenar Sentry/la cuota.
 *   - Rate limit por IP (20/min): un boundary en loop o un script no inunda los logs.
 *   - Cuerpo con tope (16 KB) leído como texto ANTES de parsear: `req.json()` aceptaría cualquier tamaño.
 *   - Todo pasa por `scrubTokenPaths` + `redact()` antes de `captureException` (que además redacta el
 *     log y el `beforeSend` de Sentry): el mensaje de un error de render puede traer el email o el token
 *     que había en pantalla.
 *   - Nunca devuelve detalles: 204 / 400 / 403 / 413 / 429 sin cuerpo. Un atacante no aprende qué
 *     validación falló y el cliente no los mira (es un beacon).
 */
const MAX_BODY_BYTES = 16 * 1024;
const RATE = { limit: 20, windowMs: 60_000 };

// Los strings se aceptan largos y se RECORTAN (no se rechazan): un stack de 6 KB sigue siendo un error
// real que conviene ver. El tope duro es MAX_BODY_BYTES.
const trimmed = (max: number) => z.string().transform((s) => s.slice(0, max));
const PayloadSchema = z.object({
  message: trimmed(CLIENT_ERROR_LIMITS.message),
  stack: trimmed(CLIENT_ERROR_LIMITS.stack).optional(),
  digest: trimmed(CLIENT_ERROR_LIMITS.digest).optional(),
  path: z.string().optional(),
  kind: z.enum(CLIENT_ERROR_KINDS),
});

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function POST(req: Request): Promise<Response> {
  if (!isAllowedOrigin(req.headers, [new URL(req.url).origin, env.NEXT_PUBLIC_APP_URL])) {
    return empty(403);
  }

  const rl = await rateLimit(`client-errors:ip:${clientIp(req.headers)}`, RATE);
  if (!rl.ok) return empty(429, { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return empty(413);
  let text: string;
  try {
    text = await req.text();
  } catch {
    return empty(400);
  }
  if (text.length > MAX_BODY_BYTES) return empty(413);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty(400);
  }
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) return empty(400);

  const p = redact({
    message: scrubTokenPaths(parsed.data.message),
    stack: parsed.data.stack ? scrubTokenPaths(parsed.data.stack) : undefined,
    digest: parsed.data.digest,
    path: parsed.data.path ? scrubClientPath(parsed.data.path) : undefined,
  });

  // Se reconstruye un Error con el mensaje y el stack del navegador para que Sentry lo agrupe por stack
  // y el log muestre dónde explotó. `name` distinto para filtrarlos de los errores del server.
  const err = new Error(p.message);
  err.name = "ClientError";
  err.stack = p.stack ? `ClientError: ${p.message}\n${p.stack}` : `ClientError: ${p.message}`;
  captureException(err, {
    source: "client",
    kind: parsed.data.kind,
    digest: p.digest,
    path: p.path,
  });

  return empty(204);
}
