import { redirect } from "next/navigation";
import { AccessWall } from "@/components/ui/access-wall";
import { moduleWall } from "@/lib/module-wall";

/**
 * Guard de módulo del segmento /sala (SV10a, plan §18.5): requiere
 * `salaEspera` (Clínica/Libre en las dos verticales, PL-D6). Un consultorio
 * Individual/Consultorio que llega por URL directa ve el muro del plan en vez de
 * un tablero que no puede usar. Sin actor es no-op: el layout padre `(app)` ya
 * manda a /login.
 *
 * El layout es UX, la barrera es la action: `markReceptionAction` exige
 * `agenda.reception` y `mintRealtimeToken` el módulo. La capability la chequea
 * la página (BILLING → /agenda).
 *
 * VX2-b2 (D-VX20): si un plan MAYOR trae el módulo en la vertical del consultorio, muro con upsell (`AccessWall`) en
 * vez del redirect; si ningún plan lo trae para la vertical, /dashboard como antes. El muro no abre nada.
 */
export default async function SalaLayout({ children }: { children: React.ReactNode }) {
  const wall = await moduleWall("salaEspera");
  if (wall === "redirect") redirect("/dashboard");
  if (wall !== "ok") return <AccessWall module="salaEspera" plan={wall.plan} canBuy={wall.canBuy} />;
  return <>{children}</>;
}
