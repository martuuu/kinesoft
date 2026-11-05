"use server";

/**
 * Reparto de % entre profesionales (CF2 · P.3, plan §29: decisión 4 de Martin + D-CF2-18) · actions.
 *
 * - `listRevenueShares()`: todas las reglas del consultorio (vigentes + historial) y los receptores posibles. Lo
 *   llama el editor «Reparto» de Configuración → Profesionales al montar (lazy: no suma al loader de la página).
 * - `setRevenueShare(raw)`: «Guardar desde ahora». Cambiar = cerrar la vigente del que destina en `now` + abrir otra
 *   desde `now` (D-CF2-18: vigencia por INSTANTE, sin fechas retroactivas; lo ya cobrado no cambia). El trigger de
 *   M21 solo deja cerrar una vigente: la fila vieja queda tal cual y el historial no se reescribe.
 * - `endRevenueShare(raw)`: «Dejar de destinar» = cerrar la vigente en `now`.
 *
 * Gate: `tenant.sensitive` (D-CF2-18: «la edita quien tenga `tenant.sensitive`»: el Titular, o un Administrador/a o
 * Profesional con «Configuración»; la Secretaria y Facturación nunca, por el corte de staff de C-AS1). La lectura
 * pide lo mismo: el % que cada uno le pasa a otro es plata del equipo y la pantalla vive bajo ese mismo gate.
 * CF3 ZF5 (B, default de Martin pendiente): una regla cuyo «quien destina» es el Practitioner del Titular PRINCIPAL
 * reparte la plata del principal («la cuenta del principal», CT-K1): la crean o la cierran SOLO él (`account.owner`).
 * El co-titular (que tiene `tenant.sensitive` como el Titular) y un Admin o Profesional con «Configuración» siguen con
 * las demás. Se chequea en la tx, después del lock y antes del CAS (`isPrincipalOwnerPractitionerInTx`, 1 sentencia
 * que el principal no paga).
 * Soporte tiene `tenant.sensitive` en `SUPPORT_CAPS` pero NO lee (CF2-ZF3, ZA-4): el reparto es plata del equipo y
 * soporte tampoco ve la caja (`loadCajaPage` → `none`, BO2-E); antes la lectura le devolvía todas las reglas con
 * nombres y %. Sus escrituras caen además en la tx de solo lectura (no están en `SUPPORT_WRITABLE_ACTIONS`) y
 * `withReadOnlyResult` las devuelve con su copy.
 *
 * Concurrencia (plata: esfuerzo alto):
 *   1. advisory lock EXCLUSIVO `kinesoft:rshare:<tenant>` antes de leer nada (`lockRevenueSharesInTx`): las reglas
 *      se validan como grafo, así que A→B y B→A en paralelo se serializan y la segunda ve la primera (→ «mutuo»);
 *   2. CAS con `expectedOpenId` (la vigente que vio el editor; `null` = no había) contra la vigente leída bajo el
 *      lock: otra pestaña que guardó en el medio → «Cambió mientras lo editabas»;
 *   3. red: P2002 del único parcial o 23514 del trigger (un escritor que no tomó el lock) → el mismo copy. La tx
 *      entera se revierte, audit incluido (`auditInTx` va en la misma tx: el evento existe si y solo si el write).
 */
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import type { Capability } from "@/lib/capabilities";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { validateShareGraph } from "@/lib/revenue-share-logic";
import { EndRevenueShareSchema, SetRevenueShareSchema } from "@/lib/revenue-share-schemas";
import {
  assertSharePractitionersInTx,
  isPrincipalOwnerPractitionerInTx,
  isRevenueShareConflict,
  listRevenueSharesInTx,
  lockRevenueSharesInTx,
  openSharesInTx,
  sourcesOf,
} from "@/lib/revenue-share-internal";
import {
  REVENUE_SHARE_COPY,
  SHARE_GRAPH_ERROR_COPY,
  type RevenueShareListView,
  type ShareGraphError,
} from "@/lib/revenue-share-types";
import type { ActionResult } from "@/lib/validation";

// Mismo texto que el default de `requireTenantSensitive` (lib/authz.ts); acá vuelve en el resultado (un
// ForbiddenError llega redactado en prod y el editor muestra `r.error`).
const FORBIDDEN = "Solo el titular o el administrador (o un profesional con «Configuración») puede cambiar esto.";
const FORBIDDEN_READ = "Solo el titular o el administrador (o un profesional con «Configuración») puede ver el reparto.";
const SUPPORT_READ = "Soporte no ve el reparto ni la caja del consultorio.";
const GIVER_NOT_FOUND = "Profesional no encontrado.";
const SAVE_FAILED = "No pudimos guardar el reparto. Probá de nuevo.";
const PRINCIPAL_ONLY = "Esto lo puede hacer solo el titular principal.";

