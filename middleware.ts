import { NextResponse, type NextRequest } from "next/server";

/**
 * Resolve tenant from:
 *   1. /c/<slug>/...        (path-based, primary)
 *   2. <slug>.kinesoft.app  (subdomain)
 *
 * Forwards the slug to downstream handlers via `x-tenant-slug`.
 * Marketing, login, portal and api routes are skipped.
 */
export function middleware(req: NextRequest) {
  const url = req.nextUrl;
  const host = req.headers.get("host") ?? "";

  // Skip static + api routes
  if (url.pathname.startsWith("/_next") || url.pathname.startsWith("/api/webhooks")) {
    return NextResponse.next();
  }

  const requestHeaders = new Headers(req.headers);

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
