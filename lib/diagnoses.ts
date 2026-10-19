"use server";

/**
 * Diagnósticos de la ficha: búsqueda, favoritos, recientes y propios del consultorio (FC-2c, C-FC2, brief §24.4).
 *
 * Gate de lectura: módulo `evoluciones` + `clinical.read` (la ficha es HC). Secretaria, Facturación, un Titular/Admin
 * que no atiende y el soporte → `null` / `[]`, sin tocar la base. Un `"use server"` es una RPC pública: que el selector
 * solo aparezca dentro de la ficha no alcanza.
 *
 * Propios (`TenantDiagnosis`, FC-D22): los crea cualquier profesional con escritura clínica (clínico + `Practitioner`,
 * desde la ficha) o quien tenga `tenant.sensitive` (Configuración); los editan o archivan quien los creó o
 * `tenant.sensitive`. Renombrar o archivar NO toca las fichas: cada ficha guarda su snapshot congelado
 * (`resolveDiagnosesInTx`, `lib/diagnoses-internal.ts`).
 *
 * Cada action: `getActor()` → gate → zod → `where: { tenantId }` a mano (en prod la conexión tiene BYPASSRLS) →
 * `runWithRls`. `DiagnosisCode` es global de solo lectura (policy `FOR SELECT USING (true)`): lo escribe solo el
 * importador. Sin catálogo cargado (antes de bajar la tabulación de la OMS) la búsqueda responde
 * `icdCatalogLoaded: false` y la UI muestra `DIAGNOSIS_COPY.catalogEmpty`; propios, Kinesiología y texto libre
 * siguen andando (FC-D27).
 *
 * Los tipos y el copy viven en `lib/diagnoses-types.ts` (un "use server" exporta solo funciones async).
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auditInTx } from "@/lib/audit";
import { capabilitiesForActor } from "@/lib/authz";
import {
  dedupeRecents,
  diagnosisSnapshotKey,
  normalizeDiagnosisText,
  parseDiagnosisQuery,
  rankDiagnosisMatch,
  type ParsedDiagnosisQuery,
} from "@/lib/diagnoses-logic";
import {
  DIAGNOSIS_COPY,
  DIAGNOSIS_FAVORITES_MAX,
  DIAGNOSIS_RECENTS_MAX,
  DIAGNOSIS_SEARCH_LIMIT,
  DIAGNOSIS_SOURCE_LABEL,
  DIAGNOSIS_TEXT_MAX,
  DIAGNOSIS_TEXT_MIN,
  type DiagnosisOption,
  type DiagnosisPickerHome,
  type DiagnosisRef,
  type DiagnosisSearchResult,
  type DiagnosisSnapshot,
  type DiagnosisSource,
  type TenantDiagnosisRow,
} from "@/lib/diagnoses-types";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { runWithRls, type DbClient } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";
import type { ActionResult } from "@/lib/validation";

// ─── Gate ────────────────────────────────────────────────────────────────────────────────────────────────────────────

type DiagnosesGate = {
  /** Lee el selector: módulo `evoluciones` + `clinical.read`. */
  clinical: boolean;
  /** Escritura clínica sin paciente: lo anterior + `Practitioner` (el autor de una ficha es un profesional, EV2-D3). */
  canWrite: boolean;
  /** `tenant.sensitive`: gestiona los propios desde Configuración. */
  sensitive: boolean;
  /** Grupo «Kinesiología» (`Condition`): módulo `diagnostico`. */
  kine: boolean;
};

const CLOSED: DiagnosesGate = { clinical: false, canWrite: false, sensitive: false, kine: false };

/**
 * 0 queries (caps de `actor.membership`). El soporte queda cerrado del todo aunque `SUPPORT_CAPS` traiga
 * `tenant.sensitive`: el contrato dice «soporte → null/[]» y los propios son vocabulario clínico del consultorio.
 */
