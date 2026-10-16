import { loadCatalog } from "@/lib/diagnosis";
import { getCapabilities } from "@/lib/authz";
import { getPatientName } from "@/lib/patients";
import { parseDiagnosisDeepLink } from "@/lib/plans-deeplink";
import { DiagnosticoScreen } from "@/components/screens/diagnostico-screen";
import { DiagnosticoWizard } from "@/components/screens/diagnostico-wizard";
import type { DiagnosisDoor } from "@/components/diagnostico/assign-plan-modal";
import { moduleWall } from "@/lib/module-wall";

export const metadata = { title: "Diagnóstico · KineSoft" };
export const dynamic = "force-dynamic";

/**
 * `/diagnostico` (S23, ES3 · C10). El guard del módulo `diagnostico` vive en
 * `layout.tsx` (EV0): no se duplica acá.
 *
 * Deep-link `?patientId=&bookingId=` (parseado SOLO con
 * `parseDiagnosisDeepLink`): el paciente se resuelve en el consultorio del
 * actor (`getPatientName`, `where tenantId`) para mostrar para quién es; el
 * acceso full a su HC lo exige el server al previsualizar y al guardar el plan
 * (`assertPlanManageInTx` / `hcAccessError`). Sin paciente en la URL no se
 * preselecciona nadie: ya no se pre-carga la lista de pacientes
 * (`searchPatientsForAssignment("")`), la búsqueda vive en el editor
 * (`PatientPicker requireFull`).
 */
export default async function DiagnosticoPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // VX-Z (B1): el layout y la página se renderizan EN PARALELO; sin el módulo, el layout muestra el muro o redirige,
  // pero la página igual corría sus queries (y `assertModule` tiraba). Mismo veredicto que el layout (actor cacheado).
  if ((await moduleWall("diagnostico")) !== "ok") return null;
  const link = parseDiagnosisDeepLink(searchParams);
  const [catalog, caps, named] = await Promise.all([
    loadCatalog(),
    getCapabilities(),
    link.patientId ? getPatientName(link.patientId) : Promise.resolve(null),
  ]);
  const patient =
    link.patientId && named
      ? { id: link.patientId, name: `${named.firstName} ${named.lastName}`.trim() }
      : null;
  // Se arma acá y no con un helper del módulo cliente: una función exportada
  // de un archivo "use client" no se puede llamar desde un Server Component
  // (llega como referencia de cliente). El contrato está en `DiagnosisDoor`.
  const door: DiagnosisDoor = {
    patient,
    // El turno solo con paciente: un turno suelto no dice para quién es el plan.
    bookingId: patient ? link.bookingId : null,
    patientNotFound: !!link.patientId && !patient,
    // Matriz E1: armar planes = `plans.manage` + `clinical.read` (la Secretaria
    // y Facturación exploran el diagnóstico pero no arman el plan).
    canAssign: caps.has("plans.manage") && caps.has("clinical.read"),
  };
  return (
    <>
      <div className="diag-desktop">
        <DiagnosticoScreen catalog={catalog} door={door} />
      </div>
      <div className="diag-mobile">
        <DiagnosticoWizard catalog={catalog} door={door} />
      </div>
    </>
  );
}
