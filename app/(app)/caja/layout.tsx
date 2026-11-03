import { redirect } from "next/navigation";
import { AccessWall } from "@/components/ui/access-wall";
import { moduleWall } from "@/lib/module-wall";

/**
 * Guard de módulo del segmento /caja (CF2 · P.2, D-CF2-17): requiere `facturacion` (es CORE, así que en la práctica
 * solo frena si Plataforma lo deshabilitó a mano). Mismo molde que /reportes y /sala: sin actor es no-op (el layout
 * de `(app)` manda a /login); si un plan mayor trae el módulo, muro con upsell; si ninguno, /dashboard.
 *
 * El layout es UX: quién ve qué de la caja lo decide `loadCajaPage` por capabilities (`cajaScopeFor`), y la página
 * redirige el scope `none`.
 */
export default async function CajaLayout({ children }: { children: React.ReactNode }) {
  const wall = await moduleWall("facturacion");
  if (wall === "redirect") redirect("/dashboard");
  if (wall !== "ok") return <AccessWall module="facturacion" {...wall} />;
  return <>{children}</>;
}