async function gateFor(actor: Actor): Promise<DiagnosesGate> {
  if (actor.support) return CLOSED;
  const caps = await capabilitiesForActor(actor);
  const modules = modulesFor(actor.entitlements);
  const clinical = modules.has("evoluciones") && caps.has("clinical.read");
  return {
    clinical,
    // Truthiness (no `=== "string"`): el guard de IAM-4a (actor-practitioner-guard) prohíbe comparar
    // `actor.practitionerId` contra algo que no sea null; null o "" = rol no clínico → no escribe.
    canWrite: clinical && Boolean(actor.practitionerId),
    sensitive: caps.has("tenant.sensitive"),
    kine: clinical && modules.has("diagnostico"),
  };
}

const canManageRow = (g: DiagnosesGate, actor: Actor, createdByUserId: string | null) =>
  g.sensitive || (g.canWrite && createdByUserId !== null && createdByUserId === actor.userId);

const FORBIDDEN = "No tenés permiso para hacer esta acción.";
const STALE = "Alguien cambió este diagnóstico mientras lo editabas. Volvé a abrirlo.";
const INVALID = "Revisá los datos del diagnóstico.";

// ─── Zod ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const SearchInput = z.object({ q: z.string().max(DIAGNOSIS_TEXT_MAX * 2) }).strict();
const IdRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("icd11"), id: Id }).strict(),
  z.object({ kind: z.literal("tenant"), id: Id }).strict(),
  z.object({ kind: z.literal("kine"), id: Id }).strict(),
]);
const ToggleInput = z.object({ ref: IdRef, on: z.boolean() }).strict();
const TitleSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length >= DIAGNOSIS_TEXT_MIN && v.length <= DIAGNOSIS_TEXT_MAX && normalizeDiagnosisText(v) !== "", {
    message: DIAGNOSIS_COPY.textLength,
  });
// Código libre del propio (p. ej. un CIE-10 que el consultorio ya usaba): 1..20 como el CHECK; vacío → sin código.
const CodeSchema = z
  .string()
  .max(40)
  .nullish()
  .transform((v) => (v == null || v.trim() === "" ? null : v.trim()))
  .refine((v) => v === null || v.length <= 20, { message: INVALID });
const CreateInput = z.object({ title: TitleSchema, code: CodeSchema }).strict();
const UpdateInput = z
  .object({ id: Id, title: TitleSchema, code: CodeSchema, expectedUpdatedAt: z.string().datetime({ offset: true }) })
  .strict();
const ArchiveInput = z.object({ id: Id }).strict();

const firstIssue = (e: z.ZodError) => e.issues[0]?.message || INVALID;

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `searchText` del propio: misma normalización que la CIE-11 (código + título), con el tope del CHECK (400). */
function tenantSearchText(title: string, code: string | null): string {
  return normalizeDiagnosisText(`${code ?? ""} ${title}`).slice(0, 400).trim();
}

const FAVORITE_COLUMN = { icd11: "diagnosisCodeId", tenant: "tenantDiagnosisId", kine: "conditionId" } as const;
type IdKind = keyof typeof FAVORITE_COLUMN;

type FavoriteSets = Record<IdKind, Set<string>>;

async function favoriteSetsInTx(tx: DbClient, actor: Actor): Promise<FavoriteSets> {
  const rows = await tx.diagnosisFavorite.findMany({
    where: { tenantId: actor.tenantId, userId: actor.userId },
    select: { diagnosisCodeId: true, tenantDiagnosisId: true, conditionId: true },
    take: DIAGNOSIS_FAVORITES_MAX,
  });
  const sets: FavoriteSets = { icd11: new Set(), tenant: new Set(), kine: new Set() };
  for (const r of rows) {
    if (r.diagnosisCodeId) sets.icd11.add(r.diagnosisCodeId);
    if (r.tenantDiagnosisId) sets.tenant.add(r.tenantDiagnosisId);
    if (r.conditionId) sets.kine.add(r.conditionId);
  }
  return sets;
}

