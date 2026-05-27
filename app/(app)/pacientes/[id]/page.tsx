import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPatientCore,
  getPatientProgramsLite,
  getPatientBookingsSummary,
  getPatientBillableCount,
  getPatientEvaScores,
  getPatientName,
} from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { getActor } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PatientProfile } from "@/components/patients/patient-profile";
import { PatientBasicView } from "@/components/patients/patient-basic-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const p = await getPatientName(params.id);
  return { title: p ? `${p.firstName} ${p.lastName} · HC · KineSoft` : "Paciente · KineSoft" };
}

export default async function PatientPage({ params }: { params: { id: string } }) {
  const actor = await getActor();
  // First: a cheap auth probe via getPatientCore — returns the FULL
  // payload only if the actor owns / has been shared into / is OWNER+ADMIN.
  // Otherwise the call returns a basic projection and we short-circuit
  // to the gated view before loading any other slice.
  const core = await getPatientCore(params.id);
  if (!core) notFound();

  if (core.access === "basic") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Breadcrumbs name={`${core.firstName} ${core.lastName}`} />
        <PatientBasicView patient={core} />
      </div>
    );
  }

  // Full access — load the rest of the slices in parallel.
  const [
    programsLite,
    recentBookings,
    billableCount,
    evaScores,
    insurers,
    practitioners,
    membership,
  ] = await Promise.all([
    getPatientProgramsLite(params.id),
    getPatientBookingsSummary(params.id, 5),
    getPatientBillableCount(params.id),
    getPatientEvaScores(params.id),
    listInsurers({ onlyActive: true }),
    prisma.practitioner.findMany({
      where: { tenantId: actor.tenantId },
      include: { user: { select: { fullName: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.membership.findUnique({
      where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
      select: { role: true },
    }),
  ]);
  const canReassign = membership?.role === "OWNER" || membership?.role === "ADMIN";

  // Strip the `access` discriminator field before passing to the legacy
  // PatientProfile prop shape — it's a discriminated-union marker that
  // doesn't belong in the prisma-derived PatientCore type.
  const { access: _access, ...patientCore } = core;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Breadcrumbs name={`${core.firstName} ${core.lastName}`} />
      <PatientProfile
        patientCore={patientCore}
        programsLite={programsLite}
        recentBookings={recentBookings}
        billableCount={billableCount}
        evaScores={evaScores}
        insurers={insurers.map((i) => ({ id: i.id, name: i.name }))}
        practitioners={practitioners.map((p) => ({
          id: p.id,
          name: p.user.fullName ?? p.user.email,
        }))}
        canReassign={canReassign}
      />
    </div>
  );
}

function Breadcrumbs({ name }: { name: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--navy-300)" }}>
      <Link href="/pacientes" style={{ color: "inherit", textDecoration: "none" }}>
        Pacientes
      </Link>
      <span>›</span>
      <span style={{ color: "var(--navy-900)", fontWeight: 600 }}>{name}</span>
      <div style={{ flex: 1 }} />
      <Link
        href="/pacientes"
        style={{
          padding: "6px 12px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.6)",
          border: "1px solid rgba(15,30,51,0.06)",
          fontSize: 12,
          color: "var(--navy-700)",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        ← Volver al listado
      </Link>
    </div>
  );
}
