import { displayMemberName } from "@/lib/display-name";
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
import { getPatientPlanBalances, getPatientPlans } from "@/lib/plans-read";
import { getPatientClinicalSummary } from "@/lib/clinical-notes-read";
import { canWriteClinicalNotes } from "@/lib/clinical-notes-logic";
import { listInsurers } from "@/lib/insurers";
import { getActor } from "@/lib/session";
import { getCapabilities, getMemberAccess, memberCapabilitiesForActor } from "@/lib/authz";
import { runWithRls } from "@/lib/rls";
import { modulesFor } from "@/lib/tenant-modules";
import { parseProfilePlanParams, type SearchParamsLike } from "@/lib/plans-deeplink";
import type { PatientCoreWithAccess } from "@/lib/patients-types";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { PatientProfile, PatientAdminProfile } from "@/components/patients/patient-profile";
import { PatientBasicView } from "@/components/patients/patient-basic-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const p = await getPatientName(params.id);
  return { title: p ? `${p.firstName} ${p.lastName} · HC · KineSoft` : "Paciente · KineSoft" };
}

/**
 * S22b (ES3): los planes salen de `getPatientPlans` / `getPatientPlanBalances`
 * (S14), que reemplazan a `getPatientProgramsLite`. Solo se piden con el
 * módulo `planes` (enmienda EV0: un consultorio General no carga planes ni
 * saldos); los EVA, solo con `evaluaciones`. El deep-link C10
 * (`?tab=planes&programa=…`, `?tab=planes&nuevo=1&turno=…&prefill=…`, alias
 * `?tab=plan`) se parsea acá con `parseProfilePlanParams` y el shell lo
 * consume una vez.
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
  const plansEnabled = modules.has("planes");
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
  // (EVA, plantillas) se pide para este nivel. Con el módulo `planes`, los
  // planes en su proyección `admin` (sin título ni notas, S14) y los saldos,
  // para agrupar Turnos por plan (H1 de S22f).
  if (core.access === "admin") {
    const [bookingsPage, caps, adminPlans, adminBalances] = await Promise.all([
      getPatientBookingsAll(params.id, 100),
      getCapabilities(),
      plansEnabled ? getPatientPlans({ patientId: params.id }) : null,
      plansEnabled ? getPatientPlanBalances({ patientId: params.id }) : null,
    ]);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Breadcrumbs name={`${core.firstName} ${core.lastName}`} />
        <PatientAdminProfile
          patient={core}
          initialBookings={bookingsPage}
          canBook={caps.has("agenda.operateAll")}
          plans={adminPlans?.ok ? adminPlans.data : null}
          planBalances={adminBalances?.ok ? adminBalances.data : null}
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

  // EV2-3a · deep link `?tab=evoluciones&turno=<bookingId>` (`clinicalNoteDeepLink`): el id se valida con el mismo
  // molde que el resto de los ids de URL y el turno se proyecta solo si es de ESTE paciente y del consultorio (fecha,
  // estado y servicio: lo que la ficha `full` ya ve en Turnos). Sin el módulo no se mira.
  const notesModule = modules.has("evoluciones");
  const { tab: initialTab, intent: planIntent } = parseProfilePlanParams(searchParams);
  const rawTurno = searchParam(searchParams, "turno");
  const noteBookingId =
    notesModule && initialTab === "evoluciones" && rawTurno && /^[A-Za-z0-9_-]{1,64}$/.test(rawTurno) ? rawTurno : null;

  // Full access — load the rest of the slices in parallel.
  const [
    plansRes,
    balancesRes,
    recentBookings,
    billableCount,
    evaScores,
    insurers,
    practitioners,
    membership,
    clinicalSummary,
    noteBookingRow,
  ] = await Promise.all([
    plansEnabled ? getPatientPlans({ patientId: params.id }) : null,
    plansEnabled ? getPatientPlanBalances({ patientId: params.id }) : null,
    getPatientBookingsSummary(params.id, 5),
    getPatientBillableCount(params.id),
    // Enmienda EV0 de S22b: sin `evaluaciones` no se piden EVA (y la pestaña
    // EVA no se muestra).
    modules.has("evaluaciones") ? getPatientEvaScores(params.id) : [],
    listInsurers({ onlyActive: true }),
    runWithRls(actor.tenantId, (tx) =>
      tx.practitioner.findMany({
        // Solo miembros con la invitación aceptada: un profesional removido
        // (membresía borrada) conserva su fila Practitioner y seguía en los
        // pickers. Mismo filtro que `listPractitioners` (lib/bookings.ts):
        // IAM-2e, solo roles clínicos sin suspender (la Secretaria no atiende).
        where: bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }),
        include: { user: { select: { fullName: true, email: true } } },
        orderBy: { createdAt: "asc" },
      })
    ),
    // PL-1 (H1b-17): el miembro sale del Actor (`Actor.membership`), sin query.
    getMemberAccess(actor),
    // EV2-3a: contador de la pestaña + «Última evolución» de Resumen. Solo en el perfil `full` (nunca en `admin` ni
    // en el básico); el gate de la lectura (`clinical.read` + full) devuelve null al Titular sin agenda.
    notesModule ? getPatientClinicalSummary(params.id) : null,
    noteBookingId
      ? runWithRls(actor.tenantId, (tx) =>
          tx.booking.findFirst({
            where: { id: noteBookingId, tenantId: actor.tenantId, patientId: params.id },
            select: { id: true, scheduledFor: true, status: true, service: { select: { name: true } } },
          })
        )
      : null,
  ]);
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
        recentBookings={recentBookings}
        billableCount={billableCount}
        evaScores={evaScores}
        insurers={insurers
          .filter((i) => !i.isParticular)
          .map((i) => ({ id: i.id, name: i.name, payerId: i.payerId }))}
        practitioners={practitioners.map((p) => ({
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
        clinicalSummary={clinicalSummary}
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

/** Un param de la URL (string suelto; un array o nada → null). */
function searchParam(sp: SearchParamsLike, key: string): string | null {
  if (sp instanceof URLSearchParams) return sp.get(key);
  const v = sp[key];
  return typeof v === "string" ? v : null;
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
