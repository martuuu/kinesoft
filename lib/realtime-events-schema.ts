/**
 * Schema zod del mensaje realtime de la agenda (SV, C-SV2 — FIRMA CONGELADA).
 *
 * PF1.0-a (C-PF3): vivía en `lib/realtime-events.ts`, que importa el cliente (el shell de `(app)` vía
 * `realtime-provider`/`arrival-alerts`), y arrastraba zod a todas las rutas del workspace. El browser valida ahora con
 * `lib/realtime-message-guard.ts` (TS puro); este schema queda como la referencia de la semántica: el test de
 * equivalencia (`tests/unit/realtime-message-guard.test.ts`) compara el guard contra él caso por caso, y los tests
 * del publisher validan lo que sale con él.
 *
 * Sin `import "server-only"` a propósito: hoy solo lo importan tests (vitest corre fuera de Next), y el guard de
 * bundle de PF (`--explain`) es el que verifica que no vuelva al cliente. Si un módulo de app lo importa, que sea
 * server.
 */
import { z } from "zod";
import { REALTIME_KINDS, type RealtimeAgendaMessage } from "@/lib/realtime-message-guard";

const idSchema = z.string().min(1).max(64);
/** Día AR (`toARDateKey`), nunca el `toISOString().slice(0,10)` del host. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const RealtimeAgendaMessageSchema = z
  .object({
    v: z.literal(1),
    kind: z.enum(REALTIME_KINDS),
    bookingId: idSchema.optional(),
    practitionerId: idSchema.nullable(),
    day: daySchema.nullable(),
    roomId: idSchema.nullable().optional(),
    prev: z
      .object({
        practitionerId: idSchema,
        day: daySchema,
        roomId: idSchema.nullable().optional(),
      })
      .strict()
      .optional(),
    at: z.string().datetime(),
  })
  .strict();

// El tipo declarado a mano en el guard y el inferido del schema tienen que ser el mismo en las dos direcciones.
type Inferred = z.infer<typeof RealtimeAgendaMessageSchema>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _typesMatch: Same<Inferred, RealtimeAgendaMessage> = true;
void _typesMatch;
