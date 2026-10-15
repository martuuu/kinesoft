import { displayMemberName } from "@/lib/display-name";
import { listAgendaBookings, listPractitioners, listServices } from "@/lib/bookings";
import { listPatients } from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { getTenantSettings } from "@/lib/tenant-settings";
import { AgendaClient } from "@/components/agenda/agenda-client";
import { toBookingDTO } from "@/components/agenda/agenda-utils";
import { getActor } from "@/lib/session";
import { getCapabilities } from "@/lib/authz";
import { toARDateKey } from "@/lib/datetime-ar";
import { listLocations } from "@/lib/locations";
import { listRoomOptions } from "@/lib/rooms";
import { getAgendaAvailability } from "@/lib/availability-actions";
import { getUserPreferences } from "@/lib/preferences";
import { DEFAULT_AGENDA_VIEW_PREFS } from "@/lib/preferences-constants";
import { addDays, dayWindow } from "@/lib/availability/day";
import { practitionerInitials, practitionerOrder } from "@/lib/agenda-layout";
import {
  effectiveRoomFilter,
  parseDayKeyParam,
  parseSelectedPractitioners,
  resolveAgendaView,
  roomsInScope,
  weekStartKey,
} from "@/lib/agenda-client-state";
import { logger } from "@/lib/logger";
import { waitingRoomEnabled } from "@/lib/tenant-modules";

export const metadata = { title: "Agenda · KineSoft" };
export const dynamic = "force-dynamic";

