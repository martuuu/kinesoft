/**
 * Mensaje del canal realtime de la agenda (SV, C-SV2 — FIRMA CONGELADA).
 *
 * Puro y client-safe: el publisher (server) arma los mensajes con
 * `buildRealtimeMessages` y el browser valida lo que recibe con
 * `lib/realtime-message-guard.ts` (misma semántica que el schema zod de
 * `lib/realtime-events-schema.ts`, probada por corpus).
 *
 * Por qué el payload es tan pobre (§18.2): es un «tocá acá», no un dato. El
 * cliente nunca lo muestra ni lo confía; con `day`/`practitionerId` decide si le
 * toca y RE-PIDE con las actions de la página (que pasan por `getActor` y el
 * `where: { tenantId }`). Así el canal no lleva PHI (nada de paciente, título,
 * notas ni montos) y un mensaje viejo o duplicado solo cuesta un refetch.
 * `.strict()` en los dos lados: una clave nueva tiene que pasar por este archivo
 * (y por la revisión de PHI), no colarse en el payload.
 *
 * `BookingChangeRef` se importa como `import type`: TS lo borra al compilar, así
 * que el `import "server-only"` de `booking-events-internal` NO llega al bundle
 * del cliente (solo el tipo). Si algún día este import arrastrara código, el
 * reemplazo es un tipo estructural mínimo acá mismo al que `BookingChangeRef`
 * siga siendo asignable.
 */
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import { toARDateKey } from "@/lib/datetime-ar";
import { MAX_MESSAGES_PER_POST, type RealtimeDriverName } from "@/lib/realtime-constants";
import { type RealtimeAgendaMessage, type RealtimeKind } from "@/lib/realtime-message-guard";

// PF1.0-a (C-PF3): el schema zod se mudó a `lib/realtime-events-schema.ts` y el browser valida con
// `lib/realtime-message-guard.ts` (TS puro). Este módulo lo importa el shell de `(app)` y con zod adentro sumaba
// ~13 kB gz a cada ruta del workspace. Los nombres se re-exportan para no tocar a los importadores de tipos.
export { REALTIME_KINDS, type RealtimeAgendaMessage, type RealtimeKind } from "@/lib/realtime-message-guard";

/** DTO client-safe que el layout le pasa al `RealtimeProvider` (lo arma `realtimeBootstrap`). */
export type RealtimeBootstrap = {
  driver: RealtimeDriverName;
  url?: string;
  anonKey?: string;
  tenantId: string;
};

type Kinds = Set<RealtimeKind>;

/** Un solo kind si todos coinciden; mezclados → "booking" (el cliente re-pide igual). */
function collapsedKind(kinds: Kinds): RealtimeKind {
  return kinds.size === 1 ? (kinds.values().next().value as RealtimeKind) : "booking";
}

/**
 * Refs de un commit → mensajes listos para UN POST.
 *
 * - `day` y `prev.day` en hora AR (un turno 23:30 AR es 02:30 UTC del día
 *   siguiente: con el día del host la agenda equivocada re-pediría).
 * - Dedupe por `(bookingId, kind)` quedándose con el último: si un mismo commit
 *   toca dos veces un turno, el estado final es el que importa.
 * - SV-D10: más de `MAX_MESSAGES_PER_POST` → uno por `(practitionerId, day)`
 *   (los `prev` también cuentan como clave, si no la agenda de origen de un
 *   movimiento no se enteraría); si siguen siendo más → uno por profesional con
 *   `day: null`; si siguen siendo más (más de 20 profesionales) → uno solo para
 *   todo el consultorio. Colapsar pierde `bookingId`/`roomId`/`prev`: el cliente
 *   re-pide el rango entero, que es lo correcto ante un cambio masivo.
 */
