import { getActor } from "@/lib/session";
import { toARDateKey } from "@/lib/datetime-ar";
import { practitionerInitials, practitionerOrder } from "@/lib/agenda-layout";
import {
  effectiveRoomFilter,
  parseDayKeyParam,
  parseSelectedPractitioners,
  resolveAgendaView,
  roomsInScope,
  weekStartKey,
} from "@/lib/agenda-client-state";
import { waitingRoomEnabled } from "@/lib/tenant-modules";
import { loadAgendaPage } from "@/lib/agenda-page-loader";
import { AgendaFromWire } from "./agenda-from-wire";

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

export default async function AgendaPage({ searchParams }: { searchParams: SP }) {
  // B4.3: el día y la semana se calculan como DayKeys AR (`lib/availability/day`),
  // no con `setDate`/`getDay` del host. `?date=` inválido → hoy AR (antes un
  // `new Date()` del host, que en Vercel a las 22:00 AR ya es "mañana" UTC; el
  // `toARDateKey` lo corregía, acá queda explícito).
  const dayKey = parseDayKeyParam(searchParams.date, toARDateKey(new Date()));
  const monday = weekStartKey(dayKey);

  // PF2-c (C-PF8): ≤ 3 tx (turnos, bootstrap en una, disponibilidad) y sin el directorio de pacientes; el detalle,
  // las fallas sueltas y el cable compacto de los turnos están en `lib/agenda-page-loader.ts`.
  const actor = await getActor();
  const {
    bookings,
    services,
    practitioners,
    patients,
    insurers,
    businessHours,
    locations,
    rooms,
    agendaView: rawPrefs,
    capabilities,
    availability,
  } = await loadAgendaPage(actor, { monday, patientId: searchParams.patient ?? null });

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
    <AgendaFromWire
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
      // PF2-c: cable compacto (`lib/agenda-wire.ts`); `AgendaFromWire` lo devuelve a `BookingDTO` con `services` y
      // `locations` de acá abajo, que son el catálogo con el que se codificó.
      wireBookings={bookings}
      // `discipline` (P3-C, C9): el cliente resuelve `serviceDiscipline` de cada
      // turno desde acá; ya no viaja por turno (DTO compacto, `toBookingDTO`).
      services={services}
      practitioners={practitioners}
      practitionerBadges={practitionerOrder(
        practitioners.map((p) => ({ ...p, initials: practitionerInitials(p.name) })),
        agendaPrefs
      )}
      // PF2-c: solo el paciente del deep-link (`?patient=`); el picker busca en el server.
      patients={patients}
      insurers={insurers}
      businessHours={businessHours}
      locations={locations}
      agendaPrefs={agendaPrefs}
      rooms={rooms}
      initialAvailability={availability}
      capabilities={capabilities}
    />
  );
}
