import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionDetail } from "@/lib/sessions";
import { listSchedulablePlanSessions } from "@/lib/plans-read";
import { getBookingClinicalNote } from "@/lib/clinical-notes-read";
import { formatDateAR } from "@/lib/format";
import { SessionDetail } from "@/components/seguimiento/session-detail";
import {
  AGENDAR_PARAM,
  sessionCounterLabel,
  type SessionClinicalNote,
} from "@/components/seguimiento/seguimiento-model";

export const dynamic = "force-dynamic";

// El guard del módulo `sesiones` vive en `../layout.tsx` (EV0): no se duplica acá.

export async function generateMetadata({ params }: { params: { sessionId: string } }) {
  const s = await getSessionDetail(params.sessionId);
  if (!s) return { title: "Sesión · KineSoft" };
  return {
    // M13: "Sesión n de N" por ordinal; antes salía el `index` crudo.
    title: `${sessionCounterLabel(s.ordinal, s.totalLive)} · ${s.program.patient.firstName} ${s.program.patient.lastName} · KineSoft`,
  };
}

export default async function Page({
  params,
  searchParams,
}: {
  params: { sessionId: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await getSessionDetail(params.sessionId);
  if (!session) notFound();

  // "Agendar" (S20): solo si el server la devuelve como agendable "sin turno"
  // para este actor. `listSchedulablePlanSessions` ya aplica el módulo
  // `planes`, `plans.schedule`, R-LEGACY y plan ACTIVE; acá no se repite
  // ninguna de esas reglas. Un rechazo (`ok:false`) = sin botón.
  // EV2-D19: la evolución de HC del turno activo de la sesión, en paralelo con lo agendable.
  // `getBookingClinicalNote` ya aplica módulo `evoluciones`, `clinical.read` y el acceso al paciente
  // (null = nada que ofrecer).
  const b = session.bookings[0] ?? null;
  const [schedulable, v] = await Promise.all([
    session.completedAt ? null : listSchedulablePlanSessions({ patientId: session.program.patientId }),
    b ? getBookingClinicalNote(b.id) : null,
  ]);
  const canSchedule =
    !!schedulable?.ok && schedulable.data.some((x) => x.sessionId === session.id && x.sinTurno);
  const autoOpenSchedule = canSchedule && searchParams?.[AGENDAR_PARAM] === "1";
  const clinicalNote: SessionClinicalNote | null =
    b && v
      ? {
          patientId: session.program.patientId,
          booking: { id: b.id, scheduledFor: b.scheduledFor.toISOString(), serviceName: b.service?.name ?? null },
          canCreate: v.canCreate,
          hasLiveNote: v.note !== null,
        }
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <Breadcrumbs
        patientId={session.program.patientId}
        patientName={`${session.program.patient.firstName} ${session.program.patient.lastName}`}
        sessionLabel={sessionCounterLabel(session.ordinal, session.totalLive)}
      />
      {/* Format the date HERE (server) and pass a plain string: doing it in the
          client component made Node's ICU and the browser's disagree on the
          time separator → hydration mismatch. */}
      <SessionDetail
        session={session}
        scheduledLabel={formatDateAR(session.scheduledFor, "longDateTime")}
        canSchedule={canSchedule}
        autoOpenSchedule={autoOpenSchedule}
        clinicalNote={clinicalNote}
      />
    </div>
  );
}

function Breadcrumbs({
  patientId,
  patientName,
  sessionLabel,
}: {
  patientId: string;
  patientName: string;
  sessionLabel: string;
}) {
  return (
    <nav
      aria-label="Ruta"
      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--navy-300)", flexWrap: "wrap" }}
    >
      <Link href="/seguimiento" style={{ color: "inherit", textDecoration: "none" }}>
        Seguimiento
      </Link>
      <span aria-hidden="true">›</span>
      <Link
        href={`/pacientes/${patientId}`}
        style={{ color: "var(--navy-700)", textDecoration: "none", fontWeight: 600 }}
      >
        {patientName}
      </Link>
      <span aria-hidden="true">›</span>
      <span style={{ color: "var(--navy-900)", fontWeight: 600 }}>{sessionLabel}</span>
    </nav>
  );
}
