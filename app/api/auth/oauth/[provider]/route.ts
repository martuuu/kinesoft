import { NextResponse } from "next/server";
import { parseOAuthProvider, startOAuth } from "@/lib/oauth-start";

export const runtime = "nodejs";

/**
 * PL-2e (C-PL12) · `POST /api/auth/oauth/{google|facebook}?next=` — login y alta con Google o Facebook.
 *
 * Contrato para la UI (login/signup de VX): `<form method="post" action="/api/auth/oauth/<provider>?next=<path>">`.
 * La lógica (origen, rate limit, `safeNext`, proveedor apagado, errores a `/login?error=…`) vive en
 * `lib/oauth-start.ts`, compartida con el alias `/api/auth/google`.
 *
 * Un proveedor fuera de la allowlist es 404: no es un error de login, es una URL que no existe.
 */
export async function POST(req: Request, { params }: { params: { provider: string } }) {
  const provider = parseOAuthProvider(params.provider);
  if (!provider) return new NextResponse("No encontrado.", { status: 404 });
  return startOAuth(req, provider);
}
