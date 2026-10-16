import { listAllTags, listExercises, loadFilterFacets } from "@/lib/exercises";
import { gatingForActor } from "@/lib/plan-gating";
import { getActor } from "@/lib/session";
import { BibliotecaClient } from "@/components/biblioteca/biblioteca-client";
import { moduleWall } from "@/lib/module-wall";

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
  // VX-Z (B1): el layout y la página se renderizan EN PARALELO; sin el módulo, el layout muestra el muro o redirige,
  // pero la página igual corría sus queries (y `assertModule` tiraba). Mismo veredicto que el layout (actor cacheado).
  if ((await moduleWall("ejercicios")) !== "ok") return null;
  const filters = {
    q: searchParams.q,
    difficulty: searchParams.difficulty ? Number(searchParams.difficulty) : undefined,
    muscleGroup: searchParams.muscle,
    equipment: searchParams.equipment,
    conditionSlug: searchParams.condition,
    favouritesOnly: searchParams.favs === "1",
    privateOnly: searchParams.priv === "1",
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
      items={items}
      facets={facets}
      active={filters}
      tags={tags}
      capabilities={{
        plan: gate.plan,
        canFavourite: gate.canFavourite,
        hasFullCatalog: gate.hasFullCatalog,
      }}
      // Superadmins edit catalog items in place (same drawer as Plataforma).
      isPlatformAdmin={actor.isPlatformAdmin}
    />
  );
}
