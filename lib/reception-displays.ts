"use server";

/**
 * TV (T7, §26.4 C-TV): actions del staff para las pantallas de la sala (drawer «Pantallas» de /sala). TV-2s (X2).
 *
 * Gate en TODAS (C-TV): `getActor` → `agenda.operateAll` (OWNER, ADMIN, ASSISTANT; ni PRACTITIONER ni BILLING: la
 * pantalla muestra a todos los pacientes que esperan, no solo los del profesional) → `assertModule("salaEspera")` (que
 * respeta los revokes de Plataforma, M12) → zod → `runWithRls(tenantId, tx => …)` con `where: { tenantId }` a mano: en
 * prod la conexión es BYPASSRLS y ese filtro es la única barrera. Una pantalla de otro tenant se responde igual que
 * una inexistente. La sede se valida contra el tenant y activa DESPUÉS de `lockTenantLocationsShared` (patrón de
 * lib/location-lock.ts: si no, un archivado de la sede se intercala); la FK compuesta
 * `ReceptionDisplay_location_tenant_fkey` de M17 es solo la red.
 *
 * Soporte («como soporte») y consultorio en solo lectura: estas actions NO están en `SUPPORT_WRITABLE_ACTIONS` (son
 * de la sala, no de Configuración), así que `runWithRls` abre la tx en solo lectura y la primera escritura tira
 * `ReadOnlyModeError`, que `withReadOnlyResult` / `readOnlyFailure` vuelven el copy del modo. Leer el panel sí anda.
 *
 * Código de vinculación (TV-D6): lo genera el staff, 8 Crockford; la base guarda solo el HMAC
 * (`hashPairingCode(normalizePairingCode(code))`, lib/display-pairing-internal.ts) y el vencimiento
 * (`PAIRING_TTL_MS`). El código en claro sale UNA vez, en la respuesta del alta o de «Nuevo código»: nunca en la
 * base, ni en el audit, ni en `getDisplaysPanel`. Tope de 20 códigos por hora por usuario: generar es barato y
 * cada código vivo es una puerta (40 bits) a la pantalla del consultorio mientras dura.
 *
 * Índices únicos de `ReceptionDisplay` que un write puede chocar (P2002): el parcial del nombre entre las vivas
 * (`tenantId, lower(name)`) y el parcial global del hash del código. No se mira `meta.target` (bajo `kinesoft_app`
 * llega null, hallazgo A1.1): ante un P2002 del alta se pregunta en una tx nueva si el nombre está tomado; si no lo
 * está, el que chocó fue el código (2^-40 por pantalla viva) y se reintenta UNA vez con otro.
 */
import { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import { assertModule, requireCapability } from "@/lib/authz";
import { ForbiddenError, type Actor } from "@/lib/session";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { generatePairingCode, hashPairingCode } from "@/lib/display-pairing-internal";
import { parseYouTubeUrl } from "@/lib/youtube";
import type { ActionResult } from "@/lib/validation";
import {
  DisplayIdSchema,
  DisplayUpdateSchema,
  DisplayUpsertSchema,
  MAX_LIVE_DISPLAYS,
  PAIRING_TTL_MS,
  formatPairingCode,
  normalizePairingCode,
  type DisplayIdInput,
  type DisplayListItem,
  type DisplayMediaKind,
  type DisplayPairingCode,
  type DisplayUpdateInput,
  type DisplayUpsertInput,
  type DisplayUpsertValues,
  type DisplaysPanel,
} from "@/lib/reception-displays-types";

const FORBIDDEN = "Solo la Secretaría y la administración del consultorio configuran las pantallas.";
const NOT_FOUND = "No encontramos esa pantalla. Recargá la lista.";
const BAD_LOCATION = "La sede no existe o está archivada.";
const NAME_TAKEN = "Ya hay una pantalla con ese nombre. Elegí otro.";
const STALE = "La pantalla cambió mientras la editabas. Recargá para ver la última versión.";
const AT_CAP = `Llegaste al tope de ${MAX_LIVE_DISPLAYS} pantallas. Desvinculá una para sumar otra.`;
const INVALID = "Revisá los datos de la pantalla.";

/** 20 códigos por hora por usuario (C-TV): alta y «Nuevo código» comparten el cupo. */
const CODE_LIMIT = { limit: 20, windowMs: 60 * 60_000 };

/** Clave del tope de pantallas vivas: serializa las altas de un tenant (sin esto dos altas a la vez pasan de 10). */
const displaysLockKey = (tenantId: string) => `kinesoft:displays:${tenantId}`;

const LIST_SELECT = {
  id: true,
  name: true,
  locationId: true,
  location: { select: { name: true } },
  nameMode: true,
  theme: true,
  mediaKind: true,
  mediaRef: true,
  mediaLayout: true,
  mediaMuted: true,
  mediaDuringCall: true,
  pairedAt: true,
  lastSeenAt: true,
  pairingExpiresAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReceptionDisplaySelect;

type ListRow = Prisma.ReceptionDisplayGetPayload<{ select: typeof LIST_SELECT }>;

/** Fila → `DisplayListItem`. Mapeo explícito campo por campo: un hash nunca puede colarse por un spread. */
function toItem(r: ListRow): DisplayListItem {
  return {
    id: r.id,
    name: r.name,
    locationId: r.locationId,
    locationName: r.location?.name ?? null,
    nameMode: r.nameMode,
    theme: r.theme,
    mediaKind: r.mediaKind,
    mediaRef: r.mediaRef,
    mediaLayout: r.mediaLayout,
    mediaMuted: r.mediaMuted,
    mediaDuringCall: r.mediaDuringCall,
    pairedAt: r.pairedAt?.toISOString() ?? null,
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    pairingExpiresAt: r.pairingExpiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

type Fail = { ok: false; error: string; fieldErrors?: Record<string, string[]> };
const fail = (error: string, fieldErrors?: Record<string, string[]>): Fail =>
  fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };

/** Gate de C-TV. Devuelve el actor o el `Fail` con el copy (rol o módulo; revocado por Plataforma = su copy). */
async function gate(): Promise<Actor | Fail> {
  try {
    const { actor } = await requireCapability("agenda.operateAll", FORBIDDEN);
    assertModule(actor, "salaEspera");
    return actor;
  } catch (e) {
    if (e instanceof ForbiddenError) return fail(e.message);
    throw e;
  }
}

/** `mediaUrl` crudo → kind + ref. Vacío = sin video (antes del parser, que con "" devolvería error: handoff TV-1a). */
function resolveMedia(raw: string | null): { ok: true; kind: DisplayMediaKind; ref: string | null } | Fail {
  if (raw === null || raw.trim() === "") return { ok: true, kind: "NONE", ref: null };
  const p = parseYouTubeUrl(raw);
  if (!p.ok) return fail(p.error, { mediaUrl: [p.error] });
  return { ok: true, kind: p.media.kind, ref: p.media.ref };
}

/** Sede activa de ESTE tenant (o null = todas). Tomar el lock compartido antes: ver cabecera. */
async function validLocationInTx(tx: DbClient, tenantId: string, locationId: string | null): Promise<boolean> {
  if (locationId === null) return true;
  await lockTenantLocationsShared(tx, tenantId);
  const loc = await tx.location.findFirst({ where: { id: locationId, tenantId, active: true }, select: { id: true } });
  return loc !== null;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** ¿Hay otra pantalla VIVA con ese nombre? Mismo criterio que el índice parcial (`lower(name)`), sin ILIKE: un `_` o un `%` del nombre no son comodines. */
async function nameTaken(tenantId: string, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await runWithRls(tenantId, (tx) =>
    tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ReceptionDisplay"
      WHERE "tenantId" = ${tenantId} AND "revokedAt" IS NULL AND lower("name") = lower(${name})
        AND (${exceptId}::text IS NULL OR "id" <> ${exceptId}::text)
      LIMIT 1`
  );
  return rows.length > 0;
}

const nameTakenFail = () => fail(NAME_TAKEN, { name: [NAME_TAKEN] });

/** Código nuevo: el claro (formateado `ABCD-EFGH`, para la respuesta) y lo que va a la base. */
function newPairing(now: Date): { code: string; hash: string; expiresAt: Date } {
  const raw = generatePairingCode();
  // `normalizePairingCode` es la misma normalización que aplica `pairDisplay` a lo que se tipea en la TV: el hash
  // de acá y el de allá tienen que salir de los mismos bytes.
  const canon = normalizePairingCode(raw);
  if (!canon) throw new Error("reception-displays: código generado fuera del alfabeto");
  return { code: formatPairingCode(canon), hash: hashPairingCode(canon), expiresAt: new Date(now.getTime() + PAIRING_TTL_MS) };
}

async function consumeCodeQuota(actor: Actor): Promise<Fail | null> {
  const r = await rateLimit(`tv:code:user:${actor.userId}`, CODE_LIMIT);
  return r.ok ? null : fail(rateLimitedMessage(r.retryAfterMs));
}

function writeFields(d: DisplayUpsertValues, media: { kind: DisplayMediaKind; ref: string | null }) {
  return {
    name: d.name,
    locationId: d.locationId,
    nameMode: d.nameMode,
    theme: d.theme,
    mediaKind: media.kind,
    mediaRef: media.ref,
    mediaLayout: d.mediaLayout,
    mediaMuted: d.mediaMuted,
    mediaDuringCall: d.mediaDuringCall,
  };
}

// ── Lectura ─────────────────────────────────────────────────────────────────

/** Pantallas vivas (sin `revokedAt`) + sedes activas para el select + el tope. Nunca hashes. */
export async function getDisplaysPanel(): Promise<ActionResult<DisplaysPanel>> {
  const actor = await gate();
  if ("ok" in actor) return actor;
  const tenantId = actor.tenantId;
  const [rows, locations] = await runWithRls(tenantId, (tx) =>
    Promise.all([
      tx.receptionDisplay.findMany({
        where: { tenantId, revokedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: LIST_SELECT,
      }),
      tx.location.findMany({
        where: { tenantId, active: true },
        orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, isPrimary: true },
      }),
    ])
  );
  return { ok: true, data: { displays: rows.map(toItem), locations, maxLive: MAX_LIVE_DISPLAYS } };
}

// ── Alta ────────────────────────────────────────────────────────────────────

type CreateOutcome =
  | { kind: "ok"; row: ListRow }
  | { kind: "bad_location" }
  | { kind: "at_cap" };

export async function createReceptionDisplay(
  input: DisplayUpsertInput,
): Promise<ActionResult<{ display: DisplayListItem; pairing: DisplayPairingCode }>> {
  return withReadOnlyResult(() => createImpl(input));
}

async function createImpl(
  input: DisplayUpsertInput,
): Promise<ActionResult<{ display: DisplayListItem; pairing: DisplayPairingCode }>> {
  const actor = await gate();
  if ("ok" in actor) return actor;
  const parsed = DisplayUpsertSchema.safeParse(input);
  if (!parsed.success) return fail(INVALID, parsed.error.flatten().fieldErrors);
  const d = parsed.data;
  const media = resolveMedia(d.mediaUrl);
  if (!media.ok) return media;
  const limited = await consumeCodeQuota(actor);
  if (limited) return limited;
  const tenantId = actor.tenantId;

  const attempt = async () => {
    const pairing = newPairing(new Date());
    const out = await runWithRls(tenantId, async (tx): Promise<CreateOutcome> => {
      if (!(await validLocationInTx(tx, tenantId, d.locationId))) return { kind: "bad_location" };
      // Orden de locks: sedes (compartido) → pantallas (exclusivo). El conteo va DESPUÉS del lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${displaysLockKey(tenantId)}, 0))`;
      const liveCount = await tx.receptionDisplay.count({ where: { tenantId, revokedAt: null } });
      if (liveCount >= MAX_LIVE_DISPLAYS) return { kind: "at_cap" };
      const row = await tx.receptionDisplay.create({
        data: {
          tenantId,
          ...writeFields(d, media),
          pairingCodeHash: pairing.hash,
          pairingExpiresAt: pairing.expiresAt,
          createdByUserId: actor.userId,
        },
        select: LIST_SELECT,
      });
      // Sin el código ni su hash: el audit lo lee el OWNER y Plataforma.
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "display.created",
        entity: "ReceptionDisplay",
        entityId: row.id,
        payload: { name: row.name, locationId: row.locationId, mediaKind: row.mediaKind },
      });
      return { kind: "ok", row };
    });
    return { out, pairing };
  };

  try {
    let res: Awaited<ReturnType<typeof attempt>>;
    try {
      res = await attempt();
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (await nameTaken(tenantId, d.name, null)) return nameTakenFail();
      // Chocó el hash del código con otro vivo: uno nuevo, una sola vez (dos choques seguidos de 40 bits = otra cosa).
      res = await attempt();
    }
    const { out, pairing } = res;
    if (out.kind === "bad_location") return fail(BAD_LOCATION, { locationId: [BAD_LOCATION] });
    if (out.kind === "at_cap") return fail(AT_CAP);
    return {
      ok: true,
      data: { display: toItem(out.row), pairing: { code: pairing.code, expiresAt: pairing.expiresAt.toISOString() } },
    };
  } catch (e) {
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    if (isUniqueViolation(e) && (await nameTaken(tenantId, d.name, null))) return nameTakenFail();
    logger.error("display.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return fail("No pudimos crear la pantalla.");
  }
}

// ── Edición (CAS) ───────────────────────────────────────────────────────────

type UpdateOutcome =
  | { kind: "ok"; row: ListRow }
  | { kind: "not_found" }
  | { kind: "stale" }
  | { kind: "bad_location" };

export async function updateReceptionDisplay(input: DisplayUpdateInput): Promise<ActionResult<{ display: DisplayListItem }>> {
  return withReadOnlyResult(() => updateImpl(input));
}

async function updateImpl(input: DisplayUpdateInput): Promise<ActionResult<{ display: DisplayListItem }>> {
  const actor = await gate();
  if ("ok" in actor) return actor;
  const parsed = DisplayUpdateSchema.safeParse(input);
  if (!parsed.success) return fail(INVALID, parsed.error.flatten().fieldErrors);
  const { id, expectedUpdatedAt, ...d } = parsed.data;
  const media = resolveMedia(d.mediaUrl);
  if (!media.ok) return media;
  const tenantId = actor.tenantId;
  const expected = new Date(expectedUpdatedAt);
  const fields = writeFields(d, media);

  try {
    const out = await runWithRls(tenantId, async (tx): Promise<UpdateOutcome> => {
      const before = await tx.receptionDisplay.findFirst({
        where: { id, tenantId, revokedAt: null },
        select: LIST_SELECT,
      });
      if (!before) return { kind: "not_found" };
      if (before.updatedAt.getTime() !== expected.getTime()) return { kind: "stale" };
      if (d.locationId !== before.locationId && !(await validLocationInTx(tx, tenantId, d.locationId))) {
        return { kind: "bad_location" };
      }
      // CAS en el mismo statement: otro guardado entre el SELECT y acá deja count 0 (no se pisa en silencio).
      const upd = await tx.receptionDisplay.updateMany({
        where: { id, tenantId, revokedAt: null, updatedAt: expected },
        data: fields,
      });
      if (upd.count !== 1) return { kind: "stale" };
      const row = await tx.receptionDisplay.findFirstOrThrow({ where: { id, tenantId }, select: LIST_SELECT });
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => before[k] !== fields[k]);
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "display.updated",
        entity: "ReceptionDisplay",
        entityId: id,
        payload: { fields: changed },
      });
      return { kind: "ok", row };
    });
    if (out.kind === "not_found") return fail(NOT_FOUND);
    if (out.kind === "stale") return fail(STALE);
    if (out.kind === "bad_location") return fail(BAD_LOCATION, { locationId: [BAD_LOCATION] });
    return { ok: true, data: { display: toItem(out.row) } };
  } catch (e) {
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    // La edición no toca el hash del código: el único único que puede chocar es el nombre.
    if (isUniqueViolation(e)) return nameTakenFail();
    logger.error("display.update.failed", { err: e instanceof Error ? e.message : String(e) });
    return fail("No pudimos guardar la pantalla.");
  }
}

