import { moduleWall } from "@/lib/module-wall";
import { clinicalSurfaceAllowed } from "@/lib/clinical-wall";
import { ComingSoon } from "@/components/ui/coming-soon";

export const metadata = { title: "Diagnóstico" };
export const dynamic = "force-dynamic";

/**
 * `/diagnostico` (S23, ES3 · C10) → CF (§28, decisión 8 de Martin, 30-oct): «Próximamente» para todos mientras se
 * termina la guía de diagnóstico. El guard del módulo `diagnostico` y el de `clinical.read` viven en `layout.tsx`.
 *
 * La página ya no carga el catálogo ni el asistente (`DiagnosticoScreen` / `DiagnosticoWizard`, `loadCatalog`,
 * `parseDiagnosisDeepLink` + `getPatientName`): quedan en el repo sin borrar porque la pantalla vuelve con la guía. El
 * deep-link `?patientId=&bookingId=` (C10) se ignora: cae en este mismo «Próximamente».
 */
export default async function DiagnosticoPage() {
  // VX-Z (B1): el layout y la página se renderizan EN PARALELO; sin el módulo, el layout muestra el muro o redirige.
  // Mismo veredicto que el layout (actor cacheado).
  if ((await moduleWall("diagnostico")) !== "ok") return null;
  // CF-NAV: mismo veredicto que el layout (sin `clinical.read` → /dashboard).
  if (!(await clinicalSurfaceAllowed())) return null;
  return (
    <ComingSoon
      eyebrow="Diagnóstico"
      description="Estamos terminando la guía de diagnóstico. Mientras tanto, cargá el diagnóstico en el perfil del paciente, en Resumen."
    />
  );
}
