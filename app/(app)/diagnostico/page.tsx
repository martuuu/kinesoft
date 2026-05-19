import { loadCatalog, searchPatientsForAssignment } from "@/lib/diagnosis";
import { DiagnosticoScreen } from "@/components/screens/diagnostico-screen";
import { DiagnosticoWizard } from "@/components/screens/diagnostico-wizard";

export const metadata = { title: "Diagnóstico · KineSoft" };
export const dynamic = "force-dynamic";

export default async function DiagnosticoPage() {
  const [catalog, initialPatients] = await Promise.all([
    loadCatalog(),
    searchPatientsForAssignment(""),
  ]);
  return (
    <>
      <div className="diag-desktop">
        <DiagnosticoScreen catalog={catalog} initialPatients={initialPatients} />
      </div>
      <div className="diag-mobile">
        <DiagnosticoWizard catalog={catalog} initialPatients={initialPatients} />
      </div>
    </>
  );
}
