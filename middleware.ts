import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { SUPABASE_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";

/**
 * Edge middleware — three responsibilities:
 *
 *   1. **Tenant slug resolution** for public routes that need it before
 *      auth runs:
 *        - `/c/<slug>/...`         (path-based, primary)
 *        - `<slug>.kinesoft.app`   (subdomain)
 *      Sets `x-tenant-slug` on the downstream request. **Authenticated
 *      server actions ignore this header entirely** (see
 *      `lib/session.ts`) — it is purely a public-tenant resolution
 *      mechanism, not an auth bypass. Client-supplied values are always
 *      stripped first, closing the header-smuggling vector.
 *
 *   2. **Request ID minting** for observability. Every request gets an
 *      `x-request-id` header (UUID v4-shaped). If the upstream sent
 *      one (load balancer, browser instrumentation) we keep it — that
 *      lets a single ID trace across systems. Downstream code reads it
 *      via `getRequestContext().requestId` and `logger.span` stamps it
 *      on every line automatically.
 *
 *   3. **Refresh de la sesión de Supabase** (A3b-S-auth). Antes no había
 *      middleware de sesión: el access token (1 h) vencía y, como los server
 *      components no pueden escribir cookies, el refresh nunca se persistía →
 *      "me deslogueó a la hora". Ahora cada request refresca si hace falta y
 *      propaga las cookies nuevas en DOS lados: al request que sigue (así el
 *      server component de este mismo request ya ve el token nuevo) y a la
 *      respuesta (así el browser lo guarda).
 *
 * AUDIT §5.3 (preservar): el strip de `x-tenant-*` y el `x-request-id` se
 * aplican DESPUÉS del refresh, sobre los headers ya con la cookie nueva, así
 * que ningún camino de la sesión los saltea. `/api/webhooks` sigue bypass
 * total (Mercado Pago no trae cookies y no debe pagar el costo).
 */

function newRequestId(): string {
  // crypto.randomUUID is available in the Edge runtime.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback — non-cryptographic but adequate for tracing.
  return Array.from({ length: 4 })
    .map(() => Math.random().toString(36).slice(2, 10))
    .join("-");
}

type CookieToSet = { name: string; value: string; options: Parameters<NextResponse["cookies"]["set"]>[2] };

/**
 * Refresca la sesión si está por vencer. Devuelve las cookies a escribir en
 * la respuesta (vacío si no hubo cambios). Las escribe además en `req.cookies`
 * (que actualiza el header `cookie` del request) para el render de ahora.
 *
 * Usa `getSession()` y no `getUser()` a propósito: acá NO se toma ninguna
 * decisión de acceso (eso lo hacen `getActor()` / el portal con `getUser()`,
 * que valida el JWT contra Supabase). `getSession()` solo va a la red cuando
 * el access token está por vencer y hay que refrescarlo; `getUser()` sumaría
 * un round-trip a Supabase en cada request de la app.
 */
async function refreshSupabaseSession(req: NextRequest): Promise<CookieToSet[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];
  // Sin cookie de sesión no hay nada que refrescar: el tráfico anónimo
  // (landing, turnero público) no paga ni la construcción del cliente.
  if (!req.cookies.getAll().some((c) => c.name.startsWith("sb-"))) return [];

  const out: CookieToSet[] = [];
  const supabase = createServerClient(url, key, {
    cookieOptions: SUPABASE_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value, options } of cookiesToSet) {
          req.cookies.set(name, value);
          out.push({ name, value, options: { ...options, ...SUPABASE_COOKIE_OPTIONS } });
        }
      },
    },
  });
  try {
    await supabase.auth.getSession();
  } catch {
    // Supabase caído o cookie corrupta: seguimos sin refrescar. El server
    // component va a ver la sesión vieja (o ninguna) y actuar en consecuencia.
  }
  return out;
}

export async function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const host = req.headers.get("host") ?? "";

  if (url.pathname.startsWith("/_next") || url.pathname.startsWith("/api/webhooks")) {
    return NextResponse.next();
  }

  // Primero el refresh: muta `req.cookies` (y con eso el header `cookie`),
  // así la copia de headers de abajo ya lleva el token nuevo.
  const sessionCookies = await refreshSupabaseSession(req);

  const requestHeaders = new Headers(req.headers);
  // Always strip client-supplied tenant headers — only this middleware may set them.
  requestHeaders.delete("x-tenant-slug");
  requestHeaders.delete("x-tenant-id");

  // Mint or preserve the request ID. Validation: only accept tokens that
  // look like UUIDs or short alphanumeric — protects logs from injection.
  const incomingReqId = req.headers.get("x-request-id");
  const safeReqId =
    incomingReqId && /^[a-zA-Z0-9_-]{8,64}$/.test(incomingReqId)
      ? incomingReqId
      : newRequestId();
  requestHeaders.set("x-request-id", safeReqId);
  // A3c: el layout de la app no recibe el pathname; lo lee de acá para armar
  // `/login?next=…` (siempre pasa por safeNext). Se pisa el que mande el
  // cliente, igual que x-tenant-*.
  requestHeaders.delete("x-pathname");
  requestHeaders.set("x-pathname", req.nextUrl.pathname + req.nextUrl.search);

  const finish = () => {
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    // Echo the ID on the response too so client-side instrumentation can
    // correlate fetches to server logs.
    res.headers.set("x-request-id", safeReqId);
    for (const c of sessionCookies) res.cookies.set(c.name, c.value, c.options);
    if (sessionCookies.length > 0) {
      // Una respuesta con Set-Cookie de sesión no se cachea en ningún CDN.
      res.headers.set("cache-control", "private, no-store");
    }
    return res;
  };

  // 1) path: /c/<slug>/...
  const pathMatch = url.pathname.match(/^\/c\/([a-z0-9-]+)(\/|$)/i);
  if (pathMatch) {
    requestHeaders.set("x-tenant-slug", pathMatch[1].toLowerCase());
    return finish();
  }

  // 2) subdomain: <slug>.kinesoft.app
  const hostParts = host.split(":")[0].split(".");
  if (hostParts.length >= 3 && !["www", "app", "api"].includes(hostParts[0])) {
    requestHeaders.set("x-tenant-slug", hostParts[0].toLowerCase());
  }

  return finish();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
