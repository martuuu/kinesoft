import { displayMemberName } from "@/lib/display-name";
import { redirect } from "next/navigation";
import { listPractitioners } from "@/lib/bookings";
import { listSalaBookings } from "@/lib/sala-bookings";
import { listRoomOptions } from "@/lib/rooms";
import { listLocations } from "@/lib/locations";
import { getActor } from "@/lib/session";
import { getCapabilities } from "@/lib/authz";
import { getUserPreferences } from "@/lib/preferences";
import { DEFAULT_AGENDA_VIEW_PREFS } from "@/lib/preferences-constants";
import { toARDateKey } from "@/lib/datetime-ar";
import { dayWindow } from "@/lib/availability/day";
import { practitionerInitials } from "@/lib/agenda-layout";
import { deskViewer } from "@/lib/reception-desk-state";
import { SalaClient } from "@/components/sala/sala-client";
import { logger } from "@/lib/logger";
import { moduleWall } from "@/lib/module-wall";
import { mpConnectMode } from "@/lib/env";

export const metadata = { title: "Sala de espera" };
export const dynamic = "force-dynamic";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * /sala (SV10a, plan §18.5): tablero operativo de la sala de espera, SOLO HOY
 * (día AR, SV-D8: sin navegación de fecha). Lo comparten la Secretaria y los
 * profesionales en vivo (`useRealtime` en `SalaClient`).
 *
 * - Capability `agenda.reception`; sin ella (BILLING) → /agenda. El módulo lo
 *   chequea el layout.
 * - Turnos: `listSalaBookings` del día AR entero (FX2a), sin filtro de sede ni
 *   profesional (el loader ya recorta a lo que el actor puede ver), sin
 *   cancelados (no tienen card). La MISMA action re-pide el cliente.
 * - PD-13: esa action proyecta en el server (`toSalaWire`): título,
 *   descripción, notas, condición y título del plan no viajan ni en el payload
 *   RSC ni en los re-pedidos.
 * - Salas, prefs y profesionales fallan sueltas como en la agenda: sin salas
 *   el tablero es por profesional; sin prefs, el default.
 * - RX-1a: `initialLayout` (`agendaPrefs.receptionLayout`) elige la cara
 *   (Tablero, Lista y panel o Flujo) cuando no hay provider de Apariencia, y
 *   el viewer suma `canCollect`/`canCollectAll` (`billing.collect` / `billing.collectOwn`, T3 C-AS2; antes era
 *   `billing.manage`) para el cobro del escritorio; fila por fila decide `canCollectRow`, la regla del server.
 * - CF2 (D-CF2-5): sedes activas + `agendaPrefs.locationId` (la sede de la agenda). El filtro es de CLIENTE (con ≥2
 *   sedes, `SalaClient` recorta lo que ven las caras): el loader sigue trayendo el día entero, así cambiar de sede no
 *   re-pide y el realtime no cambia. `listLocations` exige `agenda.viewAll` (como la agenda: sin ese permiso no hay
 *   sedes); sin él ni se llama, en vez de tirar y ensuciar el log en cada visita del profesional.
 */
export default async function SalaPage() {
  // VX-Z: Next renderiza el layout y la página EN PARALELO. Sin el módulo, el layout muestra el muro (o redirige),
  // pero la página igual corría `listSalaBookings`, que tira `ForbiddenError` (`assertModule`) y ensuciaba el log en
  // cada visita al muro. Mismo veredicto que el layout (el actor está cacheado por request): si no es "ok", nada.
  if ((await moduleWall("salaEspera")) !== "ok") return null;
  const [actor, caps] = await Promise.all([getActor(), getCapabilities()]);
  if (!caps.has("agenda.reception")) redirect("/agenda");

  const dayKey = toARDateKey(new Date());
  const { start, end } = dayWindow(dayKey);

  const roomsP = listRoomOptions().catch((e) => {
    logger.warn("sala.bootstrap.listRoomOptions_failed", { err: errMsg(e) });
    return [];
  });
  const prefsP = getUserPreferences()
    .then((p) => p.agendaView)
    .catch((e) => {
      logger.warn("sala.bootstrap.getUserPreferences_failed", { err: errMsg(e) });
      return { ...DEFAULT_AGENDA_VIEW_PREFS };
    });

  const locationsP = caps.has("agenda.viewAll")
    ? listLocations().catch((e) => {
        logger.warn("sala.bootstrap.listLocations_failed", { err: errMsg(e) });
        return [];
      })
    : Promise.resolve([]);

  const [bookings, practitioners, rooms, prefs, locations] = await Promise.all([
    listSalaBookings({ from: start, to: end }),
    listPractitioners(),
    roomsP,
    prefsP,
    locationsP,
  ]);

  return (
    <SalaClient
      dayKey={dayKey}
      initialNow={new Date().toISOString()}
      initialRows={bookings}
      practitioners={practitioners.map((p) => {
        const name = displayMemberName(p.user.fullName);
        return { id: p.id, name, initials: practitionerInitials(name) };
      })}
      rooms={rooms.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity, locationId: r.locationId }))}
      locations={locations.map((l) => ({ id: l.id, name: l.name, isPrimary: l.isPrimary }))}
      initialLocationId={prefs.locationId}
      // T5 (TP-3f1): «Enviar link de pago» solo con los cobros online prendidos (0 sentencias).
      viewer={deskViewer(actor.practitionerId ?? null, caps, mpConnectMode() !== "off")}
      initialGroupBy={prefs.salaGroupBy}
      initialLayout={prefs.receptionLayout}
      canReadClinical={caps.has("clinical.read")}
      // TV-2w2: «Pantallas» solo para quien opera toda la agenda y nunca en soporte (sesión de solo lectura, C-BO4):
      // las actions de pantallas lo vuelven a exigir; esto solo evita un botón que terminaría en «no autorizado».
      canManageDisplays={caps.has("agenda.operateAll") && !actor.support}
    />
  );
}