type SP = {
  date?: string;
  view?: string;
  new?: string;
  patient?: string;
  /** Filtro viejo de un profesional (links guardados); hoy siembra los chips. */
  practitioner?: string;
  /** B4.3: profesionales elegidos en los chips, separados por coma (vacío = todos). */
  pros?: string;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default async function AgendaPage({ searchParams }: { searchParams: SP }) {
  // B4.3: el día y la semana se calculan como DayKeys AR (`lib/availability/day`),
  // no con `setDate`/`getDay` del host. `?date=` inválido → hoy AR (antes un
  // `new Date()` del host, que en Vercel a las 22:00 AR ya es "mañana" UTC; el
  // `toARDateKey` lo corregía, acá queda explícito).
  const dayKey = parseDayKeyParam(searchParams.date, toARDateKey(new Date()));
  const monday = weekStartKey(dayKey);
  const sunday = addDays(monday, 6);
  const weekStart = dayWindow(monday).start;
  const weekEnd = dayWindow(sunday).end;

  // Las cargas nuevas de B-pre (sedes, prefs de agenda, disponibilidad,
  // capabilities) fallan SUELTAS (catch → vacío/default/null): la agenda de hoy
  // no depende de ellas y no puede dejar de abrir porque, p. ej., un tenant
  // viejo no tenga sede principal.
  const locationsP = listLocations().catch((e) => {
    logger.warn("agenda.bootstrap.listLocations_failed", { err: errMsg(e) });
    return [];
  });
  // SR: catálogo de salas (activas de sedes activas). Una sentencia aparte,
  // fuera de `listAgendaBookings` (su presupuesto de statements no se mueve).
  // Falla suelta como las sedes: sin catálogo, la agenda de antes de SR.
  const roomsP = listRoomOptions().catch((e) => {
    logger.warn("agenda.bootstrap.listRoomOptions_failed", { err: errMsg(e) });
    return [];
  });
  const prefsP = getUserPreferences()
    .then((p) => p.agendaView)
    .catch((e) => {
      logger.warn("agenda.bootstrap.getUserPreferences_failed", { err: errMsg(e) });
      return { ...DEFAULT_AGENDA_VIEW_PREFS };
    });
  const capsP = getCapabilities()
    .then((c) => [...c] as string[])
    .catch((e) => {
      logger.warn("agenda.bootstrap.getCapabilities_failed", { err: errMsg(e) });
      return [] as string[];
    });
  // La disponibilidad depende de la sede guardada: arranca apenas están las
  // prefs y las sedes, en paralelo con los turnos. Sede guardada que ya no
  // existe (archivada) → todas.
  const availabilityP = Promise.all([prefsP, locationsP]).then(async ([prefs, locations]) => {
    const locationId = locations.some((l) => l.id === prefs.locationId) ? prefs.locationId : null;
    try {
      const res = await getAgendaAvailability({ from: monday, to: sunday, locationId });
      if (!res.ok) {
        logger.warn("agenda.bootstrap.getAgendaAvailability_failed", { err: res.error });
        return null;
      }
      return res.data;
    } catch (e) {
      logger.warn("agenda.bootstrap.getAgendaAvailability_failed", { err: errMsg(e) });
      return null;
    }
  });

  const [actor, bookings, services, practitioners, patients, insurers, settings] = await Promise.all([
    getActor(),
    // Proyección liviana (B4.1): todos los profesionales y sedes de la semana.
    // Los chips y la sede filtran en el cliente: cambiar de profesional no
    // vuelve al server y los chips muestran el conteo de todos.
    listAgendaBookings({ from: weekStart, to: weekEnd }),
    listServices(),
    listPractitioners(),
    listPatients(),
    listInsurers({ onlyActive: true }),
    getTenantSettings(),
  ]);
  const [locations, rawPrefs, capabilities, availability, rooms] = await Promise.all([
    locationsP,
    prefsP,
    capsP,
    availabilityP,
    roomsP,
  ]);

  // Preferencias contra lo que existe hoy: un favorito dado de baja o una sede
  // archivada no se arrastran (el JSON se guardó en otro momento).
  const practitionerIds = practitioners.map((p) => p.id);
  const { roomId: rawRoomId, ...prefsNoRoom } = rawPrefs;
  const locationId = locations.some((l) => l.id === rawPrefs.locationId) ? rawPrefs.locationId : null;
  // SR-U3 (D3/D4): salas visibles en la sede elegida ("Todas" = la principal) y
  // una sala guardada que ya no está ahí (archivada, de otra sede, menos de 2)
  // no se arrastra. Sin sala válida la clave se omite (blob de antes de SR).
  const primaryLocationId = locations.find((l) => l.isPrimary)?.id ?? null;
  const scopeRooms = roomsInScope(rooms, locationId, primaryLocationId);
  const roomId = effectiveRoomFilter(rawRoomId, scopeRooms);
  const agendaPrefs = {
    ...prefsNoRoom,
    favoritePractitionerIds: rawPrefs.favoritePractitionerIds.filter((id) => practitionerIds.includes(id)),
    locationId,
    ...(roomId != null ? { roomId } : {}),
  };
  const view = resolveAgendaView(searchParams.view, {
    mode: agendaPrefs.mode,
    practitionerCount: practitioners.length,
    // PL-2f (PL-D6): la vista Recepción es de la Sala de Espera (Clínica / Libre). Sin el módulo, `?view=reception`
    // cae al Día; «Llegó» y «En atención» siguen en el drawer y las tarjetas.
    canReception: capabilities.includes("agenda.reception") && waitingRoomEnabled(actor.entitlements),
    roomCount: scopeRooms.length,
  });

  return (
    <AgendaClient
      view={view}
      dayKey={dayKey}
      weekStartKey={monday}
      autoCreate={searchParams.new === "1"}
      autoCreatePatientId={searchParams.patient ?? null}
      initialSelectedIds={parseSelectedPractitioners(
        { pros: searchParams.pros, practitioner: searchParams.practitioner },
        practitionerIds
      )}
      viewer={{ userId: actor.userId, practitionerId: actor.practitionerId }}
      bookings={bookings.map(toBookingDTO)}
      // `discipline` (P3-C, C9): el cliente resuelve `serviceDiscipline` de cada
      // turno desde acá; ya no viaja por turno (DTO compacto, `toBookingDTO`).
      services={services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents, color: s.color, discipline: s.discipline }))}
      practitioners={practitioners.map((p) => ({
        id: p.id,
        name: displayMemberName(p.user.fullName),
      }))}
      practitionerBadges={practitionerOrder(
        practitioners.map((p) => {
          const name = displayMemberName(p.user.fullName);
          return { id: p.id, name, initials: practitionerInitials(name) };
        }),
        agendaPrefs
      )}
      patients={patients.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}` }))}
      insurers={insurers.filter((i) => !i.isParticular).map((i) => ({ id: i.id, name: i.name }))}
      businessHours={{
        start: settings.businessHoursStart,
        end: settings.businessHoursEnd,
        slotMinutes: settings.agendaSlotMinutes,
      }}
      locations={locations.map((l) => ({ id: l.id, name: l.name, isPrimary: l.isPrimary }))}
      agendaPrefs={agendaPrefs}
      rooms={rooms}
      initialAvailability={availability}
      capabilities={capabilities}
    />
  );
}
