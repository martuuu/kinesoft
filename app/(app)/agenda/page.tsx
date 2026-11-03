import { getActor } from "@/lib/session";
import { toARDateKey } from "@/lib/datetime-ar";
import { practitionerInitials, practitionerOrder } from "@/lib/agenda-layout";
import {
  dayViewFor,
  effectiveRoomFilter,
  initialPractitionerSelection,
  monthGridRange,
  parseDayKeyParam,
  resolveAgendaView,
  roomsInScope,
  weekStartKey,
} from "@/lib/agenda-client-state";
import { waitingRoomEnabled } from "@/lib/tenant-modules";
import { loadAgendaPage } from "@/lib/agenda-page-loader";
import { AgendaFromWire } from "./agenda-from-wire";

export const metadata = { title: "Agenda" };
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
  /** T3e-2o: filtro por obra social (id del catálogo o `particular`). */
  os?: string;
  /** [CF2-AG1] Turno a abrir en el drawer (link «Ver turno» de /sala); la agenda lo abre y lo saca de la URL. */
  open?: string;
};

export default async function AgendaPage({ searchParams }: { searchParams: SP }) {
  // B4.3: el día y la semana se calculan como DayKeys AR (`lib/availability/day`),
  // no con `setDate`/`getDay` del host. `?date=` inválido → hoy AR (antes un
  // `new Date()` del host, que en Vercel a las 22:00 AR ya es "mañana" UTC; el
  // `toARDateKey` lo corregía, acá queda explícito).
  const dayKey = parseDayKeyParam(searchParams.date, toARDateKey(new Date()));
  const monday = weekStartKey(dayKey);
  // CF2 (D-CF2-7, brief A.4/A.5): en Mes el loader NO lee los turnos ni la disponibilidad de la semana y en su lugar
  // trae el resumen de la grilla del mes (lunes a domingo, ≤ 42 días): ≤ 2 tx en total.
  const monthRange = searchParams.view === "month" ? monthGridRange(dayKey) : null;

  // PF2-c (C-PF8): ≤ 3 tx (turnos, bootstrap en una, disponibilidad) y sin el directorio de pacientes; el detalle,
  // las fallas sueltas y el cable compacto de los turnos están en `lib/agenda-page-loader.ts`.
  const actor = await getActor();
  let data = await loadAgendaPage(actor, { monday, patientId: searchParams.patient ?? null, monthRange });
  // CF2 (A-K): el Mes es de `agenda.viewAll` (la puerta de `getAgendaMonthSummary`; hoy la tienen todos los roles con
  // membresía). Sin ella `?view=month` cae al Día y el loader, que con `monthRange` no leyó la semana, devolvió los
  // turnos vacíos: se vuelve a pedir la semana como siempre. Se decide con las capabilities que ya trae el loader (sin
  // query) y no antes: el camino normal no paga un await más. El pedido doble solo pasa con un link a Mes de alguien sin
  // la capability.
  const canMonth = data.capabilities.includes("agenda.viewAll");
  if (monthRange && !canMonth) {
    data = await loadAgendaPage(actor, { monday, patientId: searchParams.patient ?? null });
  }
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
    onlineMoney,
    whatsapp,
    month,
  } = data;

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
  const resolvedView = resolveAgendaView(searchParams.view, {
    mode: agendaPrefs.mode,
    practitionerCount: practitioners.length,
    // PL-2f (PL-D6): la vista Recepción es de la Sala de Espera (Clínica / Libre). Sin el módulo, `?view=reception`
    // cae al Día. «Llegó», «En atención» y «Deshacer» (todos los planes, D-HF1) se marcan desde el drawer del turno
    // (HF-2c, `booking-drawer/reception-actions.tsx`); las tarjetas solo muestran el estado. Antes este comentario
    // decía que ya estaban en el drawer y las tarjetas, y no era cierto: Individual y Consultorio no tenían dónde
    // marcar la llegada (H-LL1).
    canReception: capabilities.includes("agenda.reception") && waitingRoomEnabled(actor.entitlements),
    roomCount: scopeRooms.length,
  });
  const view =
    resolvedView === "month" && !canMonth
      ? dayViewFor(agendaPrefs.mode, practitioners.length, scopeRooms.length)
      : resolvedView;
  // [CF2-AG1] D-CF2-1: selección inicial URL > guardada > rol (`initialPractitionerSelection`). Se resuelve ACÁ y no en
  // el cliente: el server no ve `window.location` y el primer render del cliente tiene que dar lo mismo que el HTML
  // (si no, los chips y la grilla saltan al hidratar). `source` le dice a la agenda si tiene que escribir `?pros=` (vino
  // de la guardada o del rol) para que un refresh o un link copiado muestren lo mismo. La guardada va cruda (sin el
  // filtro de favoritos de arriba): la función ya descarta los ids que no existen y distingue `[]` de «nunca eligió».
  const selection = initialPractitionerSelection({
    url: { pros: searchParams.pros, practitioner: searchParams.practitioner },
    saved: rawPrefs.selectedPractitionerIds,
    // `?? null` explícito (guard [IAM-4a]): null = el actor no atiende → nunca «su agenda» por defecto, cae a Todos.
    ownPractitionerId: actor.practitionerId ?? null,
    validIds: practitionerIds,
  });

  return (
    <AgendaFromWire
      view={view}
      dayKey={dayKey}
      weekStartKey={monday}
      autoCreate={searchParams.new === "1"}
      initialInsurerFilter={searchParams.os ?? null}
      autoCreatePatientId={searchParams.patient ?? null}
      initialSelectedIds={selection.ids}
      initialSelectionSource={selection.source}
      openBookingId={searchParams.open ?? null}
      // CF2 (A.4): el resumen del Mes (null fuera de Mes, o si falló: `MonthView` lo pide sola).
      initialMonth={view === "month" ? month : null}
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
      // T5 (TP-3z): `mpConnectMode() !== "off"` resuelto en el loader sin sentencias (`agendaOnlineMoneyFor`); el
      // drawer ofrece «Generar link de pago» solo si el consultorio cobra online.
      onlineMoney={onlineMoney.enabled}
      // WA-S7/WA-U2: el consultorio manda WhatsApp (modo ≠ off y cuenta ACTIVE de ese modo, cacheada: 0 sentencias en
      // caliente). Solo con esto el drawer baja y monta la sección WhatsApp (`import()`); el badge de la card sale del
      // cable (`rp`).
      whatsapp={whatsapp}
    />
  );
}
