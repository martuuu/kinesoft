"use server";

/**
 * Curado del catálogo global de prestadoras / prácticas / especialidades —
 * Plataforma, solo superadmin (B1.3 CAT-admin, bpre-design §A).
 *
 * Mismo patrón que `lib/exercises-admin.ts`: `requireSuperAdmin()` es la única
 * barrera y toda escritura va por `prismaService`. No es una preferencia: las
 * tablas del catálogo (Payer, Practice, Specialty, PracticeSpecialty) tienen RLS
 * con UNA policy `FOR SELECT` y ninguna de escritura (migración
 * `catalog_global`), así que el rol app no puede escribirlas aunque quiera. Los
 * merges y la promoción además repuntan FKs de filas de TODOS los tenants
 * (Insurer.payerId, Service.practiceId, Coverage.payerPlanId): eso es
 * cross-tenant por definición y solo lo puede hacer el canal de servicio.
 *
 * `curatedAt`: toda edición manual (y el archivado) lo marca. El import
 * (`scripts/catalog-import.ts`, B1.1) nunca pisa una fila con `curatedAt`, así
 * que lo que se corrige acá a mano sobrevive la próxima corrida del CSV oficial.
 *
 * El origen de un merge se ARCHIVA (no se borra): conserva slug y matchKey, así
 * que el próximo import encuentra la fila (curada, archivada) y no la vuelve a
 * crear como duplicado. Borrar la dejaría reaparecer desde el CSV oficial.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { tags as cacheTags } from "@/lib/cache-tags";
import { matchKey } from "@/lib/catalog/normalize";
import type { ActionResult } from "@/lib/validation";
import {
  CATALOG_ADMIN_PAGE_SIZE,
  CatalogArchive,
  CatalogEntity,
  CatalogListQuery,
  CatalogMerge,
  PayerAdminUpdate,
  PayerPlanPromote,
  PracticeAdminUpdate,
  SpecialtyAdminUpdate,
  type CatalogListQueryInput,
} from "@/lib/catalog-admin-schemas";
import type {
  CatalogAdminPage,
  CatalogAdminRow,
  CatalogDetail,
  CatalogEntityKind,
  CatalogImportRunRow,
  MergeResult,
  PayerPlanProposal,
} from "@/lib/catalog-admin-types";

/** Error de negocio dentro de una tx: corta y se traduce a `{ ok: false }`. */
class CatalogAdminError extends Error {}

function revalidateCatalog() {
  revalidateTag(cacheTags.catalog());
  revalidatePath("/plataforma/catalogo", "layout");
}

function invalid(e: { flatten: () => { fieldErrors: Record<string, string[] | undefined> } }) {
  const fe = e.flatten().fieldErrors;
  const fieldErrors: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(fe)) if (v) fieldErrors[k] = v;
  return { ok: false as const, error: "Datos inválidos", fieldErrors };
}

/**
 * Une listas de alias sin duplicados por `matchKey` (el mismo criterio que usa
 * el import: sin acentos, puntuación, siglas punteadas ni "obra social de"),
 * sin repetir el nombre de la fila y conservando la primera grafía vista.
 */
