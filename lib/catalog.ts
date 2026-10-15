"use server";

/**
 * Catálogo global — lecturas desde el consultorio + propuesta de planes
 * (B1.4 CAT-tenant).
 *
 * Prestadoras (`Payer`), prácticas (`Practice`) y planes globales
 * (`PayerPlan.tenantId IS NULL`) los cura Plataforma (`lib/catalog-admin.ts`)
 * y los importa `scripts/catalog-import.ts`; el rol app solo los LEE (policy
 * `FOR SELECT USING (true)`, sin policy de escritura). La única escritura del
 * tenant acá es `proposePayerPlan`: un `PayerPlan` con su `tenantId` y
 * `source=TENANT`, visible solo para él hasta que Plataforma lo promueva.
 *
 * Cache: las lecturas puramente globales se cachean con clave SIN tenant y tag
 * `tags.catalog()` (las invalida Plataforma/el import). Las que mezclan filas
 * del tenant (planes = globales + propuestos por él, sugerencias sobre sus
 * Insurers) llevan el tenantId en la clave y además el tag del tenant, para
 * que lo propuesto por un consultorio nunca se sirva desde la slice de otro.
 * `getActor()` va siempre FUERA del fetcher cacheado (no puede leer cookies).
 */
import { revalidatePath, revalidateTag, unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import { escapeLike } from "@/lib/email-match";
import { getActor } from "@/lib/session";
import { logger } from "@/lib/logger";
import { tags, ttl } from "@/lib/cache-tags";
import { matchKey } from "@/lib/catalog/normalize";
import { findActivePayer } from "@/lib/catalog-validate";
import {
  CatalogId,
  CatalogQuery,
  ProposePayerPlanInput,
  type PayerOption,
  type PayerPlanOption,
  type PracticeOption,
} from "@/lib/catalog-schemas";
import type { ActionResult } from "@/lib/validation";

const SEARCH_LIMIT = 20;

const payerSelect = { id: true, name: true, kind: true, province: true } as const;

/** Tope de ids por alias que entran al `IN` de la búsqueda (la página es de 20). */
const ALIAS_ID_CAP = 200;

type AliasKeys = { id: string; keys: string[] };

/**
 * `matchKey` de los alias de prestadoras y prácticas no archivadas, calculada
 * en la app. Por qué no en SQL: los alias se guardan con su escritura
 * original ("O.S.D.E.", "Osde S.A.", "RPG"), así que `aliases has <q>` solo
 * encontraba la escritura exacta (handoff de B1.1). Solo filas con alias;
 * cache global con el tag del catálogo (lo invalida Plataforma / el botón
 * "Refrescar catálogo" después del import).
 */
const aliasKeyIndex = unstable_cache(
  async (): Promise<{ payers: AliasKeys[]; practices: AliasKeys[] }> => {
    const where = { archivedAt: null, aliases: { isEmpty: false } };
    const [payers, practices] = await Promise.all([
      prisma.payer.findMany({ where, select: { id: true, aliases: true } }),
      prisma.practice.findMany({ where, select: { id: true, aliases: true } }),
    ]);
    const keys = (rows: { id: string; aliases: string[] }[]): AliasKeys[] =>
      rows
        .map((r) => ({ id: r.id, keys: r.aliases.map((a) => matchKey(a)).filter(Boolean) }))
        .filter((r) => r.keys.length > 0);
    return { payers: keys(payers), practices: keys(practices) };
  },
  ["catalog:alias-key-index"],
  { tags: [tags.catalog()], revalidate: ttl.long }
);

/** Ids cuyo algún alias contiene TODAS las palabras (mismo criterio que el nombre). */
function aliasMatchIds(rows: AliasKeys[], words: string[]): string[] {
  if (!words.length) return [];
  const out: string[] = [];
  for (const r of rows) {
    if (r.keys.some((k) => words.every((w) => k.includes(w)))) {
      out.push(r.id);
      if (out.length >= ALIAS_ID_CAP) break;
    }
  }
  return out;
}

/**
 * Filtro de búsqueda común a prestadoras y prácticas: nombre (contains,
 * sin mayúsculas), todas las palabras de la `matchKey` de la consulta dentro
 * de la `matchKey` de la fila (así "union personal" encuentra "Unión
 * Personal" y "kinesio rodilla" no exige el orden exacto) o lo mismo contra
 * la `matchKey` de algún alias (resuelto en la app: `aliasKeyIndex`).
 */
async function searchWhere(q: string, kind: "payers" | "practices") {
  if (!q) return {};
  const words = matchKey(q).split(" ").filter(Boolean);
  const aliasIds = aliasMatchIds((await aliasKeyIndex())[kind], words);
  return {
    OR: [
      // EV1-E1: Prisma no escapa los comodines de `contains`/`equals` insensible (ILIKE con el valor tal cual,
      // verificado contra Postgres): «_» o «%» matcheaban todo el catálogo. Las palabras de la `matchKey` son
      // [a-z0-9] (normalize.ts), no necesitan escape.
      { name: { contains: escapeLike(q), mode: "insensitive" as const } },
      ...(words.length ? [{ AND: words.map((w) => ({ matchKey: { contains: w } })) }] : []),
      ...(aliasIds.length ? [{ id: { in: aliasIds } }] : []),
    ],
  };
}

/** Prestadoras no archivadas del catálogo global (picker de Obras sociales). */
export async function searchPayers(rawQ: string): Promise<PayerOption[]> {
  await getActor(); // solo usuarios logueados de un consultorio
  const q = CatalogQuery.parse(rawQ);
  const fetcher = unstable_cache(
    async (query: string): Promise<PayerOption[]> =>
      prisma.payer.findMany({
        where: { archivedAt: null, ...(await searchWhere(query, "payers")) },
        orderBy: { name: "asc" },
        take: SEARCH_LIMIT,
        select: payerSelect,
      }),
    ["catalog:payers:search", q],
    { tags: [tags.catalog()], revalidate: ttl.long }
  );
  return fetcher(q);
}

/**
 * Planes de una prestadora visibles para el consultorio: los globales más los
 * que propuso él mismo (sin promover). Archivados afuera. El `where` por
 * tenant es explícito: en prod la conexión tiene BYPASSRLS.
 */
export async function listPayerPlans(rawPayerId: string): Promise<PayerPlanOption[]> {
  const actor = await getActor();
  const parsed = CatalogId.safeParse(rawPayerId);
  if (!parsed.success) return [];
  const fetcher = unstable_cache(
    async (tenantId: string, payerId: string): Promise<PayerPlanOption[]> => {
      const rows = await runWithRls(tenantId, (tx) =>
        tx.payerPlan.findMany({
          where: {
            payerId,
            archivedAt: null,
            payer: { archivedAt: null },
            OR: [{ tenantId: null }, { tenantId }],
          },
          orderBy: [{ name: "asc" }],
          select: { id: true, name: true, tenantId: true },
        })
      );
      return rows.map((r) => ({ ...r, proposed: r.tenantId !== null }));
    },
    ["catalog:payer-plans", actor.tenantId, parsed.data],
    { tags: [tags.catalog(), tags.insurers(actor.tenantId)], revalidate: ttl.long }
  );
  return fetcher(actor.tenantId, parsed.data);
}

/** Prácticas no archivadas del catálogo global (picker de Servicios). */
export async function searchPractices(rawQ: string): Promise<PracticeOption[]> {
  await getActor();
  const q = CatalogQuery.parse(rawQ);
  const fetcher = unstable_cache(
    async (query: string): Promise<PracticeOption[]> => {
      const where = await searchWhere(query, "practices");
      return prisma.practice.findMany({
        where: {
          archivedAt: null,
          ...(query
            ? { OR: [...(where.OR ?? []), { code: { equals: escapeLike(query), mode: "insensitive" as const } }] }
            : {}),
        },
        orderBy: { name: "asc" },
        take: SEARCH_LIMIT,
        select: { id: true, name: true, code: true, nomenclador: true, defaultDurationMin: true },
      });
    },
    ["catalog:practices:search", q],
    { tags: [tags.catalog()], revalidate: ttl.long }
  );
  return fetcher(q);
}

/**
 * Índice `matchKey → prestadora` de todo el catálogo no archivado, por nombre
 * Y por alias. Los alias se guardan con su escritura original ("O.S.D.E.",
 * "Osde S.A."), así que su `matchKey` no se puede comparar en SQL: se arma en
 * memoria y se cachea global (~1000 prestadoras RNOS+RNEMP, unos cientos de
 * KB). El nombre gana sobre un alias que choque con otra prestadora.
 */
const payerKeyIndex = unstable_cache(
  async (): Promise<Record<string, PayerOption>> => {
    const rows = await prisma.payer.findMany({
      where: { archivedAt: null },
      orderBy: { name: "asc" },
      select: { ...payerSelect, matchKey: true, aliases: true },
    });
    const byAlias: Record<string, PayerOption> = {};
    const byName: Record<string, PayerOption> = {};
    for (const r of rows) {
      const opt: PayerOption = { id: r.id, name: r.name, kind: r.kind, province: r.province };
      byName[r.matchKey] = opt;
      for (const a of r.aliases) {
        const k = matchKey(a);
        if (k && !byAlias[k]) byAlias[k] = opt;
      }
    }
    return { ...byAlias, ...byName };
  },
  ["catalog:payer-key-index"],
  { tags: [tags.catalog()], revalidate: ttl.long }
);

/**
 * Sugerencia "Vincular a <Payer>" para un nombre de obra social, por
 * `matchKey` del nombre o de un alias. Nunca vincula sola: el usuario
 * confirma desde la UI (sin auto-link, decisión de diseño de M-cat).
 */
export async function suggestPayerForInsurer(rawName: string): Promise<PayerOption | null> {
  await getActor();
  const key = matchKey(CatalogQuery.parse(rawName));
  if (!key) return null;
  return (await payerKeyIndex())[key] ?? null;
}

/**
 * Sugerencias para TODAS las obras sociales del consultorio sin `payerId`, en
 * una sola llamada: las server actions del cliente se encolan de a una, así
 * que N llamadas a `suggestPayerForInsurer` desde el panel serían N viajes.
 * Devuelve `{ [insurerId]: PayerOption }`; "Particular" nunca se sugiere.
 * Sin cache propio: la lista de OS del tenant es chica y el índice ya está
 * cacheado.
 */
export async function listInsurerPayerSuggestions(): Promise<Record<string, PayerOption>> {
  const actor = await getActor();
  const insurers = await runWithRls(actor.tenantId, (tx) =>
    tx.insurer.findMany({
      where: { tenantId: actor.tenantId, payerId: null, isParticular: false },
      select: { id: true, name: true },
    })
  );
  if (insurers.length === 0) return {};
  const index = await payerKeyIndex();
  const out: Record<string, PayerOption> = {};
  for (const ins of insurers) {
    const p = index[matchKey(ins.name)];
    if (p) out[ins.id] = p;
  }
  return out;
}

/** Slug de plan desde su nombre (misma normalización que el catálogo). */
function planSlug(name: string): string {
  return matchKey(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/**
 * Propone un plan para una prestadora desde el consultorio: `PayerPlan` con
 * el `tenantId` del actor y `source=TENANT`. Lo ve solo este consultorio hasta
 * que Plataforma lo promueve (B1.3 `promotePayerPlan`).
 *
 * Cualquier miembro puede proponer (el picker vive en la ficha del paciente,
 * que edita el profesional). Idempotente: si ya hay un plan global o propio
 * con el mismo slug para esa prestadora, devuelve ese id en vez de duplicar.
 */
// EV1-E1 (readonly-residual-actions): el cuerpo va en `proposePayerPlanImpl`; el wrapper convierte el ReadOnlyModeError
// (modo lectura / soporte) en `{ ok:false, error }` para que en prod Next no redacte el mensaje
// (lib/read-only-result.ts, mismo patrón que BO3-F).
export async function proposePayerPlan(...args: Parameters<typeof proposePayerPlanImpl>): ReturnType<typeof proposePayerPlanImpl> {
  return withReadOnlyResult(() => proposePayerPlanImpl(...args));
}

async function proposePayerPlanImpl(
  payerId: string,
  name: string
): Promise<ActionResult<{ id: string; created: boolean }>> {
  const parsed = ProposePayerPlanInput.safeParse({ payerId, name });
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const actor = await getActor();
  const slug = planSlug(parsed.data.name);
  if (!slug) return { ok: false, error: "El nombre del plan no es válido." };

  try {
    const r = await runWithRls(actor.tenantId, async (tx) => {
      // La FK payerId saltea RLS: prestadora existente y no archivada, acá.
      const payer = await findActivePayer(tx, parsed.data.payerId);
      if (!payer) return { ok: false as const, error: "Prestadora no encontrada." };
      // Mismo plan ya visible (global o propio): se compara por `matchKey` del
      // nombre, no solo por slug, porque los slugs globales los escribe el
      // import con su propia convención ("osde-210" vs "plan-210").
      const key = matchKey(parsed.data.name);
      const visible = await tx.payerPlan.findMany({
        where: {
          payerId: payer.id,
          archivedAt: null,
          OR: [{ tenantId: null }, { tenantId: actor.tenantId }],
        },
        select: { id: true, name: true, slug: true },
      });
      const same = visible.find((p) => p.slug === slug || matchKey(p.name) === key);
      if (same) return { ok: true as const, id: same.id, created: false };
      const row = await tx.payerPlan.create({
        data: {
          payerId: payer.id,
          tenantId: actor.tenantId,
          name: parsed.data.name,
          slug,
          source: "TENANT",
          sourceDate: new Date(),
        },
        select: { id: true },
      });
      return { ok: true as const, id: row.id, created: true };
    });
    if (!r.ok) return r;
    if (r.created) {
      revalidateTag(tags.insurers(actor.tenantId));
      revalidatePath("/configuracion");
    }
    return { ok: true, data: { id: r.id, created: r.created } };
  } catch (e) {
    // EV1-E1: este catch tapaba el ReadOnlyModeError con el copy genérico; el del modo lectura/soporte va primero.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    // Índice único parcial (payerId, tenantId, slug): o hubo una carrera con
    // otro alta del mismo plan, o este consultorio ya lo había propuesto y
    // Plataforma lo archivó (descartado): no se resucita desde acá.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await runWithRls(actor.tenantId, (tx) =>
        tx.payerPlan.findFirst({
          where: { payerId: parsed.data.payerId, slug, tenantId: actor.tenantId },
          select: { id: true, archivedAt: true },
        })
      );
      if (again && !again.archivedAt) return { ok: true, data: { id: again.id, created: false } };
      if (again) return { ok: false, error: "Ese plan ya fue propuesto y quedó descartado por Plataforma." };
    }
    logger.error("payerPlan.propose.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos guardar el plan." };
  }
}
