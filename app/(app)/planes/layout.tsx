import { guardModuleSegment } from "@/lib/authz";

/**
 * Guard de módulo del segmento /planes (S21, enmienda EV0): requiere `planes`.
 * Cubre también /planes/[discipline]. Un consultorio General (o un plan SaaS
 * sin el módulo) que llega por URL directa termina en /dashboard. Sin actor es
 * no-op: el layout padre `(app)` ya manda a /login.
 *
 * El layout es UX, la barrera es la action: en el App Router un layout no se
 * re-ejecuta en cada navegación y las server actions se invocan sin pasar por
 * él, así que `listPlans` y compañía chequean el módulo por su cuenta.
 */
export default async function PlanesLayout({ children }: { children: React.ReactNode }) {
  await guardModuleSegment("planes");
  return <>{children}</>;
}