function unionAliases(name: string, ...lists: string[][]): string[] {
  const seen = new Set<string>([matchKey(name)]);
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const a = raw.trim().replace(/\s+/g, " ");
      const key = matchKey(a);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Ids cuyo array `aliases` contiene `q` como substring. Prisma solo ofrece
 * `has` (igualdad exacta de un elemento), que no sirve para buscar "osde" y
 * encontrar el alias "OSDE Binario". Tabla fija por entidad: nada del input
 * llega como identificador SQL.
 */
async function aliasMatchIds(entity: CatalogEntityKind, q: string): Promise<string[]> {
  const pat = `%${escapeLike(q)}%`;
  const rows =
    entity === "payer"
      ? await prismaService.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Payer" WHERE EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE ${pat}) LIMIT 500`
      : entity === "practice"
        ? await prismaService.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Practice" WHERE EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE ${pat}) LIMIT 500`
        : await prismaService.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Specialty" WHERE EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE ${pat}) LIMIT 500`;
  return rows.map((r) => r.id);
}

function archivedWhere(a: "active" | "archived" | "all") {
  return a === "active" ? { archivedAt: null } : a === "archived" ? { archivedAt: { not: null } } : {};
}

const PAYER_KIND_LABEL: Record<string, string> = {
  OBRA_SOCIAL: "Obra social",
  PREPAGA: "Prepaga",
  MUTUAL: "Mutual",
  OTRA: "Otra",
};

// ─────────────────────────────────────────────────────────────────────────────
// Lecturas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tabla paginada de una entidad del catálogo. Busca por nombre, slug, alias
 * (substring) y código (RNOS/RNEMP o CUIT en prestadoras; código de nomenclador
 * en prácticas). Orden total (nombre, id) para que la paginación no duplique ni
 * esconda filas con el mismo nombre.
 */
export async function listCatalogForAdmin(raw: CatalogListQueryInput): Promise<CatalogAdminPage> {
  await requireSuperAdmin();
  const f = CatalogListQuery.parse(raw);
  const contains = (v: string) => ({ contains: v, mode: "insensitive" as const });
  const aliasIds = f.q ? await aliasMatchIds(f.entity, f.q) : [];
  // "O.S.D.E." o "Osde S.A." encuentran "OSDE": se compara también la clave
  // normalizada (la misma con la que el import reconoce la fila).
  const qKey = f.q ? matchKey(f.q) : "";
  const keyMatch = qKey ? [{ matchKey: { contains: qKey } }] : [];
  const take = CATALOG_ADMIN_PAGE_SIZE;
  const orderBy = [{ name: "asc" as const }, { id: "asc" as const }];

  const pageOf = (total: number) => {
    const pageCount = Math.max(1, Math.ceil(total / take));
    return { pageCount, page: Math.min(f.page, pageCount) };
  };

  if (f.entity === "payer") {
    const where: Prisma.PayerWhereInput = {
      AND: [
        archivedWhere(f.archived),
        f.kind ? { kind: f.kind } : {},
        f.source ? { source: f.source } : {},
        f.q
          ? {
              OR: [
                { name: contains(f.q) },
                { slug: contains(f.q) },
                ...keyMatch,
                { legalName: contains(f.q) },
                { registryCode: contains(f.q) },
                { cuit: contains(f.q) },
                ...(aliasIds.length ? [{ id: { in: aliasIds } }] : []),
              ],
            }
          : {},
      ],
    };
    const total = await prismaService.payer.count({ where });
    const { page, pageCount } = pageOf(total);
    const rows = await prismaService.payer.findMany({
      where,
      orderBy,
      skip: (page - 1) * take,
      take,
      include: { _count: { select: { insurers: true, plans: true } } },
    });
    return {
      total,
      page,
      pageCount,
      rows: rows.map(
        (r): CatalogAdminRow => ({
          ...baseRow(r),
          code: r.registryCode ?? r.cuit,
          detail: PAYER_KIND_LABEL[r.kind] ?? r.kind,
          province: r.province,
          usage: [
            { label: "consultorios", count: r._count.insurers },
            { label: "planes", count: r._count.plans },
          ],
        }),
      ),
    };
  }

  if (f.entity === "practice") {
    const where: Prisma.PracticeWhereInput = {
      AND: [
        archivedWhere(f.archived),
        f.source ? { source: f.source } : {},
        f.q
          ? {
              OR: [
                { name: contains(f.q) },
                { slug: contains(f.q) },
                ...keyMatch,
                { code: contains(f.q) },
                ...(aliasIds.length ? [{ id: { in: aliasIds } }] : []),
              ],
            }
          : {},
      ],
    };
    const total = await prismaService.practice.count({ where });
    const { page, pageCount } = pageOf(total);
    const rows = await prismaService.practice.findMany({
      where,
      orderBy,
      skip: (page - 1) * take,
      take,
      include: { _count: { select: { services: true, specialties: true } } },
    });
    return {
      total,
      page,
      pageCount,
      rows: rows.map(
        (r): CatalogAdminRow => ({
          ...baseRow(r),
          code: r.code,
          detail: r.nomenclador,
          province: null,
          usage: [
            { label: "servicios", count: r._count.services },
            { label: "especialidades", count: r._count.specialties },
          ],
        }),
      ),
    };
  }

  const where: Prisma.SpecialtyWhereInput = {
    AND: [
      archivedWhere(f.archived),
      f.source ? { source: f.source } : {},
      f.q
        ? {
            OR: [
              { name: contains(f.q) },
              { slug: contains(f.q) },
              ...keyMatch,
              ...(aliasIds.length ? [{ id: { in: aliasIds } }] : []),
            ],
          }
        : {},
    ],
  };
  const total = await prismaService.specialty.count({ where });
  const { page, pageCount } = pageOf(total);
  const rows = await prismaService.specialty.findMany({
    where,
    orderBy,
    skip: (page - 1) * take,
    take,
    include: { _count: { select: { practices: true } } },
  });
  return {
    total,
    page,
    pageCount,
    rows: rows.map(
      (r): CatalogAdminRow => ({
        ...baseRow(r),
        code: null,
        detail: null,
        province: null,
        usage: [{ label: "prácticas", count: r._count.practices }],
      }),
    ),
  };
}

function baseRow(r: {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
  source: CatalogAdminRow["source"];
  sourceRef: string | null;
  sourceDate: Date;
  curatedAt: Date | null;
  archivedAt: Date | null;
}) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    aliases: r.aliases,
    source: r.source,
    sourceRef: r.sourceRef,
    sourceDate: r.sourceDate.toISOString(),
    curatedAt: r.curatedAt?.toISOString() ?? null,
    archived: r.archivedAt != null,
  };
}

