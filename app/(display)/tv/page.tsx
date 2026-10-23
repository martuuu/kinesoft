import { TvScreen } from "@/components/tv/tv-screen";
import { TvPairScreen, type PairState } from "@/components/tv/tv-pair-screen";
import { pairDisplay } from "@/lib/display-device";
import { displayRealtimeBootstrap, loadDisplayFeed, resolveDisplaySession } from "@/lib/display-device-internal";
import type { RealtimeBootstrap } from "@/lib/realtime-events";

/**
 * TV-2u1 (§26.4 C-TV): `/tv`. Sin Actor: la identidad es la cookie del dispositivo `kine_tv` (path `/tv`).
 *
 * - `force-dynamic`: cada request lee la cookie; una page cacheada le mostraría a una tele el feed de otra.
 * - Se resuelve la sesión con `resolveDisplaySession()` (cookie → hash → no revocada → acceso abierto → módulo
 *   `salaEspera`) y NO con la action `getDisplayFeed()`: la action lleva el rate limit de 30/min del polling y un render
 *   no tiene que gastarlo; además acá hace falta el `tenantId` para el bootstrap de Realtime, que el feed no expone.
 *   El render no escribe: `touchDisplaySeen` y la renovación de la cookie los hace el primer polling (15 s), que corre
 *   en una action (en un Server Component no se pueden setear cookies).
 * - Vinculada → `<TvScreen>` con el feed inicial ya resuelto en el server (la tele pinta la sala en el primer frame) y
 *   el bootstrap. Si el bootstrap falla, `null`: la tele sigue por polling (igual que con el driver `local`, TV-D13),
 *   mejor que una pantalla de error por un socket.
 * - `unpaired` / `revoked` / `unavailable` → `<TvPairScreen>` (con el motivo, salvo `unpaired`). Un error de base o
 *   de red se tira y lo agarra `error.tsx` («Reconectando…» y recarga a los 30 s).
 */
export const dynamic = "force-dynamic";

/**
 * Envuelve `pairDisplay({code})` con la firma `(prev, FormData)` que pide `useFormState`: así el form funciona sin JS
 * (POST nativo). El código va crudo (cortado al máximo del schema): el server normaliza y valida. Al vincular, la
 * action setea la cookie y Next re-renderiza esta page sola.
 */
async function pairFromForm(_prev: PairState, formData: FormData): Promise<PairState> {
  "use server";
  const raw = formData.get("code");
  return pairDisplay({ code: typeof raw === "string" ? raw.slice(0, 32) : "" });
}

export default async function TvPage() {
  const session = await resolveDisplaySession();
  if (session.state !== "paired") {
    return (
      <TvPairScreen action={pairFromForm} reason={session.state === "unpaired" ? undefined : session.state} />
    );
  }
  const [initialFeed, bootstrap] = await Promise.all([
    loadDisplayFeed(session, new Date()),
    displayRealtimeBootstrap(session.tenantId).catch((): RealtimeBootstrap | null => null),
  ]);
  return <TvScreen initialFeed={initialFeed} bootstrap={bootstrap} />;
}
