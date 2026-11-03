import { redirect } from "next/navigation";
import { getActor } from "@/lib/session";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { loadCajaPage } from "@/lib/caja-internal";
import { moduleWall } from "@/lib/module-wall";
import { CajaView } from "@/components/caja/caja-view";

export const metadata = { title: "Caja" };
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

/**
 * /caja (CF2 · P.2, plan §29 D-CF2-16/17): lo cobrado por profesional, Día/Mes por URL (`?vista=dia|mes&fecha=…&mes=…`).
 *
 * - Caps del MIEMBRO (`memberCapabilitiesForActor`): al soporte ya le saca `billing.*`, así que cae en `none`.
 * - `loadCajaPage` resuelve el scope (`tenant` / `desk` / `own` / `none`), el período (la Secretaria siempre hoy, diga
 *   lo que diga la URL) y devuelve el payload YA proyectado: un profesional nunca recibe el bruto de otro.
 * - `none` (`null`) → /dashboard: sin ninguna capability de cobro no hay caja que mostrar.
 * - Sin action nueva: la navegación son links y un form GET.
 * - VX-Z B1: el layout y la página corren en paralelo; sin este corte la página leería la caja mientras se ve el muro.
 */
export default async function CajaPage({ searchParams }: { searchParams?: SP }) {
  if ((await moduleWall("facturacion")) !== "ok") return null;
  const actor = await getActor();
  const data = await loadCajaPage(actor, await memberCapabilitiesForActor(actor), searchParams ?? {});
  if (!data) redirect("/dashboard");
  return <CajaView data={data} />;
}