/** Detalle completo para el drawer de edición. */
export async function getCatalogDetail(entity: CatalogEntityKind, id: string): Promise<CatalogDetail | null> {
  await requireSuperAdmin();
  const e = CatalogEntity.parse(entity);
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  if (e === "payer") {
    const p = await prismaService.payer.findUnique({
      where: { id },
      include: {
        plans: {
          orderBy: [{ tenantId: { sort: "asc", nulls: "first" } }, { name: "asc" }],
          include: { tenant: { select: { name: true } }, _count: { select: { coverages: true } } },
        },
        _count: { select: { insurers: true } },
      },
    });
    if (!p) return null;
    return {
      kind: "payer",
      id: p.id,
      slug: p.slug,
      name: p.name,
      legalName: p.legalName,
      payerKind: p.kind,
      registryCode: p.registryCode,
      cuit: p.cuit,
      province: p.province,
      aliases: p.aliases,
      source: p.source,
      sourceRef: p.sourceRef,
      curatedAt: iso(p.curatedAt),
      archivedAt: iso(p.archivedAt),
      insurerCount: p._count.insurers,
      plans: p.plans.map((pl) => ({
        id: pl.id,
        name: pl.name,
        slug: pl.slug,
        tenantName: pl.tenant?.name ?? null,
        archived: pl.archivedAt != null,
        coverages: pl._count.coverages,
      })),
    };
  }

  if (e === "practice") {
    const p = await prismaService.practice.findUnique({
      where: { id },
      include: {
        specialties: { include: { specialty: { select: { id: true, name: true } } } },
        _count: { select: { services: true } },
      },
    });
    if (!p) return null;
    return {
      kind: "practice",
      id: p.id,
      slug: p.slug,
      name: p.name,
      code: p.code,
      nomenclador: p.nomenclador,
      defaultDurationMin: p.defaultDurationMin,
      aliases: p.aliases,
      source: p.source,
      sourceRef: p.sourceRef,
      curatedAt: iso(p.curatedAt),
      archivedAt: iso(p.archivedAt),
      specialties: p.specialties.map((s) => s.specialty).sort((a, b) => a.name.localeCompare(b.name, "es")),
      serviceCount: p._count.services,
    };
  }

  const s = await prismaService.specialty.findUnique({
    where: { id },
    include: { _count: { select: { practices: true } } },
  });
  if (!s) return null;
  return {
    kind: "specialty",
    id: s.id,
    slug: s.slug,
    name: s.name,
    aliases: s.aliases,
    source: s.source,
    sourceRef: s.sourceRef,
    curatedAt: iso(s.curatedAt),
    archivedAt: iso(s.archivedAt),
    practiceCount: s._count.practices,
  };
}

/** Candidatas a destino de un merge: activas, distintas del origen, por nombre/slug/alias. */
export async function searchMergeTargets(
  entity: "payer" | "practice",
  q: string,
  excludeId: string,
): Promise<{ id: string; name: string; slug: string }[]> {
  await requireSuperAdmin();
  const term = String(q ?? "").trim().slice(0, 120);
  if (term.length < 2) return [];
  const aliasIds = await aliasMatchIds(entity, term);
  const OR = [
    { name: { contains: term, mode: "insensitive" as const } },
    { slug: { contains: term, mode: "insensitive" as const } },
    ...(aliasIds.length ? [{ id: { in: aliasIds } }] : []),
  ];
  const args = {
    where: { archivedAt: null, id: { not: excludeId }, OR },
    orderBy: { name: "asc" as const },
    take: 12,
    select: { id: true, name: true, slug: true },
  };
  return entity === "payer" ? prismaService.payer.findMany(args) : prismaService.practice.findMany(args);
}

