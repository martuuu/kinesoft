import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimitHandler } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "anon";
  const limited = await rateLimitHandler(`login:${ip}`, { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const formData = await req.formData();
  const email = formData.get("email")?.toString();
  const password = formData.get("password")?.toString();
  const next = new URL(req.url).searchParams.get("next") ?? "/dashboard";

  if (!email || !password) {
    return NextResponse.redirect(new URL("/login?error=Faltan%20credenciales", req.url), { status: 303 });
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    // Si hay error en Supabase (ej. password incorrecto), devolvemos al login con error
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent("Credenciales inválidas")}`, req.url), { status: 303 });
  }

  // Redirigir al dashboard si todo sale bien
  return NextResponse.redirect(new URL(next, req.url), { status: 303 });
}
