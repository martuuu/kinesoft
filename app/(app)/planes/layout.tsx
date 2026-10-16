import { redirect } from "next/navigation";
import { AccessWall } from "@/components/ui/access-wall";
import { moduleWall } from "@/lib/module-wall";

/**
 * Guard de módulo del segmento /planes (S21, enmienda EV0): requiere `planes`.
 * Cubre también /planes/[discipline]. Un consultorio General (o un plan SaaS
 * sin el módulo) que llega por URL directa termina en /dashboard. Sin actor es
 * no-op: el layout padre `(app)` ya manda a /login.
 *
 * El layout es UX, la barrera es la action: en el App Router un layout no se
 * re-ejecuta en cada navegación y las server actions se invocan sin pasar por
 * él, así que `listPlans` y compañía chequean el módulo por su cuenta.
 *
 * VX2-b2 (D-VX20): si un plan MAYOR trae el módulo en la vertical del consultorio, muro con upsell (`AccessWall`) en
 * vez del redirect; si ningún plan lo trae para la vertical, /dashboard como antes. El muro no abre nada.
 */
export default async function PlanesLayout({ children }: { children: React.ReactNode }) {
  const wall = await moduleWall("planes");
  if (wall === "redirect") redirect("/dashboard");
  if (wall !== "ok") return <AccessWall module="planes" plan={wall.plan} canBuy={wall.canBuy} />;
  return <>{children}</>;
}
