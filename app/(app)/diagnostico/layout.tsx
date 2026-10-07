import { guardModuleSegment } from "@/lib/authz";

/**
 * Guard de módulo del segmento /diagnostico (EV0, plan §15.4): requiere `diagnostico`.
 * Un consultorio de vertical General (o un plan que no incluya el módulo) que
 * llega por URL directa termina en /dashboard en vez de ver una pantalla que no
 * puede usar. Sin actor es no-op: el layout padre `(app)` ya manda a /login.
 *
 * El layout es UX, la barrera es la action: en el App Router un layout no se
 * re-ejecuta en cada navegación y las server actions se invocan sin pasar por
 * él, así que cada action del módulo chequea `assertModule`/`requireModule`.
 */
export default async function DiagnosticoLayout({ children }: { children: React.ReactNode }) {
  await guardModuleSegment("diagnostico");
  return <>{children}</>;
}
