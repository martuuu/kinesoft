import { NextResponse, type NextRequest } from "next/server";

/**
 * Resolve the *public* tenant slug for routes that need it before auth runs:
 *   1. `/c/<slug>/...`         (path-based, primary)
 *   2. `<slug>.kinesoft.app`   (subdomain)
 *
 * Sets `x-tenant-slug` on the downstream request so public routes
 * (turnero, public booking) can pick it up. **Authenticated server
 * actions ignore this header entirely** (see `lib/session.ts`) — it is
 * purely a public-tenant resolution mechanism, not an auth bypass.
 *
 * Security: we always *strip* any client-supplied `x-tenant-slug` first,
 * so an attacker can't smuggle a header through to a downstream handler
 * that may not be auth-aware.
 */
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

  // 1) path: /c/<slug>/...
  const pathMatch = url.pathname.match(/^\/c\/([a-z0-9-]+)(\/|$)/i);
  if (pathMatch) {
    requestHeaders.set("x-tenant-slug", pathMatch[1].toLowerCase());
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // 2) subdomain: <slug>.kinesoft.app
  const hostParts = host.split(":")[0].split(".");
  if (hostParts.length >= 3 && !["www", "app", "api"].includes(hostParts[0])) {
    requestHeaders.set("x-tenant-slug", hostParts[0].toLowerCase());
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
