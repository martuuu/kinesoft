import { listExercises, loadFilterFacets } from "@/lib/exercises";
import { BibliotecaClient } from "@/components/biblioteca/biblioteca-client";

export const metadata = { title: "Biblioteca · KineSoft" };
export const dynamic = "force-dynamic";

type SP = {
  q?: string;
  difficulty?: string;
  muscle?: string;
  equipment?: string;
  condition?: string;
};

export default async function BibliotecaPage({ searchParams }: { searchParams: SP }) {
  const filters = {
    q: searchParams.q,
    difficulty: searchParams.difficulty ? Number(searchParams.difficulty) : undefined,
    muscleGroup: searchParams.muscle,
    equipment: searchParams.equipment,
    conditionSlug: searchParams.condition,
  };
  const [items, facets] = await Promise.all([listExercises(filters), loadFilterFacets()]);
  return <BibliotecaClient items={items} facets={facets} active={filters} />;
}