function option(kind: IdKind, id: string, code: string | null, title: string, extra: { retired?: boolean; favorite: boolean }): DiagnosisOption {
  return { ref: { kind, id } as DiagnosisRef, source: kind, code, title, retired: extra.retired ?? false, favorite: extra.favorite };
}

/** Orden del grupo: el rango (`rankDiagnosisMatch`), después favoritos, después el título más corto, después A-Z. */
function rankOptions(options: DiagnosisOption[], q: ParsedDiagnosisQuery): DiagnosisOption[] {
  const ranked = options.flatMap((o) => {
    const r = rankDiagnosisMatch(o, q);
    return r === null ? [] : [{ o, r }];
  });
  ranked.sort(
    (a, b) =>
      a.r - b.r ||
      Number(b.o.favorite) - Number(a.o.favorite) ||
      a.o.title.length - b.o.title.length ||
      a.o.title.localeCompare(b.o.title, "es")
  );
  return ranked.slice(0, DIAGNOSIS_SEARCH_LIMIT).map((x) => x.o);
}

const icdCatalogLoadedInTx = async (tx: DbClient) =>
  (await tx.diagnosisCode.findFirst({ where: { system: "ICD11_MMS", retiredAt: null }, select: { id: true } })) !== null;

/**
 * Candidatos CIE-11 (~17k filas, sin `pg_trgm`, §24.3): el SQL pre-filtra y pre-ordena con la MISMA regla que
 * `rankDiagnosisMatch` y trae de más (3×); el orden final lo da la función pura, que es la que fija el test.
 *
 * El título normalizado sale del `searchText` sin el código del principio (el importador lo arma «código título» con
 * `normalizeIcdSearchText`; el código CIE-11 solo tiene [0-9A-Z.] → su forma normalizada es `lower(replace(code,'.',' '))`).
 * Los parámetros no necesitan escapar `%`/`_`: el texto normalizado es [a-z0-9 ] y el prefijo de código [0-9A-Z.].
 * Retirados afuera: elegirlos se rechaza al crear (`DIAGNOSIS_COPY.retired`).
 */
async function searchIcdInTx(tx: DbClient, q: ParsedDiagnosisQuery) {
  const tokens = q.text.split(" ").filter(Boolean).slice(0, 8);
  const titleNorm = Prisma.sql`substr(dc."searchText", char_length(lower(replace(dc."code", '.', ' '))) + 2)`;
  const textMatch = Prisma.join(
    tokens.map((t) => Prisma.sql`dc."searchText" LIKE ${`%${t}%`}`),
    " AND "
  );
  const filter = q.codePrefix ? Prisma.sql`(dc."code" LIKE ${`${q.codePrefix}%`} OR (${textMatch}))` : Prisma.sql`(${textMatch})`;
  const codeRank = q.codePrefix
    ? Prisma.sql`WHEN dc."code" = ${q.codePrefix} THEN 0 WHEN dc."code" LIKE ${`${q.codePrefix}%`} THEN 1`
    : Prisma.empty;
  return tx.$queryRaw<{ id: string; code: string; title: string }[]>`
    SELECT dc."id", dc."code", dc."title"
    FROM "DiagnosisCode" dc
    WHERE dc."system" = 'ICD11_MMS' AND dc."retiredAt" IS NULL AND ${filter}
    ORDER BY CASE ${codeRank}
               WHEN ${titleNorm} LIKE ${`${q.text}%`} THEN 2
               WHEN (' ' || ${titleNorm}) LIKE ${`% ${q.text}%`} THEN 3
               ELSE 4 END,
             char_length(dc."title"), dc."code"
    LIMIT ${DIAGNOSIS_SEARCH_LIMIT * 3}`;
}

// ─── Búsqueda y portada del selector ────────────────────────────────────────────────────────────────────────────────

