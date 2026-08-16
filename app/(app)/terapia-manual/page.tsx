import { listAllTags, listExercises, loadFilterFacets } from "@/lib/exercises";
import { gatingForActor } from "@/lib/plan-gating";
import { getActor } from "@/lib/session";
import { BibliotecaClient } from "@/components/biblioteca/biblioteca-client";

export const metadata = { title: "Terapia Manual · KineSoft" };
export const dynamic = "force-dynamic";

type SP = {
  q?: string;
  difficulty?: string;
  muscle?: string;
  equipment?: string;
  condition?: string;
  favs?: string;
  priv?: string;
};

/**
 * /terapia-manual — same UI as /biblioteca but filtered to
 * `Exercise.kind = MANUAL_THERAPY`. The `BibliotecaClient` accepts a
 * `mode` prop that flips title/copy/create-target accordingly. The
 * underlying data model is unified (a single Exercise table) so
 * sessions can mix ejercicios + maniobras seamlessly.
 */
export default async function TerapiaManualPage({ searchParams }: { searchParams: SP }) {
  const filters = {
    q: searchParams.q,
    difficulty: searchParams.difficulty ? Number(searchParams.difficulty) : undefined,
    muscleGroup: searchParams.muscle,
    equipment: searchParams.equipment,
    conditionSlug: searchParams.condition,
    favouritesOnly: searchParams.favs === "1",
    privateOnly: searchParams.priv === "1",
    kind: "MANUAL_THERAPY" as const,
  };
  const [items, facets, tags, gate, actor] = await Promise.all([
    listExercises(filters),
    loadFilterFacets(),
    listAllTags(),
    gatingForActor(),
    getActor(),
  ]);
  return (
    <BibliotecaClient
      mode="manual-therapy"
      items={items}
      facets={facets}
      active={filters}
      tags={tags}
      // Superadmins edit catalog items in place (same drawer as Plataforma).
      isPlatformAdmin={actor.isPlatformAdmin}
      capabilities={{
        plan: gate.plan,
        canFavourite: gate.canFavourite,
        hasFullCatalog: gate.hasFullCatalog,
      }}
    />
  );
}
