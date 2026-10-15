import { listGlobalExercisesForAdmin, listCatalogTagOptions } from "@/lib/exercises-admin";
import { listTagsForAdmin } from "@/lib/tags-admin";
import { getUserPreferences } from "@/lib/preferences";
import { DEFAULT_PREFERENCES, sanitizeCatalogPrefs, type Preferences } from "@/lib/preferences-constants";
import { UnauthenticatedError } from "@/lib/session";
import { ExerciseAdminClient, type CatalogPrefsStore } from "@/components/plataforma/exercise-admin-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Plataforma · Catálogo de ejercicios" };

// Next hands over `string | string[]` (a repeated query key yields an array),
// so every read below has to tolerate both. `sanitizeCatalogPrefs` type-checks
// the scalars; `csv` handles the list params.
type Param = string | string[] | undefined;
type SP = {
  q?: Param; kind?: Param; tier?: Param; dif?: Param;
  muscle?: Param; equip?: Param; disc?: Param; arch?: Param;
  sort?: Param; dir?: Param; page?: Param; size?: Param;
};

const one = (v: Param): string | undefined => (Array.isArray(v) ? v[0] : v);

/** URL keys that represent table state — if none is present we restore the
 *  user's saved view instead of showing an unfiltered default. */
const STATE_KEYS: (keyof SP)[] = [
  "q", "kind", "tier", "dif", "muscle", "equip", "disc", "arch", "sort", "dir", "page", "size",
];

/** "a,b" or ["a","b,c"] → ["a","b","c"]. Total: never throws on array params. */
const csv = (v: Param): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);

/**
 * BO3-A: `getUserPreferences` pasa por `getActor` (Actor de CONSULTORIO). Un superadmin sin consultorio propio no
 * tiene Actor (`no_membership`) y, desde que /plataforma no cuelga de `(app)`, llega igual a esta página: sin esto
 * se caía entera. Sin Actor arranca con la vista por defecto (la URL sigue mandando).
 *
 * BO3-E: además dice DÓNDE se guarda la vista: con Actor, en la cuenta; sin Actor, en el navegador (el cliente
 * restaura la vista local y no llama a `updateUserPreferences`, que también pasa por `getActor`).
 */
async function catalogPrefsOrDefault(): Promise<{ catalogPrefs: Preferences["catalogPrefs"]; store: CatalogPrefsStore }> {
  try {
    return { catalogPrefs: (await getUserPreferences()).catalogPrefs, store: "account" };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { catalogPrefs: DEFAULT_PREFERENCES.catalogPrefs, store: "device" };
    throw err;
  }
}

export default async function PlataformaEjerciciosPage({ searchParams }: { searchParams: SP }) {
  const prefs = await catalogPrefsOrDefault();
  const hasUrlState = STATE_KEYS.some((k) => searchParams[k] != null && searchParams[k] !== "");

  // URL wins when present; otherwise fall back to the user's saved view.
  // `sanitizeCatalogPrefs` makes both paths total (bad values → defaults).
  const state = hasUrlState
    ? sanitizeCatalogPrefs({
        pageSize: one(searchParams.size) ? Number(one(searchParams.size)) : prefs.catalogPrefs.pageSize,
        sortCol: one(searchParams.sort) ?? prefs.catalogPrefs.sortCol,
        sortDir: one(searchParams.dir) ?? prefs.catalogPrefs.sortDir,
        filters: {
          q: one(searchParams.q) ?? "",
          kind: one(searchParams.kind) ?? "",
          tier: one(searchParams.tier) ?? "",
          difficulty: one(searchParams.dif) ? Number(one(searchParams.dif)) : null,
          muscle: csv(searchParams.muscle),
          equipment: csv(searchParams.equip),
          discipline: csv(searchParams.disc),
          archived: one(searchParams.arch) ?? "active",
        },
      })
    : prefs.catalogPrefs;

  const query = (page: number) =>
    listGlobalExercisesForAdmin({
      filters: state.filters,
      sortCol: state.sortCol,
      sortDir: state.sortDir,
      skip: (page - 1) * state.pageSize,
      take: state.pageSize,
    });

  let page = Math.max(1, Number(one(searchParams.page)) || 1);
  const [firstTry, tagOptions, catalogTags] = await Promise.all([
    query(page),
    // BO3-A: antes `listAllTags` (de `lib/exercises`, pasa por `getActor`: sin consultorio propio tiraba). Para un
    // superadmin devolvía todos los tags ordenados por kind y label: lo mismo que la lectura de plataforma.
    listTagsForAdmin().then((rows) => rows.map(({ slug, label }) => ({ slug, label }))),
    listCatalogTagOptions(),
  ]);
  let { rows, total } = firstTry;

  // Self-heal an out-of-range page (e.g. rows archived away underneath, or a
  // stale bookmark): fall back to the last page that actually has rows instead
  // of rendering a blank table that reads as "el catálogo está vacío".
  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  if (page > pageCount) {
    page = pageCount;
    ({ rows, total } = await query(page));
  }

  return (
    <ExerciseAdminClient
      rows={rows}
      total={total}
      page={page}
      state={state}
      tagOptions={tagOptions}
      catalogTags={catalogTags}
      prefsStore={prefs.store}
      hasUrlState={hasUrlState}
    />
  );
}
