import { redirect } from "next/navigation";
import { getCapabilities } from "@/lib/authz";
import { listServices } from "@/lib/bookings";
import { PlanesClient } from "@/components/planes/planes-client";
import { availableDisciplines, planesHref } from "@/components/planes/planes-model";

export const metadata = { title: "Planes · KineSoft" };
export const dynamic = "force-dynamic";

/**
 * `/planes` (S21, PD-11): una sola entrada "Planes" con pestañas por
 * disciplina. Lleva a la primera disciplina con servicio
 * (`/planes/kinesiologia` o `/planes/osteopatia`); sin ninguna, muestra el
 * estado vacío (cargar la disciplina en los servicios). El guard del módulo
 * `planes` vive en `layout.tsx` (EV0): no se duplica acá.
 */
export default async function PlanesIndexPage() {
  const [services, caps] = await Promise.all([listServices(), getCapabilities()]);
  const disciplines = availableDisciplines(services);
  if (disciplines.length > 0) redirect(planesHref(disciplines[0]));
  return (
    <PlanesClient
      discipline={null}
      disciplines={[]}
      rows={[]}
      truncated={false}
      error={null}
      filter="all"
      capabilities={[...caps]}
      canEditServices={caps.has("tenant.admin")}
    />
  );
}