// ── Nuevo código ────────────────────────────────────────────────────────────

/**
 * Código nuevo (el anterior, si seguía vivo, deja de servir: se pisa el hash). NO toca `deviceSecretHash`: la TV que
 * ya estaba vinculada sigue andando hasta que un vínculo nuevo con este código pise el secreto (`pairDisplay`). Así
 * mover la pantalla a otra TV no deja la sala sin pantalla mientras se hace.
 */
export async function regenerateDisplayPairingCode(input: DisplayIdInput): Promise<ActionResult<DisplayPairingCode>> {
  return withReadOnlyResult(() => regenerateImpl(input));
}

async function regenerateImpl(input: DisplayIdInput): Promise<ActionResult<DisplayPairingCode>> {
  const actor = await gate();
  if ("ok" in actor) return actor;
  const parsed = DisplayIdSchema.safeParse(input);
  if (!parsed.success) return fail(NOT_FOUND);
  const { id } = parsed.data;
  const limited = await consumeCodeQuota(actor);
  if (limited) return limited;
  const tenantId = actor.tenantId;

  const attempt = async () => {
    const pairing = newPairing(new Date());
    const found = await runWithRls(tenantId, async (tx) => {
      const upd = await tx.receptionDisplay.updateMany({
        where: { id, tenantId, revokedAt: null },
        data: { pairingCodeHash: pairing.hash, pairingExpiresAt: pairing.expiresAt },
      });
      if (upd.count !== 1) return false;
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "display.code_regenerated",
        entity: "ReceptionDisplay",
        entityId: id,
        payload: { expiresAt: pairing.expiresAt.toISOString() },
      });
      return true;
    });
    return { found, pairing };
  };

  try {
    let res: Awaited<ReturnType<typeof attempt>>;
    try {
      res = await attempt();
    } catch (e) {
      // Acá el único único posible es el hash del código (el nombre no cambia): reintento una vez.
      if (!isUniqueViolation(e)) throw e;
      res = await attempt();
    }
    if (!res.found) return fail(NOT_FOUND);
    return { ok: true, data: { code: res.pairing.code, expiresAt: res.pairing.expiresAt.toISOString() } };
  } catch (e) {
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    logger.error("display.regenerate.failed", { err: e instanceof Error ? e.message : String(e) });
    return fail("No pudimos generar el código.");
  }
}

