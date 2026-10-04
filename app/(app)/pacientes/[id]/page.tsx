import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getPatientCore,
  getPatientBookingsSummary,
  getPatientBookingsAll,
  getPatientBillableCount,
  getPatientEvaScores,
  getPatientName,
} from "@/lib/patients";
import { getPatientProgramsLite } from "@/lib/programs";
import { gatingForActor } from "@/lib/plan-gating";
import { listInsurers } from "@/lib/insurers";
import { getActor } from "@/lib/session";
import { getCapabilities } from "@/lib/authz";
import { runWithRls } from "@/lib/rls";
import type { PatientCoreWithAccess } from "@/lib/patients-types";
import { PatientProfile, PatientAdminProfile } from "@/components/patients/patient-profile";
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
  // Upcast a la unión congelada (full | admin | basic), no a lo que infiere
  // `getPatientCore`: la rama `admin` compila antes y después de que S07sp sume
  // esa proyección (después, el `as` es un no-op; el integrador puede sacarlo).
  const core = (await getPatientCore(params.id)) as PatientCoreWithAccess | null;
  if (!core) notFound();

  // P0-S07v · nivel `admin` (PD-13): rol sin `clinical.read` (Secretaria,
  // BILLING). Va ANTES del corte de "no full": antes caía a la vista básica
  // ("Sin acceso") y la Secretaria no veía ni el teléfono. Solo se cargan
  // turnos (con estado de cobro) y capabilities; ningún slice clínico
  // (programs, EVA, plantillas) se pide para este nivel.
  if (core.access === "admin") {
    const [bookingsPage, caps] = await Promise.all([
      getPatientBookingsAll(params.id, 100),
      getCapabilities(),
    ]);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Breadcrumbs name={`${core.firstName} ${core.lastName}`} />
        <PatientAdminProfile
          patient={core}
          initialBookings={bookingsPage}
          canBook={caps.has("agenda.operateAll")}
        />
      </div>
    );
  }

  // HC solo con la forma positiva `=== "full"` (regla de compatibilidad de
  // E1): cualquier otro nivel (basic, o uno nuevo) cae a la vista básica.
  if (core.access !== "full") {
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
    gate,
  ] = await Promise.all([
    getPatientProgramsLite(params.id),
    getPatientBookingsSummary(params.id, 5),
    getPatientBillableCount(params.id),
    getPatientEvaScores(params.id),
    listInsurers({ onlyActive: true }),
    runWithRls(actor.tenantId, (tx) =>
      tx.practitioner.findMany({
        // Solo miembros con la invitación aceptada: un profesional removido
        // (membresía borrada) conserva su fila Practitioner y seguía en los
        // pickers. Mismo filtro que `listPractitioners` (lib/bookings.ts).
        where: {
          tenantId: actor.tenantId,
          user: { memberships: { some: { tenantId: actor.tenantId, acceptedAt: { not: null } } } },
        },
        include: { user: { select: { fullName: true, email: true } } },
        orderBy: { createdAt: "asc" },
      })
    ),
    runWithRls(actor.tenantId, (tx) =>
      tx.membership.findUnique({
        where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
        select: { role: true },
      })
    ),
    // P0-Cs: plan SaaS → plantillas, para que el Tab Plan sepa de antemano si
    // "Aplicar plantilla" está disponible (hoy solo se entera al confirmar).
    gatingForActor(),
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
        insurers={insurers
          .filter((i) => !i.isParticular)
          .map((i) => ({ id: i.id, name: i.name, payerId: i.payerId }))}
        practitioners={practitioners.map((p) => ({
          id: p.id,
          name: p.user.fullName ?? p.user.email,
        }))}
        canReassign={canReassign}
        canUseTemplates={gate.canBuildTemplates}
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
