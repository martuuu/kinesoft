import { listGlobalExercisesForAdmin, listCatalogTagOptions } from "@/lib/exercises-admin";
import { listAllTags } from "@/lib/exercises";
import { getUserPreferences } from "@/lib/preferences";
import { sanitizeCatalogPrefs } from "@/lib/preferences-constants";
import { ExerciseAdminClient } from "@/components/plataforma/exercise-admin-client";

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

export default async function PlataformaEjerciciosPage({ searchParams }: { searchParams: SP }) {
  const prefs = await getUserPreferences();
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
    listAllTags(),
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
    />
  );
}