/**
 * Grupos (los que tienen algo): Del consultorio · Kinesiología (con módulo `diagnostico`) · CIE-11. Dentro de cada
 * uno: código exacto > prefijo > empieza con > palabra > contiene, sin tildes. Favoritos y recientes van en
 * `getDiagnosisPickerHome` (antes de escribir); acá cada opción trae su ★.
 */
export async function searchDiagnoses(input: { q: string }): Promise<DiagnosisSearchResult | null> {
  const actor = await getActor();
  const g = await gateFor(actor);
  if (!g.clinical) return null;
  const parsed = SearchInput.safeParse(input);
  if (!parsed.success) return null;
  const query = parsed.data.q.trim();
  const canCreateOwn = g.canWrite || g.sensitive;
  const q = parseDiagnosisQuery(query);

  return runWithRls(actor.tenantId, async (tx): Promise<DiagnosisSearchResult> => {
    const icdCatalogLoaded = await icdCatalogLoadedInTx(tx);
    if (!q) return { query, groups: [], canCreateOwn, icdCatalogLoaded };

    const tokens = q.text.split(" ").filter(Boolean);
    const [fav, own, kine, icd] = await Promise.all([
      favoriteSetsInTx(tx, actor),
      tx.tenantDiagnosis.findMany({
        where: {
          tenantId: actor.tenantId,
          archivedAt: null,
          OR: [
            { AND: tokens.map((t) => ({ searchText: { contains: t } })) },
            ...(q.codePrefix ? [{ code: { startsWith: q.codePrefix, mode: "insensitive" as const } }] : []),
          ],
        },
        select: { id: true, code: true, title: true },
        take: 200,
      }),
      // El catálogo de Kinesiología es chico (globales sembradas + las custom del consultorio) y `Condition` no tiene
      // texto normalizado: se trae entero y se rankea acá, sin tildes.
      g.kine
        ? tx.condition.findMany({
            where: { OR: [{ tenantId: null }, { tenantId: actor.tenantId }] },
            select: { id: true, name: true },
            take: 2000,
          })
        : Promise.resolve([] as { id: string; name: string }[]),
      icdCatalogLoaded ? searchIcdInTx(tx, q) : Promise.resolve([] as { id: string; code: string; title: string }[]),
    ]);

    const groups: DiagnosisSearchResult["groups"] = [];
    const push = (source: Exclude<DiagnosisSource, "text">, options: DiagnosisOption[]) => {
      const ranked = rankOptions(options, q);
      if (ranked.length) groups.push({ source, label: DIAGNOSIS_SOURCE_LABEL[source], options: ranked });
    };
    push("tenant", own.map((r) => option("tenant", r.id, r.code, r.title, { favorite: fav.tenant.has(r.id) })));
    // FC-D25: Kinesiología sin `cie10` (no se mezclan sistemas ni licencias).
    push("kine", kine.map((r) => option("kine", r.id, null, r.name, { favorite: fav.kine.has(r.id) })));
    push("icd11", icd.map((r) => option("icd11", r.id, r.code, r.title, { favorite: fav.icd11.has(r.id) })));
    return { query, groups, canCreateOwn, icdCatalogLoaded };
  });
}

/**
 * Snapshots (recientes) → opciones VIGENTES: un CIE-11 retirado, un propio archivado o ajeno, o una condición sin el
 * módulo se caen (elegirlos se rechazaría al guardar). El título sale de la base, que es lo que se va a congelar.
 */
