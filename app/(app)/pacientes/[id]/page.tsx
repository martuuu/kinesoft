import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPatientCore,
  getPatientProgramsFull,
  getPatientBookingsAll,
  getPatientEvaScores,
  getPatientName,
} from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { getActor } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PatientProfile } from "@/components/patients/patient-profile";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const p = await getPatientName(params.id);
  return { title: p ? `${p.firstName} ${p.lastName} · HC · KineSoft` : "Paciente · KineSoft" };
}

export default async function PatientPage({ params }: { params: { id: string } }) {
  const actor = await getActor();
  // Run independent queries in parallel — the previous monolithic
  // `getPatient` join hydrated ~150 rows of SessionExercise + joins to
  // Exercise in a single read; splitting lets Postgres pick narrower
  // plans per slice and starts work on each in parallel.
  const [core, programs, bookings, evaScores, insurers, practitioners, membership] =
    await Promise.all([
      getPatientCore(params.id),
      getPatientProgramsFull(params.id),
      getPatientBookingsAll(params.id, 20),
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
  if (!core) notFound();
  const canReassign = membership?.role === "OWNER" || membership?.role === "ADMIN";

  // Compose the legacy `PatientWithRelations` shape so the (large)
  // PatientProfile client component doesn't need a refactor on this pass.
  // A future split (Sprint 17) can fetch programs / bookings on tab click.
  const patient = { ...core, programs, bookings, evaScores };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Breadcrumbs name={`${core.firstName} ${core.lastName}`} />
      <PatientProfile
        patient={patient}
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
