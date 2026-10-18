"use server";

/**
 * HF-1a (H-RT1, plan §22.4) · «Probar desde el servidor» de `/plataforma/sistema`.
 *
 * `requirePlatformAdmin("platform.read")` (la misma barrera que la lectura de Sistema: es diagnóstico, no cambia
 * nada) → config de `env` (ya recortada) → `runRealtimeProbe` con el `WebSocket` global de este runtime. Devuelve
 * `SUBSCRIBED` o el motivo; nunca el token (ver `lib/platform-realtime-probe-internal.ts`).
 *
 * Una prueba a la vez por proceso: dos clics seguidos esperan la misma (cada una abre un socket a Supabase y el cupo
 * de `platform.read`, 600/min, no frena eso).
 */
import { env } from "@/lib/env";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import {
  runRealtimeProbe,
  type ProbeSocketCtor,
  type RealtimeProbeReport,
} from "@/lib/platform-realtime-probe-internal";
import type { ActionResult } from "@/lib/validation";

let inFlight: Promise<RealtimeProbeReport> | null = null;

export async function probeRealtimeFromServer(): Promise<ActionResult<RealtimeProbeReport>> {
  await requirePlatformAdmin("platform.read");
  if (!inFlight) {
    inFlight = runRealtimeProbe({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      secret: env.SUPABASE_JWT_SECRET,
      kid: env.SUPABASE_JWT_KID,
      WebSocketCtor: (globalThis as { WebSocket?: ProbeSocketCtor }).WebSocket,
    }).finally(() => {
      inFlight = null;
    });
  }
  return { ok: true, data: await inFlight };
}
