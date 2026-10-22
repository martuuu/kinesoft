import { fakeMpAllowed } from "@/lib/env";

/**
 * Mercado Pago FALSO (T5 TP-P4, C-TP12, brief §25.9). 404 salvo `MP_CONNECT_MODE=fake` y sin `VERCEL_ENV`/`VERCEL`
 * (se mira en cada request, no en el build). El módulo del simulador se importa recién después del guard: fuera de
 * fake ni se carga.
 *
 * Por qué NO `/api/mp/fake` a secas: el catch-all no matchea la raíz; el panel del simulador vive en
 * `/api/mp/fake/panel`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: Request): Promise<Response> {
  if (!fakeMpAllowed()) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const { fakeMpHandle } = await import("@/lib/mp-connect/fake-mp");
  return fakeMpHandle(req);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
