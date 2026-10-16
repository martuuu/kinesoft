import { redirect } from "next/navigation";
import { AccessWall } from "@/components/ui/access-wall";
import { moduleWall } from "@/lib/module-wall";

/**
 * Guard de módulo del segmento /seguimiento (EV0, plan §15.4): requiere `sesiones`.
 * Cubre también /seguimiento/[sessionId].
 * Un consultorio de vertical General (o un plan que no incluya el módulo) que
 * llega por URL directa termina en /dashboard en vez de ver una pantalla que no
 * puede usar. Sin actor es no-op: el layout padre `(app)` ya manda a /login.
 *
 * El layout es UX, la barrera es la action: en el App Router un layout no se
 * re-ejecuta en cada navegación y las server actions se invocan sin pasar por
 * él, así que cada action del módulo chequea `assertModule`/`requireModule`.
 *
 * VX2-b2 (D-VX20): si un plan MAYOR trae el módulo en la vertical del consultorio, muro con upsell (`AccessWall`) en
 * vez del redirect; si ningún plan lo trae para la vertical, /dashboard como antes. El muro no abre nada.
 */
export default async function SeguimientoLayout({ children }: { children: React.ReactNode }) {
  const wall = await moduleWall("sesiones");
  if (wall === "redirect") redirect("/dashboard");
  if (wall !== "ok") return <AccessWall module="sesiones" plan={wall.plan} canBuy={wall.canBuy} />;
  return <>{children}</>;
}
