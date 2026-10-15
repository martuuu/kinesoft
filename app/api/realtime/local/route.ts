import { env } from "@/lib/env";
import { tryGetActor } from "@/lib/session";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { realtimeAllowed } from "@/lib/realtime-bootstrap";
import { subscribe } from "@/lib/realtime-local-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/realtime/local — SSE del driver `local` (SV07b, §18.2 «Cliente»).
 *
 * Solo para dev/QA multi-pestaña sin Supabase: con `REALTIME_DRIVER !== "local"`
 * la ruta no existe (404), y `lib/env.ts` prohíbe `local` en Production (SV-D11).
 * En Vercel tampoco serviría: el `maxDuration` corta el stream (ADR-006).
 *
 * Reenvía al browser lo que el publisher emite al bus en memoria del consultorio
 * del actor (`lib/realtime-local-bus.ts`), y nada de otro consultorio: el
 * `tenantId` sale de la sesión, nunca del request.
 *
 * Misma regla de acceso que el bootstrap (`realtimeAllowed`: módulo `salaEspera`
 * + `agenda.reception`): si el layout no le dio realtime a este actor, la ruta
 * tampoco (BILLING → 403, sigue con el polling de 60 s).
 *
 * Formato: un evento `data: <JSON array de RealtimeAgendaMessage>` por `emit` (el
 * driver local los parsea con `parseIncomingBatch`) y un comentario `: ping` cada
 * 25 s para que ningún proxy ni el browser den la conexión por muerta.
 */
const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  if (env.REALTIME_DRIVER !== "local") return new Response("Not found", { status: 404 });

  const actor = await tryGetActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });
  const caps = await memberCapabilitiesForActor(actor);
  if (!realtimeAllowed(actor, caps)) return new Response("Forbidden", { status: 403 });

  const tenantId = actor.tenantId;
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // El stream ya se cerró del otro lado: limpiar y no volver a escribir.
          close();
        }
      };
      const unsubscribe = subscribe(tenantId, (messages) => {
        send(`data: ${JSON.stringify(messages)}\n\n`);
      });
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        req.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // ya cerrado
        }
      }
      cleanup = close;
      // Sin esto, cada pestaña cerrada deja un listener en el bus y un interval vivo.
      req.signal.addEventListener("abort", close);
      if (req.signal.aborted) return close();
      // Primer byte inmediato: dispara `onopen` del EventSource (el driver pasa a «En vivo»).
      send(": open\n\n");
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Desactiva el buffering de nginx/proxies que agrupan el stream.
      "x-accel-buffering": "no",
    },
  });
}
