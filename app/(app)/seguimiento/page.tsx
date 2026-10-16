import { listOpenSessions } from "@/lib/sessions";
import { getActor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";
import { SeguimientoLanding } from "@/components/seguimiento/seguimiento-landing";
import { moduleWall } from "@/lib/module-wall";

export const metadata = { title: "Seguimiento · KineSoft" };
export const dynamic = "force-dynamic";

/**
 * Los buckets (y el corte del día AR) los arma el servidor: acá solo se
 * renderizan (`SeguimientoLanding`). El guard del módulo `sesiones` vive en
 * `layout.tsx` (EV0): no se duplica acá.
 */
export default async function SeguimientoPage() {
  // VX-Z (B1): el layout y la página se renderizan EN PARALELO; sin el módulo, el layout muestra el muro o redirige,
  // pero la página igual corría sus queries (y `assertModule` tiraba). Mismo veredicto que el layout (actor cacheado).
  if ((await moduleWall("sesiones")) !== "ok") return null;
  const [buckets, actor] = await Promise.all([listOpenSessions(), getActor()]);
  return <SeguimientoLanding buckets={buckets} plansEnabled={modulesFor(actor.entitlements).has("planes")} />;
}
