import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { SUPABASE_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import {
  MAINTENANCE_PATH,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  maintenanceDecision,
  maintenanceMode,
} from "@/lib/maintenance";

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
 *
 * BO5-B — modo mantenimiento (`MAINTENANCE_MODE=on` + redeploy). La decisión es pura (`lib/maintenance.ts`, con
 * la tabla de excepciones testeada); acá solo se aplica. Con `off` el camino es idéntico al de antes. Con `on`:
 *   - lo bloqueado NO refresca la sesión (no se renderiza nada que la use, y durante un mantenimiento no queremos
 *     ir a Supabase); el strip de `x-tenant-*` y el `x-request-id` corren igual, también en el 503;
 *   - páginas → rewrite a /mantenimiento con 503 + Retry-After; `/api/**` → 503 JSON `{ error: "maintenance" }`;
 *   - `/api/health` pasa y lleva `x-maintenance: on` en la respuesta (el monitor lo distingue de una caída).
 * Sin bypass para superadmins: ver la cabecera de `lib/maintenance.ts`.
 */

/**
 * PF-0a: diagnóstico de lentitud (`lib/server-timing.ts` del lado Node). No se importa ese módulo acá: el middleware
 * corre en Edge y aquel usa `node:async_hooks`. Se lee `process.env` directo, como `MAINTENANCE_MODE`.
 */
const PERF_TIMING = process.env.PERF_TIMING === "1";

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

  // Se lee `process.env` directo y no `lib/env.ts`: ese módulo valida todo el entorno al importarse.
  const mode = maintenanceMode(process.env.MAINTENANCE_MODE);
  const maintenance = maintenanceDecision(url.pathname, mode);

  // Primero el refresh: muta `req.cookies` (y con eso el header `cookie`),
  // así la copia de headers de abajo ya lleva el token nuevo.
  // PF-0a (H-SLOW): con PERF_TIMING=1 se mide el refresh y sale en `Server-Timing: mw-session;dur=…` (lo lee
  // `scripts/perf/ttfb.mjs`). Apagado no se toma ningún tiempo. Solo mide: el orden de abajo (AUDIT §5.3) no cambia.
  const mwT0 = PERF_TIMING ? performance.now() : 0;
  const sessionCookies = maintenance === "pass" ? await refreshSupabaseSession(req) : [];
  const mwSessionMs = PERF_TIMING ? performance.now() - mwT0 : 0;

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
    if (mode === "on" && url.pathname.startsWith("/api/health")) res.headers.set("x-maintenance", "on");
    if (PERF_TIMING) res.headers.set("server-timing", `mw-session;dur=${mwSessionMs.toFixed(1)}`);
    for (const c of sessionCookies) res.cookies.set(c.name, c.value, c.options);
    if (sessionCookies.length > 0) {
      // Una respuesta con Set-Cookie de sesión no se cachea en ningún CDN.
      res.headers.set("cache-control", "private, no-store");
    }
    return res;
  };

  // BO5-B: después del strip y del request-id (corren en todos los caminos, AUDIT §5.3).
  if (maintenance !== "pass") {
    const unavailable = {
      "x-request-id": safeReqId,
      "retry-after": String(MAINTENANCE_RETRY_AFTER_SECONDS),
      "cache-control": "no-store",
    };
    if (maintenance === "api") {
      return NextResponse.json({ error: "maintenance" }, { status: 503, headers: unavailable });
    }
    const res = NextResponse.rewrite(new URL(MAINTENANCE_PATH, req.url), {
      status: 503,
      request: { headers: requestHeaders },
    });
    for (const [k, v] of Object.entries(unavailable)) res.headers.set(k, v);
    return res;
  }

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
  // MB-0b (C-MB5): los archivos de la PWA quedan FUERA del middleware. Si pasaran, con cookie de sesión saldrían
  // `private, no-store` por el refresh de Supabase y, con `MAINTENANCE_MODE=on`, se reescribirían a la página de
  // mantenimiento con 503: el navegador no actualiza el SW y la instalación falla. Son estáticos sin datos de nadie
  // (sw.js, offline.html, manifest e íconos generados en el build), no necesitan tenant ni sesión. Lo de AUDIT §5.3
  // (strip de x-tenant-*, x-request-id, bypass de webhooks, mantenimiento) sigue igual para todo lo demás.
  // Test: tests/unit/pwa-manifest.test.ts compila este matcher con el mismo `getMiddlewareMatchers` del build.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|sw\\.js|manifest\\.webmanifest|offline\\.html|icons/).*)",
  ],
};
