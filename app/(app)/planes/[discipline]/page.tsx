import { notFound } from "next/navigation";
import { getCapabilities } from "@/lib/authz";
import { listServices } from "@/lib/bookings";
import { listPlans } from "@/lib/plans-read";
import { disciplineLabel } from "@/lib/plan-display";
import { PlanesClient } from "@/components/planes/planes-client";
import {
  PLANES_FILTER_PARAM,
  availableDisciplines,
  disciplineFromSlug,
  parsePlanesFilter,
  resolveDisciplineTab,
} from "@/components/planes/planes-model";
import { moduleWall } from "@/lib/module-wall";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { discipline: string } }) {
  const d = disciplineFromSlug(params.discipline);
  return { title: d ? `Planes · ${disciplineLabel(d)} · KineSoft` : "Planes · KineSoft" };
}

/**
 * `/planes/[disciplina]` (S21, PD-11). La pestaña existe solo si el
 * consultorio tiene algún servicio con esa disciplina; un slug desconocido o
 * una disciplina sin servicio → `notFound`.
 *
 * Los planes salen de `listPlans({discipline})` (S14): ACTIVE y PAUSED, sin
 * archivados, cada fila con el nivel del actor sobre su paciente (título null
 * para la Secretaria, sin autorización de la OS). El filtro "Sesiones sin
 * turno" (`?filtro=sin-turno`) se resuelve en el cliente sobre la misma lista
 * (`sinTurno` ya viene por fila): cambiar de filtro no necesita otra lectura.
 * El guard del módulo `planes` vive en `layout.tsx` (EV0).
 */
export default async function PlanesDisciplinePage({
  params,
  searchParams,
}: {
  params: { discipline: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // VX-Z (B1): el layout y la página se renderizan EN PARALELO; sin el módulo, el layout muestra el muro o redirige,
  // pero la página igual corría sus queries (y `assertModule` tiraba). Mismo veredicto que el layout (actor cacheado).
  if ((await moduleWall("planes")) !== "ok") return null;
  const [services, caps] = await Promise.all([listServices(), getCapabilities()]);
  const disciplines = availableDisciplines(services);
  const discipline = resolveDisciplineTab(params.discipline, disciplines);
  if (!discipline) notFound();

  const res = await listPlans({ discipline });
  return (
    <PlanesClient
      discipline={discipline}
      disciplines={disciplines}
      rows={res.ok ? res.data.rows : []}
      truncated={res.ok ? res.data.truncated : false}
      error={res.ok ? null : res.error}
      filter={parsePlanesFilter(searchParams[PLANES_FILTER_PARAM])}
      capabilities={[...caps]}
      canEditServices={caps.has("tenant.admin")}
    />
  );
}
