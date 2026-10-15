import { guardModuleSegment } from "@/lib/authz";

/**
 * Guard de módulo del segmento /reportes (EV0, plan §15.4): requiere `reportes`.
 * Reportes va con Kine y no con General (EV-D3).
 * Un consultorio de vertical General (o un plan que no incluya el módulo) que
 * llega por URL directa termina en /dashboard en vez de ver una pantalla que no
 * puede usar. Sin actor es no-op: el layout padre `(app)` ya manda a /login.
 *
 * El layout es UX, la barrera es la action: en el App Router un layout no se
 * re-ejecuta en cada navegación y las server actions se invocan sin pasar por
 * él, así que cada action del módulo chequea `assertModule`/`requireModule`.
 *
 * PL-F1c: la página ahora redirige siempre a /dashboard; el guard queda igual (los dos destinos coinciden).
 */
export default async function ReportesLayout({ children }: { children: React.ReactNode }) {
  await guardModuleSegment("reportes");
  return <>{children}</>;
}
