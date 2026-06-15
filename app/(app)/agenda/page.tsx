import { listBookingsInRange, listPractitioners, listServices } from "@/lib/bookings";
import { listPatients } from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { getTenantSettings } from "@/lib/tenant-settings";
import { AgendaClient } from "@/components/agenda/agenda-client";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";

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
  // Tag the YYYY-MM-DD as AR-local midnight (-03:00) before parsing.
  // Without the offset, `new Date("2026-06-04T00:00:00")` is read in the
  // host timezone: on UTC hosts (Vercel/Supabase) that instant is still
  // 2026-06-03 21:00 in AR, so `toARDateKey(anchor)` downstream returns
  // the *previous* day and the agenda shows the 3rd when you click the 4th.
  // Localhost (AR tz) happened to parse it correctly, hiding the bug.
  const d = new Date(localToARIso(`${v}T00:00:00`));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function startOfWeek(anchor: Date) {
  // Compute the Monday of `anchor`'s week IN ARGENTINA TIME. Doing the
  // math in host-local time (`setHours`/`getDay`) drifts the week start
  // by up to a full day on UTC hosts (Vercel/Docker) — the exact trap
  // `parseDate()` above warns about, which never got applied here. That
  // drift was corrupting both the week-grid header (day names vs. dates)
  // and the [from,to) range handed to `listBookingsInRange`.
  //
  // We derive the Monday from the AR weekday + AR date key, then build an
  // AR-midnight instant. Subtracting whole days via `setDate` is timezone-
  // safe because both AR and UTC are DST-free (24h per day, no wall-clock
  // drift).
  const mondayOffset = (toARDow(anchor) + 6) % 7; // days since Monday, AR
  const monday = new Date(localToARIso(`${toARDateKey(anchor)}T00:00:00`));
  monday.setDate(monday.getDate() - mondayOffset);
  return monday;
}

export default async function AgendaPage({ searchParams }: { searchParams: SP }) {
  const anchor = parseDate(searchParams.date);
  const view = searchParams.view ?? "timeline";
  const weekStart = startOfWeek(anchor);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const practitionerFilter = searchParams.practitioner ?? null;
  const [bookings, services, practitioners, patients, insurers, settings] = await Promise.all([
    listBookingsInRange({
      from: weekStart,
      to: weekEnd,
      practitionerId: practitionerFilter ?? undefined,
    }),
    listServices(),
    listPractitioners(),
    listPatients(),
    listInsurers({ onlyActive: true }),
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
      insurers={insurers.filter((i) => !i.isParticular).map((i) => ({ id: i.id, name: i.name }))}
      businessHours={{
        start: settings.businessHoursStart,
        end: settings.businessHoursEnd,
      }}
    />
  );
}
