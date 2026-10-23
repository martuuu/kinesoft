import "server-only";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { logger } from "@/lib/logger";
import { whatsappMode } from "@/lib/env";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import { getLiveAccountCached } from "@/lib/whatsapp/account-internal";
import { phoneHash, maskPhone } from "@/lib/whatsapp/crypto";
import { GRAPH_INLINE_TIMEOUT_MS } from "@/lib/whatsapp/graph";
import { classifyRef, eligibility, groupSeries, idemKey, WA_MIN_LEAD_MS, type WaSeriesItem } from "@/lib/whatsapp/logic";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";
import type { WaConsentStatus, WaMessageKind } from "@/lib/whatsapp/types";
import { dispatch, enqueue, type WaEnqueueRow } from "@/lib/whatsapp/outbox-internal";

/**
 * WA-S2 (T6, C-WA8, brief §26.5) · Paso 3 de `afterBookingsCommitted`: los avisos de WhatsApp de un cambio de turno.
 *
 * Por qué acá y no en cada write path (WA-D18): el hook post-commit ya es el punto único por el que pasan TODOS los
 * write paths de `Booking` (agenda, Planes, turnero, webhook de MP, candado; lo fija SV08), y ya corre después del
 * commit y fuera de la tx. Encolar adentro de cada tx sumaría sentencias a la tabla caliente y haría que un problema
 * de WhatsApp pudiera abortar el alta de un turno.
 *
 * Contrato:
 *   - Con `WHATSAPP_MODE=off` lo corta el caller ANTES de importar este módulo: CERO sentencias (el test cuenta).
 *     Igual se re-chequea acá (defensa en profundidad).
 *   - NUNCA tira: el turno ya está escrito. Todo va en un try y se loguea sin PHI.
 *   - Solo refs de turno (`kind` booking o sin kind): Recepción y el llamado de la sala no le escriben al paciente.
 *   - Cuenta cacheada (0 sentencias con el cache caliente); si no está ACTIVE en el modo vigente o el consultorio
 *     apagó `autoBookingNotice`, sale.
 *   - UNA sentencia para los turnos + el consentimiento del paciente; otra (solo si hay candidatos a «agendado» o a
 *     serie) para ver qué avisos ya existen; UNA para encolar.
 *   - Claves: `bc:<id>` (agendado), `bm:<id>:<epoch>` (reprogramado), `bs:<serie>:<epoch>` (una por serie o plan).
 *   - Envío inline de hasta 3 mensajes en ≤ 2,5 s, con breaker: 3 timeouts seguidos → 60 s sin inline (Meta caído no
 *     le suma 2,5 s a cada alta de turno). Lo que no salió inline lo drena el webhook de estados o el cron.
 */

const INLINE_MAX = 3;
const INLINE_BUDGET_MS = GRAPH_INLINE_TIMEOUT_MS;
const BREAKER_TIMEOUTS = 3;
const BREAKER_OPEN_MS = 60_000;
/** Por debajo de esto no se intenta otro envío inline. */
const INLINE_MIN_LEFT_MS = 300;
const SENT_LIKE = new Set(["SENDING", "SENT", "DELIVERED", "READ"]);

// Estado del breaker por instancia (lambda). No hace falta compartirlo: cada lambda caliente aprende sola.
const breaker = { timeouts: 0, openUntil: 0 };

/** Tests: el breaker arranca cerrado en cada caso. */
export function __resetWaHookBreakerForTests(): void {
  breaker.timeouts = 0;
  breaker.openUntil = 0;
}

export type WaHookResult = { enqueued: string[]; inline: number; reason?: string };

type Row = {
  id: string;
  status: string;
  patientId: string | null;
  scheduledFor: Date;
  createdAt: Date;
  seriesId: string | null;
  programId: string | null;
  phone: string | null;
  waConsent: WaConsentStatus | null;
  waPhoneE164: string | null;
};

type Candidate = WaSeriesItem & {
  patientId: string;
  e164: string;
  cls: "created" | "moved";
  /** El ref trae un cambio de horario (con o sin la ventana de «recién creado»). */
  timeChanged: boolean;
};

