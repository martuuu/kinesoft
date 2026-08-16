import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionDetail } from "@/lib/sessions";
import { formatDateAR } from "@/lib/format";
import { SessionDetail } from "@/components/seguimiento/session-detail";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { sessionId: string } }) {
  const s = await getSessionDetail(params.sessionId);
  if (!s) return { title: "Sesión · KineSoft" };
  return {
    title: `Sesión ${s.index} · ${s.program.patient.firstName} ${s.program.patient.lastName} · KineSoft`,
  };
}

export default async function Page({ params }: { params: { sessionId: string } }) {
  const session = await getSessionDetail(params.sessionId);
  if (!session) notFound();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Breadcrumbs
        patientId={session.program.patientId}
        patientName={`${session.program.patient.firstName} ${session.program.patient.lastName}`}
        sessionIndex={session.index}
      />
      {/* Format the date HERE (server) and pass a plain string: doing it in the
          client component made Node's ICU and the browser's disagree on the
          time separator → hydration mismatch. */}
      <SessionDetail
        session={session}
        scheduledLabel={formatDateAR(session.scheduledFor, "longDateTime")}
      />
    </div>
  );
}

function Breadcrumbs({
  patientId,
  patientName,
  sessionIndex,
}: {
  patientId: string;
  patientName: string;
  sessionIndex: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--navy-300)" }}>
      <Link href="/seguimiento" style={{ color: "inherit", textDecoration: "none" }}>
        Seguimiento
      </Link>
      <span>›</span>
      <Link
        href={`/pacientes/${patientId}`}
        style={{ color: "var(--navy-700)", textDecoration: "none", fontWeight: 600 }}
      >
        {patientName}
      </Link>
      <span>›</span>
      <span style={{ color: "var(--navy-900)", fontWeight: 600 }}>Sesión {sessionIndex}</span>
    </div>
  );
}