export function buildRealtimeMessages(
  refs: ReadonlyArray<BookingChangeRef>,
  now: Date
): RealtimeAgendaMessage[] {
  if (refs.length === 0) return [];
  const at = now.toISOString();

  const byKey = new Map<string, RealtimeAgendaMessage>();
  for (const ref of refs) {
    const kind: RealtimeKind = ref.kind ?? "booking";
    const msg: RealtimeAgendaMessage = {
      v: 1,
      kind,
      bookingId: ref.bookingId,
      practitionerId: ref.practitionerId,
      day: toARDateKey(ref.scheduledFor),
      at,
    };
    if (ref.roomId !== undefined) msg.roomId = ref.roomId;
    if (ref.prev) {
      msg.prev = { practitionerId: ref.prev.practitionerId, day: toARDateKey(ref.prev.scheduledFor) };
      if (ref.prev.roomId !== undefined) msg.prev.roomId = ref.prev.roomId;
    }
    const key = `${ref.bookingId}\u0000${kind}`;
    // delete + set: el último gana también en el orden de salida.
    byKey.delete(key);
    byKey.set(key, msg);
  }
  const messages = Array.from(byKey.values());
  if (messages.length <= MAX_MESSAGES_PER_POST) return messages;

  // Nivel 1: (practitionerId, day), incluyendo los `prev`.
  const byDay = new Map<string, { practitionerId: string; day: string; kinds: Kinds }>();
  const addDay = (practitionerId: string, day: string, kind: RealtimeKind) => {
    const key = `${practitionerId}\u0000${day}`;
    const cur = byDay.get(key) ?? { practitionerId, day, kinds: new Set<RealtimeKind>() };
    cur.kinds.add(kind);
    byDay.set(key, cur);
  };
  for (const m of messages) {
    // `practitionerId`/`day` nunca son null acá: salen de refs reales.
    addDay(m.practitionerId as string, m.day as string, m.kind);
    if (m.prev) addDay(m.prev.practitionerId, m.prev.day, m.kind);
  }
  if (byDay.size <= MAX_MESSAGES_PER_POST) {
    return Array.from(byDay.values(), (g) => ({
      v: 1 as const,
      kind: collapsedKind(g.kinds),
      practitionerId: g.practitionerId,
      day: g.day,
      at,
    }));
  }

  // Nivel 2: un mensaje por profesional, cualquier día.
  const byPractitioner = new Map<string, Kinds>();
  for (const g of byDay.values()) {
    const kinds = byPractitioner.get(g.practitionerId) ?? new Set<RealtimeKind>();
    g.kinds.forEach((k) => kinds.add(k));
    byPractitioner.set(g.practitionerId, kinds);
  }
  if (byPractitioner.size <= MAX_MESSAGES_PER_POST) {
    return Array.from(byPractitioner.entries(), ([practitionerId, kinds]) => ({
      v: 1 as const,
      kind: collapsedKind(kinds),
      practitionerId,
      day: null,
      at,
    }));
  }

  // Nivel 3: todo el consultorio.
  const all = new Set<RealtimeKind>();
  byPractitioner.forEach((kinds) => kinds.forEach((k) => all.add(k)));
  return [{ v: 1, kind: collapsedKind(all), practitionerId: null, day: null, at }];
}

/**
 * Candado del día y bloqueos (SV-D12): no hay turnos que avisar pero cambió la
 * disponibilidad; la agenda hace `router.refresh()`. `practitionerId: null` =
 * candado de todo el consultorio. `day: null` (FX1b, aditivo) = varios días: un
 * bloqueo de una semana avisa con UN mensaje y el cliente re-pide lo que esté
 * mirando (el schema ya admitía `day: null` para el colapso de SV-D10).
 */
export function availabilityMessage(
  scope: { practitionerId: string | null; day: string | null },
  now: Date
): RealtimeAgendaMessage {
  return {
    v: 1,
    kind: "availability",
    practitionerId: scope.practitionerId,
    day: scope.day,
    at: now.toISOString(),
  };
}