async function requireSensitive(message: string) {
  const actor = await getActor();
  const caps = await capabilitiesForActor(actor);
  if (!caps.has("tenant.sensitive")) return { ok: false as const, error: message };
  return { ok: true as const, actor, caps };
}

/**
 * CF3 ZF5: la regla del principal la toca solo él (ver la cabecera). `account.owner` = principal (nunca el co-titular,
 * ni soporte, ni por delegación); a él no le cuesta la sentencia.
 */
async function principalGiverBlocked(
  tx: Prisma.TransactionClient,
  tenantId: string,
  caps: ReadonlySet<Capability>,
  giverPractitionerId: string,
): Promise<boolean> {
  if (caps.has("account.owner")) return false;
  return isPrincipalOwnerPractitionerInTx(tx, tenantId, giverPractitionerId);
}

function revalidateShares() {
  // Después del commit: la caja (`/caja`) y el editor (`/configuracion`) leen las reglas.
  revalidatePath("/configuracion");
  revalidatePath("/caja");
}

export async function listRevenueShares(): Promise<ActionResult<RevenueShareListView>> {
  const gate = await requireSensitive(FORBIDDEN_READ);
  if (!gate.ok) return gate;
  // Mismo corte que `loadCajaPage` (`actor.support` → `none`): el % que cada uno le pasa a otro es plata del equipo.
  if (gate.actor.support) return { ok: false, error: SUPPORT_READ };
  const tenantId = gate.actor.tenantId;
  const data = await runWithRls(tenantId, (tx) => listRevenueSharesInTx(tx, tenantId));
  return { ok: true, data };
}

type TxOutcome<T> = { kind: "ok"; data: T; changed: boolean } | { kind: "error"; error: string };

const graphError = (e: ShareGraphError): TxOutcome<never> => ({ kind: "error", error: SHARE_GRAPH_ERROR_COPY[e] });
const conflict: TxOutcome<never> = { kind: "error", error: REVENUE_SHARE_COPY.conflict };

/**
 * El UPDATE de cierre no encontró la vigente (otro la cerró entre la lectura y el UPDATE): se TIRA para que
 * `runWithRls` haga ROLLBACK de lo que haya escrito la tx y `runShareTx` lo traduce a conflicto.
 */
class ConflictAbort extends Error {
  constructor() {
    super("revenueShare.conflict");
  }
}

/** Corre la tx y traduce las fallas: solo lectura → su copy; carrera de la base → conflicto; resto → genérico. */
async function runShareTx<T>(
  tenantId: string,
  event: string,
  fn: (tx: Prisma.TransactionClient) => Promise<TxOutcome<T>>,
): Promise<TxOutcome<T>> {
  try {
    return await runWithRls(tenantId, fn);
  } catch (e) {
    const ro = readOnlyFailure(e);
    if (ro) return { kind: "error", error: ro.error };
    if (e instanceof ConflictAbort || isRevenueShareConflict(e)) return conflict;
    logger.error(event, { err: e instanceof Error ? e.message : String(e) });
    return { kind: "error", error: SAVE_FAILED };
  }
}

export async function setRevenueShare(...args: Parameters<typeof setRevenueShareImpl>): ReturnType<typeof setRevenueShareImpl> {
  return withReadOnlyResult(() => setRevenueShareImpl(...args));
}

