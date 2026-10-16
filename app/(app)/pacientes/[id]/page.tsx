import { displayMemberName } from "@/lib/display-name";
import Link from "next/link";
import { notFound } from "next/navigation";
import { canWriteClinicalNotes } from "@/lib/clinical-notes-logic";
import { getActor } from "@/lib/session";
import { getCapabilities, getMemberAccess, memberCapabilitiesForActor } from "@/lib/authz";
import { modulesFor } from "@/lib/tenant-modules";
import { parseProfilePlanParams, type SearchParamsLike } from "@/lib/plans-deeplink";
import { loadPatientProfilePage, profileNoteBookingId } from "@/lib/patient-profile-loader";
import { PatientProfile, PatientAdminProfile } from "@/components/patients/patient-profile";
import { PatientBasicView } from "@/components/patients/patient-basic-view";

export const dynamic = "force-dynamic";

/**
 * PF-Z (decisión con default, 16-oct): título genérico, sin leer el paciente. En Next 14 `generateMetadata` se espera
 * antes del primer byte: con la carga entera del perfil (PF2-b) el `loading.tsx` dejaba de verse (TTFB 54 → 194 ms en
 * misma región, 0,9 → 4,5 s cruzado). Una lectura liviana aparte devolvía el esqueleto pero subía el perfil a 4 tx.
 * Además el nombre del paciente ya no queda en la pestaña ni en el historial de una PC de recepción compartida.
 */
export const metadata = { title: "Paciente · KineSoft" };

/**
 * S22b (ES3): los planes salen de la proyección de `getPatientPlans` / `getPatientPlanBalances` (S14). Solo se piden
 * con el módulo `planes` (enmienda EV0: un consultorio General no carga planes ni saldos); los EVA, solo con
 * `evaluaciones`. El deep-link C10 (`?tab=planes&programa=…`, `?tab=planes&nuevo=1&turno=…&prefill=…`, alias
 * `?tab=plan`) se parsea acá con `parseProfilePlanParams` y el shell lo consume una vez.
 *
 * PF2-b (C-PF8): la página resuelve el actor y hace UNA carga (`loadPatientProfilePage` →
 * `runWithRls(tenantId, tx => loadPatientProfile(actor, tx, …))`, lib/patient-profile-loader.ts): acceso, core y los
 * slices del nivel en una tx; afuera solo obras sociales (cacheadas) y el resumen de evoluciones. Antes: ~12 tx. Los
 * cortes por nivel son los de siempre: `admin` (Secretaria/Facturación) ve datos y turnos, `basic` la vista básica,
 * HC solo con `=== "full"`.
 */
export default async function PatientPage({
  params,
  searchParams = {},
}: {
  params: { id: string };
  searchParams?: SearchParamsLike;
}) {
  const actor = await getActor();
  const modules = modulesFor(actor.entitlements);
  // EV2-3a · deep link `?tab=evoluciones&turno=<bookingId>` (`clinicalNoteDeepLink`): el loader proyecta el turno
  // solo si es de ESTE paciente y del consultorio. Sin el módulo no se mira.
  const noteBookingId = profileNoteBookingId(actor, searchParams);
  const data = await loadPatientProfilePage(actor, params.id, noteBookingId);
  if (data.access === "none") notFound();

  // P0-S07v · nivel `admin` (PD-13): rol sin `clinical.read` (Secretaria,
  // BILLING). Va ANTES del corte de "no full": antes caía a la vista básica
  // ("Sin acceso") y la Secretaria no veía ni el teléfono. Solo turnos (con
  // estado de cobro) y capabilities; ningún slice clínico (EVA, plantillas).
  // Con el módulo `planes`, los planes en su proyección `admin` (sin título ni
  // notas, S14) y los saldos, para agrupar Turnos por plan (H1 de S22f).
  if (data.access === "admin") {
    const caps = await getCapabilities();
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Breadcrumbs name={`${data.core.firstName} ${data.core.lastName}`} />
        <PatientAdminProfile
          patient={data.core}
          initialBookings={data.bookingsPage}
          canBook={caps.has("agenda.operateAll")}
          plans={data.plans?.ok ? data.plans.data : null}
          planBalances={data.balances?.ok ? data.balances.data : null}
        />
      </div>
    );
  }

  // HC solo con la forma positiva `=== "full"` (regla de compatibilidad de
  // E1): cualquier otro nivel (basic, o uno nuevo) cae a la vista básica.
  if (data.access !== "full") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Breadcrumbs name={`${data.core.firstName} ${data.core.lastName}`} />
        <PatientBasicView patient={data.core} />
      </div>
    );
  }

  const notesModule = modules.has("evoluciones");
  const { tab: initialTab, intent: planIntent } = parseProfilePlanParams(searchParams);
  const { core, plans: plansRes, balances: balancesRes, noteBookingRow } = data;
  // PL-1 (H1b-17): el miembro sale del Actor (`Actor.membership`), sin query.
  const membership = await getMemberAccess(actor);
  const role = membership?.role ?? null;
  // Por MIEMBRO (PL-1, H-PL1): un Titular sin agenda no recibe `clinical.read`. Plantillas: el shell usa el
  // módulo `plantillas` (enmienda EV0, mismo criterio que `gatingForActor().canBuildTemplates`).
  const capabilities = Array.from(await memberCapabilitiesForActor(actor));
  // PL-Z a3#9: reasignar = `tenant.admin` del miembro, el mismo criterio que `assignPatientToPractitioner`. Por rol,
  // la UI le ofrecía el selector a un ADMIN sin «Configuración» (la action lo rechaza) y se lo escondía a un
  // Profesional que la tiene.
  const canReassign = capabilities.includes("tenant.admin");
  // EV2-D3: escribe quien tiene `clinical.read` + acceso full + profesional (la action vuelve a chequearlo).
  const canWriteNotes = notesModule && canWriteClinicalNotes(new Set(capabilities), "full", actor.practitionerId);

  // Strip the `access` discriminator field before passing to the legacy
  // PatientProfile prop shape — it's a discriminated-union marker that
  // doesn't belong in the prisma-derived PatientCore type.
  const { access: _access, ...patientCore } = core;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Breadcrumbs name={`${core.firstName} ${core.lastName}`} />
      <PatientProfile
        patientCore={patientCore}
        recentBookings={data.recentBookings}
        billableCount={data.billableCount}
        evaScores={data.evaScores}
        insurers={data.insurers
          .filter((i) => !i.isParticular)
          .map((i) => ({ id: i.id, name: i.name, payerId: i.payerId }))}
        practitioners={data.practitioners.map((p) => ({
          id: p.id,
          name: displayMemberName(p.user.fullName),
        }))}
        canReassign={canReassign}
        capabilities={capabilities}
        role={role}
        initialPlans={plansRes?.ok ? plansRes.data : []}
        initialPlanBalances={balancesRes?.ok ? balancesRes.data : null}
        initialPlansError={plansRes && !plansRes.ok ? plansRes.error : null}
        initialTab={initialTab}
        planIntent={planIntent}
        clinicalSummary={data.clinicalSummary}
        canWriteNotes={canWriteNotes}
        noteBookingId={noteBookingId}
        noteBooking={
          noteBookingRow
            ? {
                id: noteBookingRow.id,
                scheduledFor: noteBookingRow.scheduledFor.toISOString(),
                status: noteBookingRow.status,
                serviceName: noteBookingRow.service?.name ?? null,
              }
            : null
        }
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
