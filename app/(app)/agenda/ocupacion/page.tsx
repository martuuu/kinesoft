import { getActor } from "@/lib/session";
import { parseOccupancyParams } from "@/lib/agenda-occupancy";
import { loadAgendaOccupancy } from "@/lib/agenda-occupancy-internal";
import { PageHeader } from "@/components/ui/page-header";
import { ButtonLink } from "@/components/ui/button";
import { OccupancyView } from "@/components/agenda/occupancy/occupancy-view";

/**
 * [AS-3h] Agenda → Ocupación (plan §23.9). Ruta propia (no una vista de /agenda) para que no sume al first load de la
 * agenda: server, sin JS propio. Agenda es núcleo (todos los planes y verticales): no hay muro de módulo
 * (`moduleWall`) que cortar acá. El scope lo decide `loadAgendaOccupancy` con las capabilities del actor; `?pro=` es
 * un pedido, nunca la barrera.
 */
export const metadata = { title: "Ocupación · Agenda" };
export const dynamic = "force-dynamic";

type SP = { tab?: string | string[]; semanas?: string | string[]; pro?: string | string[] };

export default async function AgendaOccupancyPage({ searchParams }: { searchParams: SP }) {
  const actor = await getActor();
  const data = await loadAgendaOccupancy(actor, parseOccupancyParams(searchParams));
  return (
    <>
      <PageHeader
        eyebrow="Agenda"
        title="Ocupación"
        description={
          data.scope.kind === "team"
            ? "Cuántos turnos hubo y cuántos hay dados, por día y hora de inicio."
            : "Cuántos turnos tuviste y cuántos tenés dados, por día y hora de inicio."
        }
        actions={
          <ButtonLink href="/agenda" variant="ghost">
            Volver a la agenda
          </ButtonLink>
        }
      />
      <OccupancyView data={data} />
    </>
  );
}
