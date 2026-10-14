/**
 * Publisher realtime fake (SV04a). Lo instala `tests/helpers/integration-setup.ts`
 * como mock global de `@/lib/realtime-publisher-internal` (integración Y perf) y
 * lo pueden usar los unit tests vía `__setRealtimePublisherForTests`.
 *
 * Registro a mano (`calls`, `fail`, `latencyMs`, `reset()`), no `vi.fn`: con
 * vitest 2.1.9 un `vi.fn` que tira a través de un mock rompía el test aunque el
 * código bajo test atrapara el error. Por la misma razón, `fail` NO tira:
 * devuelve `{ok:false, reason:"error"}`, que es lo que hace el publisher real
 * (nunca tira).
 *
 * `onCall` (opcional): corre ANTES de responder, con la llamada ya registrada;
 * sirve para afirmar «post-commit» (la fila ya está en la base al publicar).
 */
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import type {
  AvailabilityScope,
  PublishResult,
  RealtimePublisher,
} from "@/lib/realtime-publisher-internal";
import { buildRealtimeMessages } from "@/lib/realtime-events";

export type RealtimeFakeCall = {
  tenantId: string;
  refs?: BookingChangeRef[];
  availability?: AvailabilityScope;
};

export const realtimeFake = {
  calls: [] as RealtimeFakeCall[],
  fail: false,
  latencyMs: 0,
  onCall: null as ((call: RealtimeFakeCall) => void | Promise<void>) | null,
  reset() {
    this.calls = [];
    this.fail = false;
    this.latencyMs = 0;
    this.onCall = null;
  },
};

async function respond(call: RealtimeFakeCall, messages: number): Promise<PublishResult> {
  realtimeFake.calls.push(call);
  if (realtimeFake.onCall) await realtimeFake.onCall(call);
  if (realtimeFake.latencyMs > 0) {
    await new Promise((r) => setTimeout(r, realtimeFake.latencyMs));
  }
  if (realtimeFake.fail) return { ok: false, reason: "error" };
  return { ok: true, messages };
}

export const realtimePublisherFake: RealtimePublisher = {
  publishBookingChanges(tenantId, refs) {
    // Copia: el caller podría reusar el array después del publish.
    const copy = refs.map((r) => ({ ...r }));
    return respond({ tenantId, refs: copy }, buildRealtimeMessages(copy, new Date()).length);
  },
  publishAvailability(tenantId, scope) {
    return respond({ tenantId, availability: { ...scope } }, 1);
  },
};