/** Planes propuestos por consultorios (tenantId set) pendientes de promover. */
export async function listPayerPlanProposals(): Promise<PayerPlanProposal[]> {
  await requireSuperAdmin();
  const plans = await prismaService.payerPlan.findMany({
    where: { tenantId: { not: null }, promotedAt: null, archivedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 200,
    include: {
      payer: { select: { name: true, archivedAt: true } },
      tenant: { select: { name: true } },
      _count: { select: { coverages: true } },
    },
  });
  const globals = plans.length
    ? await prismaService.payerPlan.findMany({
        where: { tenantId: null, OR: plans.map((p) => ({ payerId: p.payerId, slug: p.slug })) },
        select: { id: true, name: true, payerId: true, slug: true },
      })
    : [];
  const byKey = new Map(globals.map((g) => [`${g.payerId}|${g.slug}`, g]));
  return plans.map((p) => {
    const g = byKey.get(`${p.payerId}|${p.slug}`);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      payerId: p.payerId,
      payerName: p.payer.name,
      payerArchived: p.payer.archivedAt != null,
      tenantId: p.tenantId!,
      tenantName: p.tenant?.name ?? "—",
      coverages: p._count.coverages,
      globalMatch: g ? { id: g.id, name: g.name } : null,
      createdAt: p.createdAt.toISOString(),
    };
  });
}

/** Últimas corridas de `scripts/catalog-import.ts --apply`. */
export async function listCatalogImportRuns(limit = 30): Promise<CatalogImportRunRow[]> {
  await requireSuperAdmin();
  const take = Math.min(Math.max(1, Math.trunc(Number(limit) || 30)), 100);
  const runs = await prismaService.catalogImportRun.findMany({
    orderBy: [{ ranAt: "desc" }, { id: "asc" }],
    take,
  });
  return runs.map((r) => ({
    id: r.id,
    file: r.file,
    sha256: r.sha256,
    kind: r.kind,
    created: r.created,
    updated: r.updated,
    skipped: r.skipped,
    conflictCount: Array.isArray(r.conflicts) ? r.conflicts.length : 0,
    ranAt: r.ranAt.toISOString(),
    ranBy: r.ranBy,
  }));
}

/**
 * Invalida el cache del catálogo en los consultorios (`tags.catalog()`).
 *
 * Por qué existe: `scripts/catalog-import.ts --apply` corre FUERA de Next
 * (tsx desde la terminal) y no puede llamar `revalidateTag`; sin esto, lo
 * importado recién se ve en los pickers cuando vence `ttl.long` (1 h). Paso
 * final del runbook del import: dry-run → --apply → dry-run = 0 → "Refrescar
 * catálogo" en Plataforma → Catálogo → Importaciones. Las ediciones desde
 * Plataforma ya invalidan solas (`revalidateCatalog`).
 */
export async function refreshCatalogCache(): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.catalog.refreshCache",
    entity: "Catalog",
    entityId: "global",
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Edición (marca curatedAt)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Edita una prestadora. El `matchKey` NO se recalcula: es la identidad con la
 * que el import reconoce la fila oficial, y renombrar para mostrar no la
 * cambia. El nombre anterior pasa a alias, así la búsqueda de los consultorios
 * la sigue encontrando por el nombre viejo.
 */