async function currentOptionsInTx(
  tx: DbClient,
  actor: Actor,
  g: DiagnosesGate,
  snaps: DiagnosisSnapshot[],
  fav: FavoriteSets
): Promise<DiagnosisOption[]> {
  const ids = (s: DiagnosisSource) => snaps.flatMap((x) => (x.source === s && x.refId ? [x.refId] : []));
  const [icdIds, ownIds, kineIds] = [ids("icd11"), ids("tenant"), g.kine ? ids("kine") : []];
  const [icd, own, kine] = await Promise.all([
    icdIds.length
      ? tx.diagnosisCode.findMany({ where: { id: { in: icdIds }, system: "ICD11_MMS", retiredAt: null }, select: { id: true, code: true, title: true } })
      : [],
    ownIds.length
      ? tx.tenantDiagnosis.findMany({ where: { id: { in: ownIds }, tenantId: actor.tenantId, archivedAt: null }, select: { id: true, code: true, title: true } })
      : [],
    kineIds.length
      ? tx.condition.findMany({ where: { id: { in: kineIds }, OR: [{ tenantId: null }, { tenantId: actor.tenantId }] }, select: { id: true, name: true } })
      : [],
  ]);
  const icdBy = new Map(icd.map((r) => [r.id, r]));
  const ownBy = new Map(own.map((r) => [r.id, r]));
  const kineBy = new Map(kine.map((r) => [r.id, r]));
  const out: DiagnosisOption[] = [];
  for (const s of snaps) {
    if (s.source === "text") {
      out.push({ ref: { kind: "text", text: s.title }, source: "text", code: null, title: s.title, retired: false, favorite: false });
      continue;
    }
    if (!s.refId) continue;
    if (s.source === "icd11") {
      const r = icdBy.get(s.refId);
      if (r) out.push(option("icd11", r.id, r.code, r.title, { favorite: fav.icd11.has(r.id) }));
    } else if (s.source === "tenant") {
      const r = ownBy.get(s.refId);
      if (r) out.push(option("tenant", r.id, r.code, r.title, { favorite: fav.tenant.has(r.id) }));
    } else {
      const r = kineBy.get(s.refId);
      if (r) out.push(option("kine", r.id, null, r.name, { favorite: fav.kine.has(r.id) }));
    }
  }
  return out;
}

/** Cuántas fichas recientes del usuario se miran para armar los 8 recientes (con margen por los que se caen). */
const RECENT_NOTES_SCAN = 30;

/**
 * Portada del selector (antes de escribir): favoritos del usuario en ESTE consultorio (≤200, el más nuevo primero) y
 * recientes (≤8) de sus últimas fichas no anuladas. Un favorito CIE-11 retirado se muestra con `retired: true` (para
 * poder sacarle la ★); un propio archivado, uno de otro consultorio o una condición sin el módulo no se muestran.
 */
