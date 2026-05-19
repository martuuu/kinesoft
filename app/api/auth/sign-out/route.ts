import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Signs the current Supabase session out. Used by the patient portal
 * "Cerrar sesión" form and (eventually) the practitioner top-bar.
 */
export async function POST() {
  const supabase = getSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(`${env.NEXT_PUBLIC_APP_URL}/portal`, { status: 303 });
}
