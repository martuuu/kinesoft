import { guardModuleSegment } from "@/lib/authz";

/**
 * Guard de módulo del segmento /sala (SV10a, plan §18.5): requiere
 * `salaEspera`. Un consultorio sin el módulo que llega por URL directa termina
 * en /dashboard en vez de ver un tablero que no puede usar. Sin actor es no-op:
 * el layout padre `(app)` ya manda a /login.
 *
 * El layout es UX, la barrera es la action: `markReceptionAction` exige
 * `agenda.reception` y `mintRealtimeToken` el módulo. La capability la chequea
 * la página (BILLING → /agenda).
 */
export default async function SalaLayout({ children }: { children: React.ReactNode }) {
  await guardModuleSegment("salaEspera");
  return <>{children}</>;
}