export async function getDiagnosisPickerHome(): Promise<DiagnosisPickerHome | null> {
  const actor = await getActor();
  const g = await gateFor(actor);
  if (!g.clinical) return null;

  return runWithRls(actor.tenantId, async (tx): Promise<DiagnosisPickerHome> => {
    const [icdCatalogLoaded, favRows, notes] = await Promise.all([
      icdCatalogLoadedInTx(tx),
      tx.diagnosisFavorite.findMany({
        where: { tenantId: actor.tenantId, userId: actor.userId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: DIAGNOSIS_FAVORITES_MAX,
        select: {
          diagnosisCode: { select: { id: true, code: true, title: true, retiredAt: true } },
          tenantDiagnosis: { select: { id: true, tenantId: true, code: true, title: true, archivedAt: true } },
          condition: { select: { id: true, tenantId: true, name: true } },
        },
      }),
      tx.clinicalNote.findMany({
        where: { tenantId: actor.tenantId, authorUserId: actor.userId, voidedAt: null, diagnoses: { not: Prisma.AnyNull } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: RECENT_NOTES_SCAN,
        select: { diagnoses: true },
      }),
    ]);

    const favorites: DiagnosisOption[] = [];
    const fav: FavoriteSets = { icd11: new Set(), tenant: new Set(), kine: new Set() };
    for (const f of favRows) {
      if (f.diagnosisCode) {
        const d = f.diagnosisCode;
        fav.icd11.add(d.id);
        favorites.push(option("icd11", d.id, d.code, d.title, { favorite: true, retired: d.retiredAt !== null }));
      } else if (f.tenantDiagnosis) {
        const d = f.tenantDiagnosis;
        // La FK compuesta ya ata el favorito al consultorio; se re-chequea igual (BYPASSRLS en prod).
        if (d.tenantId !== actor.tenantId || d.archivedAt) continue;
        fav.tenant.add(d.id);
        favorites.push(option("tenant", d.id, d.code, d.title, { favorite: true }));
      } else if (f.condition) {
        const c = f.condition;
        // `Condition` puede ser global o propia: la FK no lo valida (comentario de M14), la app sí.
        if (!g.kine || (c.tenantId !== null && c.tenantId !== actor.tenantId)) continue;
        fav.kine.add(c.id);
        favorites.push(option("kine", c.id, null, c.name, { favorite: true }));
      }
    }

    const perNote = notes.map((n) => (Array.isArray(n.diagnoses) ? (n.diagnoses as unknown as DiagnosisSnapshot[]) : []));
    // Se deduplica con margen (×3) ANTES de validar contra la base: los que se caen no tienen que dejar menos de 8.
    const candidates = dedupeRecents(perNote, DIAGNOSIS_RECENTS_MAX * 3);
    const recents = (await currentOptionsInTx(tx, actor, g, candidates, fav))
      .filter((o, i, all) => all.findIndex((x) => optionKey(x) === optionKey(o)) === i)
      .slice(0, DIAGNOSIS_RECENTS_MAX);
    return { favorites, recents, icdCatalogLoaded };
  });
}

const optionKey = (o: DiagnosisOption) =>
  o.ref.kind === "text" ? diagnosisSnapshotKey({ source: "text", refId: null, title: o.title }) : `${o.ref.kind}:${o.ref.id}`;

// ─── Favoritos ───────────────────────────────────────────────────────────────────────────────────────────────────────

class FavoriteRejected extends Error {}

/**
 * ★ idempotente, por usuario y consultorio, tope 200. Prender valida el destino (CIE-11 vigente, propio vivo de este
 * consultorio, condición global o propia con el módulo); apagar borra solo el favorito propio, sin validar el destino
 * (así se le puede sacar la ★ a un retirado o archivado). El tope se cuenta en la tx: dos ★ simultáneas en el 199
 * pueden dejar 201 (aceptado: el tope es de UX, no de integridad).
 */
export async function toggleDiagnosisFavorite(input: {
  ref: Exclude<DiagnosisRef, { kind: "text" }>;
  on: boolean;
}): Promise<ActionResult<{ favorite: boolean }>> {
  return withReadOnlyResult(async () => {
    const actor = await getActor();
    const g = await gateFor(actor);
    if (!g.clinical) return { ok: false, error: FORBIDDEN };
    const parsed = ToggleInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: INVALID };
    const { ref, on } = parsed.data;
    const column = FAVORITE_COLUMN[ref.kind];
    const target = { tenantId: actor.tenantId, userId: actor.userId, [column]: ref.id };

    try {
      return await runWithRls(actor.tenantId, async (tx): Promise<ActionResult<{ favorite: boolean }>> => {
        if (!on) {
          await tx.diagnosisFavorite.deleteMany({ where: target });
          return { ok: true, data: { favorite: false } };
        }
        if (await tx.diagnosisFavorite.findFirst({ where: target, select: { id: true } })) {
          return { ok: true, data: { favorite: true } };
        }
        if (ref.kind === "icd11") {
          const d = await tx.diagnosisCode.findFirst({ where: { id: ref.id, system: "ICD11_MMS" }, select: { retiredAt: true } });
          if (!d) throw new FavoriteRejected(DIAGNOSIS_COPY.notAvailable);
          if (d.retiredAt) throw new FavoriteRejected(DIAGNOSIS_COPY.retired);
        } else if (ref.kind === "tenant") {
          const d = await tx.tenantDiagnosis.findFirst({
            where: { id: ref.id, tenantId: actor.tenantId, archivedAt: null },
            select: { id: true },
          });
          if (!d) throw new FavoriteRejected(DIAGNOSIS_COPY.notAvailable);
        } else {
          const c = g.kine
            ? await tx.condition.findFirst({
                where: { id: ref.id, OR: [{ tenantId: null }, { tenantId: actor.tenantId }] },
                select: { id: true },
              })
            : null;
          if (!c) throw new FavoriteRejected(DIAGNOSIS_COPY.notAvailable);
        }
        const count = await tx.diagnosisFavorite.count({ where: { tenantId: actor.tenantId, userId: actor.userId } });
        if (count >= DIAGNOSIS_FAVORITES_MAX) throw new FavoriteRejected(DIAGNOSIS_COPY.favoritesFull);
        await tx.diagnosisFavorite.create({ data: target as Prisma.DiagnosisFavoriteUncheckedCreateInput });
        return { ok: true, data: { favorite: true } };
      });
    } catch (e) {
      if (e instanceof FavoriteRejected) return { ok: false, error: e.message };
      // Doble clic en dos pestañas: el índice único ya lo tiene → idempotente.
      if (isUniqueViolation(e)) return { ok: true, data: { favorite: true } };
      throw e;
    }
  });
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

// ─── Propios del consultorio (FC-D22) ────────────────────────────────────────────────────────────────────────────────

type TenantDiagnosisSelected = { id: string; title: string; code: string | null; archivedAt: Date | null; createdByUserId: string | null; updatedAt: Date };
const TD_SELECT = { id: true, title: true, code: true, archivedAt: true, createdByUserId: true, updatedAt: true } as const;

function toRow(r: TenantDiagnosisSelected, g: DiagnosesGate, actor: Actor): TenantDiagnosisRow {
  return {
    id: r.id,
    title: r.title,
    code: r.code,
    archived: r.archivedAt !== null,
    createdByMe: r.createdByUserId !== null && r.createdByUserId === actor.userId,
    canManage: canManageRow(g, actor, r.createdByUserId),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Todos los propios (vivos primero, A-Z; los archivados al final) para Configuración y para el selector. */
export async function listTenantDiagnoses(): Promise<TenantDiagnosisRow[]> {
  const actor = await getActor();
  const g = await gateFor(actor);
  if (!g.clinical && !g.sensitive) return [];
  const rows = await runWithRls(actor.tenantId, (tx) =>
    tx.tenantDiagnosis.findMany({ where: { tenantId: actor.tenantId }, select: TD_SELECT, take: 1000 })
  );
  return rows
    .sort(
      (a, b) =>
        Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.title.localeCompare(b.title, "es")
    )
    .map((r) => toRow(r, g, actor));
}

/**
 * Alta de un propio: desde la ficha («Crear "{texto}" como diagnóstico propio») o desde Configuración. Un nombre vivo
 * por consultorio sin distinguir mayúsculas: lo garantiza el índice único PARCIAL de M14 (`lower(btrim(title))`); la
 * colisión llega como 23505 (P2002) y se traduce a `duplicateTitle`, sin pre-chequeo que pueda correr carrera.
 */
export async function createTenantDiagnosis(input: { title: string; code?: string | null }): Promise<ActionResult<{ option: DiagnosisOption }>> {
  return withReadOnlyResult(async () => {
    const actor = await getActor();
    const g = await gateFor(actor);
    if (!g.canWrite && !g.sensitive) return { ok: false, error: FORBIDDEN };
    const parsed = CreateInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
    const { title, code } = parsed.data;
    try {
      const created = await runWithRls(actor.tenantId, async (tx) => {
        const row = await tx.tenantDiagnosis.create({
          data: { tenantId: actor.tenantId, title, code, searchText: tenantSearchText(title, code), createdByUserId: actor.userId },
          select: { id: true, title: true, code: true },
        });
        await auditInTx(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "tenantDiagnosis.create",
          entity: "TenantDiagnosis",
          entityId: row.id,
        });
        return row;
      });
      return { ok: true, data: { option: option("tenant", created.id, created.code, created.title, { favorite: false }) } };
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, error: DIAGNOSIS_COPY.duplicateTitle };
      throw e;
    }
  });
}

class TenantDiagnosisRejected extends Error {}

/**
 * Renombrar (optimistic lock con `updatedAt`). Solo vivos: un archivado no se edita. Las fichas que ya lo usan
 * conservan el título con que se firmaron (snapshot).
 */
export async function updateTenantDiagnosis(input: {
  id: string;
  title: string;
  code?: string | null;
  expectedUpdatedAt: string;
}): Promise<ActionResult<{ row: TenantDiagnosisRow }>> {
  return withReadOnlyResult(async () => {
    const actor = await getActor();
    const g = await gateFor(actor);
    if (!g.canWrite && !g.sensitive) return { ok: false, error: DIAGNOSIS_COPY.forbidden };
    const parsed = UpdateInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
    const { id, title, code, expectedUpdatedAt } = parsed.data;
    try {
      const row = await runWithRls(actor.tenantId, async (tx) => {
        const cur = await tx.tenantDiagnosis.findFirst({ where: { id, tenantId: actor.tenantId }, select: TD_SELECT });
        if (!cur || cur.archivedAt) throw new TenantDiagnosisRejected(DIAGNOSIS_COPY.notAvailable);
        if (!canManageRow(g, actor, cur.createdByUserId)) throw new TenantDiagnosisRejected(DIAGNOSIS_COPY.forbidden);
        const { count } = await tx.tenantDiagnosis.updateMany({
          where: { id, tenantId: actor.tenantId, archivedAt: null, updatedAt: new Date(expectedUpdatedAt) },
          data: { title, code, searchText: tenantSearchText(title, code) },
        });
        if (count !== 1) throw new TenantDiagnosisRejected(STALE);
        await auditInTx(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "tenantDiagnosis.update",
          entity: "TenantDiagnosis",
          entityId: id,
        });
        return tx.tenantDiagnosis.findFirstOrThrow({ where: { id, tenantId: actor.tenantId }, select: TD_SELECT });
      });
      return { ok: true, data: { row: toRow(row, g, actor) } };
    } catch (e) {
      if (e instanceof TenantDiagnosisRejected) return { ok: false, error: e.message };
      if (isUniqueViolation(e)) return { ok: false, error: DIAGNOSIS_COPY.duplicateTitle };
      throw e;
    }
  });
}

/** Archivar (idempotente; nunca se borra: los favoritos y las fichas lo referencian). Sale del selector. */
export async function archiveTenantDiagnosis(input: { id: string }): Promise<ActionResult> {
  return withReadOnlyResult(async () => {
    const actor = await getActor();
    const g = await gateFor(actor);
    if (!g.canWrite && !g.sensitive) return { ok: false, error: DIAGNOSIS_COPY.forbidden };
    const parsed = ArchiveInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: INVALID };
    const { id } = parsed.data;
    try {
      await runWithRls(actor.tenantId, async (tx) => {
        const cur = await tx.tenantDiagnosis.findFirst({ where: { id, tenantId: actor.tenantId }, select: TD_SELECT });
        if (!cur) throw new TenantDiagnosisRejected(DIAGNOSIS_COPY.notAvailable);
        if (!canManageRow(g, actor, cur.createdByUserId)) throw new TenantDiagnosisRejected(DIAGNOSIS_COPY.forbidden);
        if (cur.archivedAt) return;
        await tx.tenantDiagnosis.updateMany({ where: { id, tenantId: actor.tenantId, archivedAt: null }, data: { archivedAt: new Date() } });
        await auditInTx(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "tenantDiagnosis.archive",
          entity: "TenantDiagnosis",
          entityId: id,
        });
      });
      return { ok: true, data: undefined };
    } catch (e) {
      if (e instanceof TenantDiagnosisRejected) return { ok: false, error: e.message };
      throw e;
    }
  });
}
