import "server-only";
import { env } from "@/lib/env";
import { getMembershipRole } from "@/lib/authz";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import type { Actor } from "@/lib/session";
import type { RealtimeBootstrap } from "@/lib/realtime-events";

/**
 * Bootstrap client-safe del canal realtime (SV04b; plan §18.2). Lo arma el layout
 * `(app)` y lo recibe el `RealtimeProvider` (SV07b): dice qué driver usar y, solo con
 * `supabase`, la URL y la anon key PÚBLICAS (las mismas `NEXT_PUBLIC_*` que ya viajan
 * en el bundle). Nunca lleva `SUPABASE_JWT_SECRET` ni la service key: el token del
 * canal lo pide el cliente aparte con `mintRealtimeToken()`.
 *
 * Quién usa realtime: el módulo `salaEspera` + la capability `agenda.reception`.
 * DESVÍO de §18.2 (que dice `agenda.viewAll || agenda.reception`): BILLING tiene
 * `agenda.viewAll` (`lib/capabilities.ts`, matriz BILLING), así que el OR la dejaría
 * pasar, y §18.8 fila SV04b exige BILLING → `{ok:false}`. Todo rol con `viewAll`
 * salvo BILLING tiene también `reception`, así que exigir `reception` es el OR del
 * plan menos BILLING, que es lo conservador. BILLING sigue viendo la agenda por el
 * polling de 60 s.
 *
 * BO2-E: el soporte (`actor.support`) nunca: `SUPPORT_CAPS` trae `agenda.reception` (es la Secretaria), pero un
 * canal en vivo de la sala de espera (nombres de pacientes llegando) no hace falta para mirar el consultorio y
 * deja un JWT de canal en manos de alguien sin membresía. Como `mintRealtimeToken` usa esta misma función, el
 * rechazo vale para el token y para el bootstrap del layout. Soporte ve la agenda por polling.
 */
export function realtimeAllowed(actor: Actor, caps: ReadonlySet<Capability>): boolean {
  return !actor.support && modulesFor(actor.entitlements).has("salaEspera") && caps.has("agenda.reception");
}

export async function realtimeBootstrap(
  actor: Actor,
  caps?: ReadonlySet<Capability>
): Promise<RealtimeBootstrap> {
  const off: RealtimeBootstrap = { driver: "off", tenantId: actor.tenantId };
  if (env.REALTIME_DRIVER === "off") return off;
  const c = caps ?? capabilitiesFor(await getMembershipRole(actor));
  if (!realtimeAllowed(actor, c)) return off;
  if (env.REALTIME_DRIVER === "local") return { driver: "local", tenantId: actor.tenantId };
  // supabase: sin URL/anon el cliente no tiene adónde conectarse, y sin secreto
  // `mintRealtimeToken` siempre falla → reintentos en loop. `off` (polling) es mejor.
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !env.SUPABASE_JWT_SECRET) return off;
  return { driver: "supabase", tenantId: actor.tenantId, url, anonKey };
}
