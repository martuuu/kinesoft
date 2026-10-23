import { fakeGraphAllowed } from "@/lib/env";

/**
 * Meta FALSO (T6 WA-P3, C-WA5, brief §26.5). 404 salvo `WHATSAPP_MODE=fake` y sin `VERCEL_ENV`/`VERCEL` (se mira en
 * cada request, no en el build). El módulo del simulador se importa recién después del guard: fuera de fake ni se carga.
 *
 * Por qué NO `/api/whatsapp/fake` a secas: el catch-all no matchea la raíz; el panel vive en `/api/whatsapp/fake/panel`.
 * DELETE porque la Graph API desuscribe la app con `DELETE /{waba}/subscribed_apps`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: Request): Promise<Response> {
  if (!fakeGraphAllowed()) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const { fakeGraphHandle } = await import("@/lib/whatsapp/fake-graph");
  return fakeGraphHandle(req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
