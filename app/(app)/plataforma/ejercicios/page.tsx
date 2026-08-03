import { listGlobalExercisesForAdmin } from "@/lib/exercises-admin";
import { listAllTags } from "@/lib/exercises";
import { ExerciseAdminClient } from "@/components/plataforma/exercise-admin-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Plataforma · Catálogo de ejercicios" };

export default async function PlataformaEjerciciosPage() {
  const [exercises, tagOptions] = await Promise.all([
    listGlobalExercisesForAdmin({ includeArchived: true }),
    listAllTags(),
  ]);
  return <ExerciseAdminClient exercises={exercises} tagOptions={tagOptions} />;
}
