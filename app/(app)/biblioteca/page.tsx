import { listAllTags, listExercises, loadFilterFacets } from "@/lib/exercises";
import { gatingForActor } from "@/lib/plan-gating";
import { BibliotecaClient } from "@/components/biblioteca/biblioteca-client";

export const metadata = { title: "Biblioteca · KineSoft" };
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

export default async function BibliotecaPage({ searchParams }: { searchParams: SP }) {
  const filters = {
    q: searchParams.q,
    difficulty: searchParams.difficulty ? Number(searchParams.difficulty) : undefined,
    muscleGroup: searchParams.muscle,
    equipment: searchParams.equipment,
    conditionSlug: searchParams.condition,
    favouritesOnly: searchParams.favs === "1",
    privateOnly: searchParams.priv === "1",
  };
  const [items, facets, tags, gate] = await Promise.all([
    listExercises(filters),
    loadFilterFacets(),
    listAllTags(),
    gatingForActor(),
  ]);
  return (
    <BibliotecaClient
      items={items}
      facets={facets}
      active={filters}
      tags={tags}
      capabilities={{
        plan: gate.plan,
        canFavourite: gate.canFavourite,
        hasFullCatalog: gate.hasFullCatalog,
      }}
    />
  );
}