async function setRevenueShareImpl(raw: unknown): Promise<ActionResult<{ id: string }>> {
  const gate = await requireSensitive(FORBIDDEN);
  if (!gate.ok) return gate;
  const { actor, caps } = gate;
  const parsed = SetRevenueShareSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "Revisá los datos del reparto.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  const tenantId = actor.tenantId;

  const res = await runShareTx<{ id: string }>(tenantId, "revenueShare.set.failed", async (tx) => {
    await lockRevenueSharesInTx(tx, tenantId);
    const who = await assertSharePractitionersInTx(tx, tenantId, input);
    if (who === "giverNotFound") return { kind: "error", error: GIVER_NOT_FOUND };
    if (who === "receiverNotBookable") return { kind: "error", error: REVENUE_SHARE_COPY.receiverNotBookable };
    if (await principalGiverBlocked(tx, tenantId, caps, input.giverPractitionerId)) return { kind: "error", error: PRINCIPAL_ONLY };

    const open = await openSharesInTx(tx, tenantId);
    const current = open.find((r) => r.giverPractitionerId === input.giverPractitionerId) ?? null;
    if ((current?.id ?? null) !== input.expectedOpenId) return conflict;

    // Guardar lo mismo que ya rige no abre otra regla: sería una fila de historial idéntica (ruido en el editor y
    // en la caja) por un doble clic o un «Guardar» sin cambios.
    if (
      current &&
      current.receiverPractitionerId === input.receiverPractitionerId &&
      current.shareBps === input.shareBps &&
      current.appliesManual === input.sources.manual &&
      current.appliesOnline === input.sources.online &&
      current.appliesInsurer === input.sources.insurer
    ) {
      return { kind: "ok", data: { id: current.id }, changed: false };
    }

    const bad = validateShareGraph(open, {
      giverPractitionerId: input.giverPractitionerId,
      receiverPractitionerId: input.receiverPractitionerId,
    });
    if (bad) return graphError(bad);

    // `now` del server. Si la vigente empezara «después» (reloj de otra instancia adelantado unos ms), se cierra en
    // su propio `effectiveFrom`: el CHECK `period_check` exige `effectiveTo ≥ effectiveFrom` y una regla de duración
    // cero no aplica a ningún cobro (la caja usa `[from, to)`), que es lo correcto.
    let now = new Date();
    if (current && current.effectiveFrom > now) now = current.effectiveFrom;

    if (current) {
      // `effectiveTo: null` en el where: el CAS también a nivel fila (si otro la cerró, count 0 → conflicto).
      const closed = await tx.practitionerRevenueShare.updateMany({
        where: { id: current.id, tenantId, effectiveTo: null },
        data: { effectiveTo: now, closedById: actor.userId },
      });
      if (closed.count !== 1) throw new ConflictAbort();
    }
    const created = await tx.practitionerRevenueShare.create({
      data: {
        tenantId,
        giverPractitionerId: input.giverPractitionerId,
        receiverPractitionerId: input.receiverPractitionerId,
        shareBps: input.shareBps,
        appliesManual: input.sources.manual,
        appliesOnline: input.sources.online,
        appliesInsurer: input.sources.insurer,
        effectiveFrom: now,
        createdById: actor.userId,
      },
      select: { id: true },
    });
    await auditInTx(tx, {
      tenantId,
      actorId: actor.userId,
      action: "revenueShare.set",
      entity: "PractitionerRevenueShare",
      entityId: created.id,
      payload: {
        giverPractitionerId: input.giverPractitionerId,
        receiverPractitionerId: input.receiverPractitionerId,
        shareBps: input.shareBps,
        sources: input.sources,
        effectiveFrom: now.toISOString(),
        closedRuleId: current?.id ?? null,
        previous: current
          ? { receiverPractitionerId: current.receiverPractitionerId, shareBps: current.shareBps, sources: sourcesOf(current) }
          : null,
      },
    });
    return { kind: "ok", data: { id: created.id }, changed: true };
  });

  if (res.kind === "error") return { ok: false, error: res.error };
  if (res.changed) revalidateShares();
  return { ok: true, data: res.data };
}

export async function endRevenueShare(...args: Parameters<typeof endRevenueShareImpl>): ReturnType<typeof endRevenueShareImpl> {
  return withReadOnlyResult(() => endRevenueShareImpl(...args));
}

async function endRevenueShareImpl(raw: unknown): Promise<ActionResult<null>> {
  const gate = await requireSensitive(FORBIDDEN);
  if (!gate.ok) return gate;
  const { actor, caps } = gate;
  const parsed = EndRevenueShareSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos.", fieldErrors: parsed.error.flatten().fieldErrors };
  const input = parsed.data;
  const tenantId = actor.tenantId;

  const res = await runShareTx<null>(tenantId, "revenueShare.end.failed", async (tx) => {
    await lockRevenueSharesInTx(tx, tenantId);
    const who = await assertSharePractitionersInTx(tx, tenantId, { giverPractitionerId: input.giverPractitionerId });
    if (who !== "ok") return { kind: "error", error: GIVER_NOT_FOUND };
    if (await principalGiverBlocked(tx, tenantId, caps, input.giverPractitionerId)) return { kind: "error", error: PRINCIPAL_ONLY };
    const open = await openSharesInTx(tx, tenantId);
    const current = open.find((r) => r.giverPractitionerId === input.giverPractitionerId) ?? null;
    // Lo que vio el editor ya no rige (otra pestaña la cambió o la cerró): no se cierra a ciegas la que haya ahora.
    if (!current || current.id !== input.expectedOpenId) return conflict;

    let now = new Date();
    if (current.effectiveFrom > now) now = current.effectiveFrom;
    const closed = await tx.practitionerRevenueShare.updateMany({
      where: { id: current.id, tenantId, effectiveTo: null },
      data: { effectiveTo: now, closedById: actor.userId },
    });
    if (closed.count !== 1) throw new ConflictAbort();
    await auditInTx(tx, {
      tenantId,
      actorId: actor.userId,
      action: "revenueShare.end",
      entity: "PractitionerRevenueShare",
      entityId: current.id,
      payload: {
        giverPractitionerId: current.giverPractitionerId,
        receiverPractitionerId: current.receiverPractitionerId,
        shareBps: current.shareBps,
        sources: sourcesOf(current),
        effectiveTo: now.toISOString(),
      },
    });
    return { kind: "ok", data: null, changed: true };
  });

  if (res.kind === "error") return { ok: false, error: res.error };
  revalidateShares();
  return { ok: true, data: null };
}