const seriesKeyOf = (c: { seriesId: string | null; programId: string | null }) => c.seriesId ?? (c.programId ? `p.${c.programId}` : null);
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function runWhatsAppBookingHook(tenantId: string, refs: ReadonlyArray<BookingChangeRef>): Promise<WaHookResult> {
  const out: WaHookResult = { enqueued: [], inline: 0 };
  try {
    const mode = whatsappMode();
    if (mode === "off") return { ...out, reason: "off" };
    // El último ref de cada turno manda (un commit puede traer el mismo turno dos veces).
    const byId = new Map<string, BookingChangeRef>();
    for (const r of refs) if (!r.kind || r.kind === "booking") byId.set(r.bookingId, r);
    if (byId.size === 0) return { ...out, reason: "no_booking_refs" };

    const acc = await getLiveAccountCached(tenantId);
    if (!acc || acc.status !== "ACTIVE" || acc.mode !== mode) return { ...out, reason: "no_account" };
    if (!acc.autoBookingNotice) return { ...out, reason: "disabled" };
    const connectedAt = new Date(acc.connectedAt);

    const ids = [...byId.keys()];
    const rows = await prismaService.$queryRaw<Row[]>`
      SELECT b."id", b."status"::text AS "status", b."patientId", b."scheduledFor", b."createdAt", b."seriesId", b."programId",
             p."phone", p."waConsent"::text AS "waConsent", p."waPhoneE164"
        FROM "Booking" b
        LEFT JOIN "Patient" p ON p."id" = b."patientId" AND p."tenantId" = b."tenantId"
       WHERE b."tenantId" = ${tenantId} AND b."id" IN (${Prisma.join(ids)})`;

    const now = new Date();
    const cands: Candidate[] = [];
    for (const b of rows) {
      const ref = byId.get(b.id)!;
      const cls = classifyRef(ref, b, now, connectedAt);
      if (!cls) continue;
      const e = eligibility(
        {
          status: b.status,
          patientId: b.patientId,
          scheduledFor: b.scheduledFor,
          patient: b.patientId ? { phone: b.phone, waConsent: b.waConsent, waPhoneE164: b.waPhoneE164 } : null,
        },
        now
      );
      if (!e.ok) continue;
      cands.push({
        bookingId: b.id,
        seriesId: b.seriesId,
        programId: b.programId,
        scheduledFor: b.scheduledFor,
        patientId: b.patientId!,
        e164: e.e164,
        cls,
        timeChanged: Boolean(ref.prev && ref.prev.scheduledFor.getTime() !== ref.scheduledFor.getTime()),
      });
    }
    if (cands.length === 0) return { ...out, reason: "nothing_eligible" };

    const groups = groupSeries(cands);

    // Qué avisos ya existen: el «agendado» de los recién creados y cualquier aviso de serie de esas series. Sin esto,
    // editar (sin mover) un turno de una serie dentro de las 2 h le mandaría un «agendado» suelto a quien ya recibió el
    // «tenés N turnos», y mover un turno cuyo «agendado» ya salió no avisaría la hora nueva (handoff WA-P1).
    const bcKeys: string[] = [];
    const seriesKeys = new Set<string>();
    for (const g of groups) {
      if (g.seriesKey) seriesKeys.add(g.seriesKey);
      else {
        const c = g.first;
        if (c.cls === "created") {
          bcKeys.push(idemKey({ t: "bc", bookingId: c.bookingId }));
          const sk = seriesKeyOf(c);
          if (sk) seriesKeys.add(sk);
        }
      }
    }
    const existing = new Map<string, { status: string; bookingScheduledFor: Date | null }>();
    const seriesWithNotice = new Set<string>();
    if (bcKeys.length > 0 || seriesKeys.size > 0) {
      const patterns = [...seriesKeys].map((k) => `bs:${likeEscape(k)}:%`);
      const found = await prismaService.$queryRaw<{ idempotencyKey: string; status: string; bookingScheduledFor: Date | null }[]>`
        SELECT "idempotencyKey", "status"::text AS "status", "bookingScheduledFor" FROM "WhatsAppMessage"
         WHERE "tenantId" = ${tenantId}
           AND ("idempotencyKey" = ANY(${bcKeys}::text[]) OR "idempotencyKey" LIKE ANY(${patterns}::text[]))`;
      for (const f of found) {
        if (f.idempotencyKey.startsWith("bs:")) seriesWithNotice.add(f.idempotencyKey.slice(3, f.idempotencyKey.lastIndexOf(":")));
        else existing.set(f.idempotencyKey, f);
      }
    }

    // Hash y máscara FUERA de toda tx: `phoneHash` tira en Vercel sin service key (falla cerrada, hallazgo 3 de WA-P3).
    const rowsToQueue: WaEnqueueRow[] = [];
    const push = (kind: WaMessageKind, key: string, c: Candidate, extra: Partial<WaEnqueueRow> = {}) => {
      rowsToQueue.push({
        tenantId,
        accountId: acc.id,
        kind,
        trigger: "AUTO",
        idempotencyKey: key,
        patientId: c.patientId,
        bookingId: c.bookingId,
        bookingScheduledFor: c.scheduledFor,
        templateName: TEMPLATE_SPECS[kind as keyof typeof TEMPLATE_SPECS].name,
        toHash: phoneHash(c.e164),
        toMasked: maskPhone(c.e164),
        // WA-D4: después de esto el aviso ya no sirve (el paciente está en camino); el cron lo vence.
        expiresAt: new Date(c.scheduledFor.getTime() - WA_MIN_LEAD_MS),
        ...extra,
      });
    };
    const moved = (c: Candidate) => push("BOOKING_MOVED", idemKey({ t: "bm", bookingId: c.bookingId, scheduledFor: c.scheduledFor }), c);

    for (const g of groups) {
      if (g.seriesKey) {
        // Una serie que solo se editó (sin mover) y ya tiene su aviso no manda otro.
        if (!g.bookings.some((c) => c.timeChanged) && seriesWithNotice.has(g.seriesKey)) continue;
        push("BOOKINGS_UPDATED", idemKey({ t: "bs", seriesKey: g.seriesKey, scheduledFor: g.first.scheduledFor }), g.first, {
          seriesCount: Math.min(g.bookings.length, 500),
        });
        continue;
      }
      const c = g.first;
      if (c.cls === "moved") {
        moved(c);
        continue;
      }
      const sk = seriesKeyOf(c);
      if (sk && seriesWithNotice.has(sk)) {
        if (c.timeChanged) moved(c);
        continue;
      }
      const bcKey = idemKey({ t: "bc", bookingId: c.bookingId });
      const bc = existing.get(bcKey);
      if (!bc) {
        push("BOOKING_CREATED", bcKey, c);
        continue;
      }
      // El «agendado» ya salió (o está saliendo) con otra hora: avisar la nueva. Si sigue QUEUED, sale con la vigente.
      if (c.timeChanged && SENT_LIKE.has(bc.status) && bc.bookingScheduledFor?.getTime() !== c.scheduledFor.getTime()) moved(c);
    }
    if (rowsToQueue.length === 0) return { ...out, reason: "already_noticed" };

    out.enqueued = await enqueue(rowsToQueue);

    // ── Envío inline acotado ──
    if (Date.now() < breaker.openUntil) return { ...out, reason: "breaker_open" };
    const t0 = Date.now();
    for (const id of out.enqueued.slice(0, INLINE_MAX)) {
      const left = INLINE_BUDGET_MS - (Date.now() - t0);
      if (left < INLINE_MIN_LEFT_MS) break;
      const r = await dispatch(id, { tenantId, inline: true, budgetMs: left });
      out.inline += 1;
      if (r.outcome === "timeout") {
        breaker.timeouts += 1;
        if (breaker.timeouts >= BREAKER_TIMEOUTS) {
          breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
          breaker.timeouts = 0;
          logger.warn("whatsapp.hook.breaker_open", { tenantId });
          break;
        }
      } else if (r.outcome !== "not_claimed") {
        breaker.timeouts = 0;
      }
    }
    return out;
  } catch (e) {
    try {
      logger.error("whatsapp.hook.failed", { tenantId, refs: refs.length, err: e instanceof Error ? e.name : "unknown" });
    } catch {
      // sin salida
    }
    return { ...out, reason: "error" };
  }
}