// ── Desvincular ─────────────────────────────────────────────────────────────

/**
 * Baja lógica: `revokedAt` + `revokedByUserId` y los dos hashes en null (CHECK `ReceptionDisplay_revoked_check`). La
 * TV la ve en su próximo pedido del feed (`resolveDisplaySession` → `revoked`) y el nombre queda libre (el índice
 * parcial es solo entre vivas). La fila queda como rastro.
 */
export async function revokeReceptionDisplay(input: DisplayIdInput): Promise<ActionResult> {
  return withReadOnlyResult(() => revokeImpl(input));
}

async function revokeImpl(input: DisplayIdInput): Promise<ActionResult> {
  const actor = await gate();
  if ("ok" in actor) return actor;
  const parsed = DisplayIdSchema.safeParse(input);
  if (!parsed.success) return fail(NOT_FOUND);
  const { id } = parsed.data;
  const tenantId = actor.tenantId;
  try {
    const found = await runWithRls(tenantId, async (tx) => {
      const upd = await tx.receptionDisplay.updateMany({
        where: { id, tenantId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedByUserId: actor.userId,
          pairingCodeHash: null,
          pairingExpiresAt: null,
          deviceSecretHash: null,
        },
      });
      if (upd.count !== 1) return false;
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "display.revoked",
        entity: "ReceptionDisplay",
        entityId: id,
      });
      return true;
    });
    if (!found) return fail(NOT_FOUND);
    return { ok: true, data: undefined };
  } catch (e) {
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    logger.error("display.revoke.failed", { err: e instanceof Error ? e.message : String(e) });
    return fail("No pudimos desvincular la pantalla.");
  }
}
