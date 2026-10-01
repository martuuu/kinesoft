import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { hashKeyPart, rateLimitAll } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { env } from "@/lib/env";
import { isAllowedOrigin, safeNext } from "@/lib/safe-next";

export const runtime = "nodejs";

/**
 * Login con email + contraseña (form POST desde /login).
 *
 * A3b-S-auth:
 *   - los errores vuelven como CÓDIGO (`?error=invalid_credentials`), nunca
 *     como texto: /login los traduce con un mapa cerrado, así un link
 *     `/login?error=<texto libre>` ya no pinta lo que el atacante quiera;
 *   - `next` pasa por `safeNext` (antes: open redirect con `next=//evil.com`)
 *     y se propaga en cada vuelta al login para no perder el destino;
 *   - chequeo de Origin: un sitio ajeno no puede loguear a la víctima en una
 *     cuenta del atacante (login CSRF).
 */
function backToLogin(req: Request, error: string, next: string) {
  const u = new URL("/login", req.url);
  u.searchParams.set("error", error);
  if (next !== "/dashboard") u.searchParams.set("next", next);
  return NextResponse.redirect(u, { status: 303 });
}

export async function POST(req: Request) {
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  if (!isAllowedOrigin(req.headers, [new URL(req.url).origin, env.NEXT_PUBLIC_APP_URL])) {
    return new NextResponse("Origen no permitido.", { status: 403 });
  }

  const formData = await req.formData();
  const email = formData.get("email")?.toString().trim();
  const password = formData.get("password")?.toString();

  // A3a-S-rl: por IP (10/min) y además por hash del email (10 / 15 min), así
  // un credential-stuffing que rota IPs contra una misma cuenta igual se
  // corta. El email nunca va en claro a la clave. Es un form POST → 303 de
  // vuelta al login con `?error=rate_limited` (antes: 429 en texto plano,
  // pantalla en blanco para el usuario).
  const rl = await rateLimitAll([
    { key: `login:ip:${clientIp(req.headers)}`, limit: 10, windowMs: 60_000 },
    ...(email
      ? [{ key: `login:email:${hashKeyPart(email)}`, limit: 10, windowMs: 15 * 60_000 }]
      : []),
  ]);
  if (!rl.ok) return backToLogin(req, "rate_limited", next);

  if (!email || !password) return backToLogin(req, "missing_credentials", next);

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Supabase distingue "no confirmó el email" de "clave mala"; lo primero
    // se le dice (tiene arreglo: buscar el mail), lo segundo queda genérico
    // para no confirmar qué emails existen.
    return backToLogin(
      req,
      error.code === "email_not_confirmed" ? "email_not_confirmed" : "invalid_credentials",
      next
    );
  }

  return NextResponse.redirect(new URL(next, req.url), { status: 303 });
}
