import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware — two responsibilities:
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

export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const host = req.headers.get("host") ?? "";

  if (url.pathname.startsWith("/_next") || url.pathname.startsWith("/api/webhooks")) {
    return NextResponse.next();
  }

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

  // 1) path: /c/<slug>/...
  const pathMatch = url.pathname.match(/^\/c\/([a-z0-9-]+)(\/|$)/i);
  if (pathMatch) {
    requestHeaders.set("x-tenant-slug", pathMatch[1].toLowerCase());
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set("x-request-id", safeReqId);
    return res;
  }

  // 2) subdomain: <slug>.kinesoft.app
  const hostParts = host.split(":")[0].split(".");
  if (hostParts.length >= 3 && !["www", "app", "api"].includes(hostParts[0])) {
    requestHeaders.set("x-tenant-slug", hostParts[0].toLowerCase());
  }

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  // Echo the ID on the response too so client-side instrumentation can
  // correlate fetches to server logs.
  res.headers.set("x-request-id", safeReqId);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
