import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { rateLimitHandler } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Kicks off the Supabase Google OAuth flow. Used by both the practitioner
 * login form and the patient portal sign-in button.
 *
 * Supabase returns a one-time URL that opens the Google consent screen and
 * redirects back to `/auth/callback?code=...`.
 */
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "anon";
  const limited = await rateLimitHandler(`oauth:${ip}`, { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const supabase = getSupabaseServerClient();
  const next = new URL(req.url).searchParams.get("next") ?? "/dashboard";
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=${encodeURIComponent(next)}`,
      queryParams: { access_type: "offline", prompt: "consent" },
    },
  });
  if (error || !data.url) {
    return NextResponse.json({ error: error?.message ?? "oauth_failed" }, { status: 400 });
  }
  return NextResponse.redirect(data.url, { status: 303 });
}
