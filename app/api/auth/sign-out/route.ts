import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { isAllowedOrigin, safeNext } from "@/lib/safe-next";

export const runtime = "nodejs";

/**
 * Signs the current Supabase session out and bounces back to the
 * practitioner login. The patient portal (which has its own sign-out
 * form) can pass `?next=/portal` to override the destination.
 *
 * A3b-S-auth: `next` pasa por `safeNext` (antes `${APP_URL}${next}` con
 * `next=@evil.com` daba `https://app…@evil.com`) y se exige Origin propio
 * (un sitio ajeno no puede desloguear a nadie con un form auto-submit).
 */
export async function POST(req: Request) {
  if (!isAllowedOrigin(req.headers, [new URL(req.url).origin, env.NEXT_PUBLIC_APP_URL])) {
    return new NextResponse("Origen no permitido.", { status: 403 });
  }
  const supabase = getSupabaseServerClient();
  await supabase.auth.signOut();
  const next = safeNext(new URL(req.url).searchParams.get("next"), "/login");
  return NextResponse.redirect(new URL(next, env.NEXT_PUBLIC_APP_URL), { status: 303 });
}