export async function updatePayer(raw: unknown): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const parsed = PayerAdminUpdate.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { id, ...d } = parsed.data;
  const cur = await prismaService.payer.findUnique({ where: { id }, select: { name: true } });
  if (!cur) return { ok: false, error: "Prestadora no encontrada." };
  const aliases = unionAliases(d.name, d.aliases, d.name !== cur.name ? [cur.name] : []);
  await prismaService.payer.update({
    where: { id },
    data: {
      name: d.name,
      legalName: d.legalName,
      kind: d.kind,
      registryCode: d.registryCode,
      cuit: d.cuit,
      province: d.province,
      aliases,
      curatedAt: new Date(),
    },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.catalog.payer.update",
    entity: "Payer",
    entityId: id,
    payload: { name: d.name, previousName: cur.name, kind: d.kind },
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

/** Edita una práctica (mismo criterio de matchKey y alias que `updatePayer`). */
export async function updatePractice(raw: unknown): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const parsed = PracticeAdminUpdate.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { id, ...d } = parsed.data;
  const cur = await prismaService.practice.findUnique({ where: { id }, select: { name: true } });
  if (!cur) return { ok: false, error: "Práctica no encontrada." };
  const aliases = unionAliases(d.name, d.aliases, d.name !== cur.name ? [cur.name] : []);
  await prismaService.practice.update({
    where: { id },
    data: {
      name: d.name,
      code: d.code,
      nomenclador: d.nomenclador,
      defaultDurationMin: d.defaultDurationMin,
      aliases,
      curatedAt: new Date(),
    },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.catalog.practice.update",
    entity: "Practice",
    entityId: id,
    payload: { name: d.name, previousName: cur.name, code: d.code },
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

/** Edita una especialidad (mismo criterio de matchKey y alias que `updatePayer`). */
export async function updateSpecialty(raw: unknown): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const parsed = SpecialtyAdminUpdate.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { id, ...d } = parsed.data;
  const cur = await prismaService.specialty.findUnique({ where: { id }, select: { name: true } });
  if (!cur) return { ok: false, error: "Especialidad no encontrada." };
  const aliases = unionAliases(d.name, d.aliases, d.name !== cur.name ? [cur.name] : []);
  await prismaService.specialty.update({
    where: { id },
    data: { name: d.name, aliases, curatedAt: new Date() },
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.catalog.specialty.update",
    entity: "Specialty",
    entityId: id,
    payload: { name: d.name, previousName: cur.name },
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

/**
 * Archiva / desarchiva. Archivar también marca `curatedAt`: si no, el próximo
 * import vería la fila oficial sin curar y podría "resucitarla". Lo ya vinculado
 * en los consultorios (Insurer.payerId, Service.practiceId) NO se toca: el
 * archivado solo saca la fila de los pickers.
 */
export async function setCatalogArchived(raw: unknown): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const parsed = CatalogArchive.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { entity, id, archived } = parsed.data;
  const data = { archivedAt: archived ? new Date() : null, curatedAt: new Date() };
  try {
    if (entity === "payer") await prismaService.payer.update({ where: { id }, data });
    else if (entity === "practice") await prismaService.practice.update({ where: { id }, data });
    else await prismaService.specialty.update({ where: { id }, data });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
      return { ok: false, error: "No encontramos esa fila del catálogo." };
    }
    throw e;
  }
  const entityName = entity === "payer" ? "Payer" : entity === "practice" ? "Practice" : "Specialty";
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: `admin.catalog.${entity}.${archived ? "archive" : "restore"}`,
    entity: entityName,
    entityId: id,
  });
  revalidateCatalog();
  return { ok: true, data: undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// Merges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fusiona la prestadora `fromId` en `intoId`, en UNA transacción:
 *  1. `Insurer.payerId` de todos los consultorios → into.
 *  2. Planes de from → into. Si into ya tiene un plan con el mismo slug en el
 *     mismo ámbito (global, o del mismo consultorio), las coberturas del plan
 *     duplicado se repuntan a ese y el duplicado se borra (quedó sin
 *     referencias). `PayerPlan.payerId` es RESTRICT: todo plan sale de from
 *     antes de tocar la prestadora.
 *  3. Aliases: into ∪ nombre de from ∪ aliases de from.
 *  4. from queda archivada y curada (no se borra: ver cabecera).
 */
export async function mergePayer(raw: unknown): Promise<ActionResult<MergeResult>> {
  const actor = await requireSuperAdmin();
  const parsed = CatalogMerge.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  const { fromId, intoId } = parsed.data;

  let result: MergeResult;
  try {
    result = await prismaService.$transaction(async (tx) => {
      const [from, into] = await Promise.all([
        tx.payer.findUnique({ where: { id: fromId } }),
        tx.payer.findUnique({ where: { id: intoId } }),
      ]);
      if (!from || !into) throw new CatalogAdminError("Prestadora no encontrada.");
      if (into.archivedAt) throw new CatalogAdminError("La prestadora destino está archivada: restaurala primero.");

      const insurers = await tx.insurer.updateMany({ where: { payerId: from.id }, data: { payerId: into.id } });

      let plansMoved = 0;
      let plansMerged = 0;
      let coveragesMoved = 0;
      const plans = await tx.payerPlan.findMany({ where: { payerId: from.id } });
      for (const plan of plans) {
        const twin = await tx.payerPlan.findFirst({
          where: { payerId: into.id, slug: plan.slug, tenantId: plan.tenantId },
          select: { id: true, name: true, archivedAt: true },
        });
        if (twin) {
          // `Coverage.planName` es el cache de display del plan (contrato de
          // M-cat): se actualiza al nombre del gemelo en la MISMA tx; si no, la
          // ficha del paciente mostraba el nombre del plan borrado.
          const cov = await tx.coverage.updateMany({
            where: { payerPlanId: plan.id },
            data: { payerPlanId: twin.id, planName: twin.name },
          });
          coveragesMoved += cov.count;
          // Gemelo archivado y el plan absorbido vivo: se restaura (como en
          // `promotePayerPlan`). Si no, las coberturas quedaban apuntando a un
          // plan archivado que el picker del consultorio ya no ofrece.
          if (twin.archivedAt && !plan.archivedAt) {
            await tx.payerPlan.update({ where: { id: twin.id }, data: { archivedAt: null } });
          }
          await tx.payerPlan.delete({ where: { id: plan.id } });
          plansMerged++;
        } else {
          await tx.payerPlan.update({ where: { id: plan.id }, data: { payerId: into.id } });
          plansMoved++;
        }
      }

      const aliases = unionAliases(into.name, into.aliases, [from.name], from.aliases);
      const now = new Date();
      await tx.payer.update({
        where: { id: into.id },
        data: {
          aliases,
          // Completa lo que el destino no tenía (sin pisar lo que sí tiene).
          legalName: into.legalName ?? from.legalName,
          registryCode: into.registryCode ?? from.registryCode,
          cuit: into.cuit ?? from.cuit,
          province: into.province ?? from.province,
          curatedAt: now,
        },
      });
      await tx.payer.update({ where: { id: from.id }, data: { archivedAt: from.archivedAt ?? now, curatedAt: now } });

      return {
        moved: { insurers: insurers.count, plans: plansMoved, plansMerged, coverages: coveragesMoved },
        aliasesAdded: aliases.length - into.aliases.length,
      };
    });
  } catch (e) {
    if (e instanceof CatalogAdminError) return { ok: false, error: e.message };
    throw e;
  }

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.catalog.payer.merge",
    entity: "Payer",
    entityId: intoId,
    payload: { fromId, intoId, ...result.moved, aliasesAdded: result.aliasesAdded },
  });
  revalidateCatalog();
  return { ok: true, data: result };
}

/**
 * Fusiona la práctica `fromId` en `intoId`, en una transacción:
 * `Service.practiceId` de todos los consultorios → into; los vínculos
 * PracticeSpecialty de from se suman a into (sin duplicar) y se borran de from;
 * aliases unidos; código/nomenclador/duración completan lo que into no tenía;
 * from queda archivada y curada.
 */
export async function mergePractice(raw: unknown): Promise<ActionResult<MergeResult>> {
  const actor = await requireSuperAdmin();
  const parsed = CatalogMerge.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  const { fromId, intoId } = parsed.data;

  let result: MergeResult;
  try {
    result = await prismaService.$transaction(async (tx) => {
      const [from, into] = await Promise.all([
        tx.practice.findUnique({ where: { id: fromId } }),
        tx.practice.findUnique({ where: { id: intoId } }),
      ]);
      if (!from || !into) throw new CatalogAdminError("Práctica no encontrada.");
      if (into.archivedAt) throw new CatalogAdminError("La práctica destino está archivada: restaurala primero.");

      const services = await tx.service.updateMany({ where: { practiceId: from.id }, data: { practiceId: into.id } });

      const links = await tx.practiceSpecialty.findMany({ where: { practiceId: from.id } });
      const added = links.length
        ? await tx.practiceSpecialty.createMany({
            data: links.map((l) => ({ practiceId: into.id, specialtyId: l.specialtyId })),
            skipDuplicates: true,
          })
        : { count: 0 };
      await tx.practiceSpecialty.deleteMany({ where: { practiceId: from.id } });

      const aliases = unionAliases(into.name, into.aliases, [from.name], from.aliases);
      const now = new Date();
      await tx.practice.update({
        where: { id: into.id },
        data: {
          aliases,
          code: into.code ?? from.code,
          nomenclador: into.nomenclador ?? from.nomenclador,
          defaultDurationMin: into.defaultDurationMin ?? from.defaultDurationMin,
          curatedAt: now,
        },
      });
      await tx.practice.update({ where: { id: from.id }, data: { archivedAt: from.archivedAt ?? now, curatedAt: now } });

      return {
        moved: { services: services.count, specialties: added.count },
        aliasesAdded: aliases.length - into.aliases.length,
      };
    });
  } catch (e) {
    if (e instanceof CatalogAdminError) return { ok: false, error: e.message };
    throw e;
  }

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.catalog.practice.merge",
    entity: "Practice",
    entityId: intoId,
    payload: { fromId, intoId, ...result.moved, aliasesAdded: result.aliasesAdded },
  });
  revalidateCatalog();
  return { ok: true, data: result };
}

