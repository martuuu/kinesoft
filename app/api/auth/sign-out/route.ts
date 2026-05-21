import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Signs the current Supabase session out and bounces back to the
 * practitioner login. The patient portal (which has its own sign-out
 * form) can pass `?next=/portal` to override the destination.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  await supabase.auth.signOut();
  const url = new URL(req.url);
  const next = url.searchParams.get("next") ?? "/login";
  return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}${next}`, { status: 303 });
}
