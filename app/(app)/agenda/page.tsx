import { listBookingsInRange, listPractitioners, listServices } from "@/lib/bookings";
import { listPatients } from "@/lib/patients";
import { getTenantSettings } from "@/lib/tenant-settings";
import { AgendaClient } from "@/components/agenda/agenda-client";

export const metadata = { title: "Agenda · KineSoft" };
export const dynamic = "force-dynamic";

type SP = {
  date?: string;
  view?: "timeline" | "week" | "list";
  new?: string;
  patient?: string;
  practitioner?: string;
};

function parseDate(v?: string) {
  if (!v) return new Date();
  const d = new Date(v + "T00:00:00");
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

export default async function AgendaPage({ searchParams }: { searchParams: SP }) {
  const anchor = parseDate(searchParams.date);
  const view = searchParams.view ?? "timeline";
  const weekStart = startOfWeek(anchor);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const practitionerFilter = searchParams.practitioner ?? null;
  const [bookings, services, practitioners, patients, settings] = await Promise.all([
    listBookingsInRange({
      from: weekStart,
      to: weekEnd,
      practitionerId: practitionerFilter ?? undefined,
    }),
    listServices(),
    listPractitioners(),
    listPatients(),
    getTenantSettings(),
  ]);

  return (
    <AgendaClient
      view={view}
      anchorISO={anchor.toISOString()}
      weekStartISO={weekStart.toISOString()}
      autoCreate={searchParams.new === "1"}
      autoCreatePatientId={searchParams.patient ?? null}
      practitionerFilterId={practitionerFilter}
      bookings={bookings.map((b) => ({
        ...b,
        scheduledFor: b.scheduledFor.toISOString(),
      }))}
      services={services.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents }))}
      practitioners={practitioners.map((p) => ({
        id: p.id,
        name: p.user.fullName ?? p.user.email,
      }))}
      patients={patients.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}` }))}
      businessHours={{
        start: settings.businessHoursStart,
        end: settings.businessHoursEnd,
      }}
    />
  );
}