// ─────────────────────────────────────────────────────────────────────────────
// Promoción de planes propuestos por consultorios
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Promueve un plan propuesto por un consultorio (PayerPlan con tenantId) al
 * catálogo global.
 *  - Sin plan global con el mismo (payerId, slug): la fila pasa a global
 *    (`tenantId = null`, `promotedAt`). Las coberturas que ya la usaban no
 *    cambian.
 *  - Con plan global gemelo: merge. Las coberturas del plan propuesto se
 *    repuntan al global y el propuesto queda archivado + `promotedAt` (registro
 *    de que se absorbió). Si el global estaba archivado se restaura: promover
 *    es justamente decir "este plan existe".
 * Una carrera entre dos promociones del mismo slug la corta el índice único
 * parcial `PayerPlan_payerId_slug_global_key` (P2002).
 */
export async function promotePayerPlan(raw: unknown): Promise<ActionResult<{ planId: string; merged: boolean }>> {
  const actor = await requireSuperAdmin();
  const parsed = PayerPlanPromote.safeParse(typeof raw === "string" ? { planId: raw } : raw);
  if (!parsed.success) return invalid(parsed.error);
  const { planId } = parsed.data;

  let out: { planId: string; merged: boolean; tenantId: string; coverages: number };
  try {
    out = await prismaService.$transaction(async (tx) => {
      const plan = await tx.payerPlan.findUnique({
        where: { id: planId },
        include: { payer: { select: { archivedAt: true } } },
      });
      if (!plan) throw new CatalogAdminError("Plan no encontrado.");
      if (plan.tenantId == null) throw new CatalogAdminError("Ese plan ya es del catálogo global.");
      if (plan.archivedAt) throw new CatalogAdminError("El plan está archivado.");
      if (plan.payer.archivedAt) throw new CatalogAdminError("La prestadora del plan está archivada.");
      const now = new Date();

      const twin = await tx.payerPlan.findFirst({
        where: { payerId: plan.payerId, slug: plan.slug, tenantId: null },
        select: { id: true, name: true, archivedAt: true },
      });
      if (twin) {
        // Mismo contrato que `mergePayer`: `planName` (cache de display) sigue
        // al plan global en la misma tx.
        const cov = await tx.coverage.updateMany({
          where: { payerPlanId: plan.id },
          data: { payerPlanId: twin.id, planName: twin.name },
        });
        if (twin.archivedAt) await tx.payerPlan.update({ where: { id: twin.id }, data: { archivedAt: null } });
        await tx.payerPlan.update({ where: { id: plan.id }, data: { archivedAt: now, promotedAt: now } });
        return { planId: twin.id, merged: true, tenantId: plan.tenantId, coverages: cov.count };
      }
      await tx.payerPlan.update({ where: { id: plan.id }, data: { tenantId: null, promotedAt: now } });
      return { planId: plan.id, merged: false, tenantId: plan.tenantId, coverages: 0 };
    });
  } catch (e) {
    if (e instanceof CatalogAdminError) return { ok: false, error: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "Otro plan global con ese nombre apareció recién. Reintentá: se va a fusionar." };
    }
    throw e;
  }

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.catalog.payerPlan.promote",
    entity: "PayerPlan",
    entityId: planId,
    payload: { globalPlanId: out.planId, merged: out.merged, proposedBy: out.tenantId, coveragesMoved: out.coverages },
  });
  revalidateCatalog();
  return { ok: true, data: { planId: out.planId, merged: out.merged } };
}
