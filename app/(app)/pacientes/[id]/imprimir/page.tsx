import { notFound } from "next/navigation";
import { getActor } from "@/lib/session";
import { loadClinicalRecordForPrint } from "@/lib/clinical-notes-print-internal";
import { ClinicalRecordPrintView } from "./print-view";

/**
 * EV2-3d (EV2-D11) · «Imprimir historia clínica».
 *
 * Server y `force-dynamic`: cada visita es una impresión auditada (`clinicalRecord.print`), nunca una página cacheada.
 * Toda la decisión de acceso y el audit viven en `loadClinicalRecordForPrint` (C-EV2-6): null → `notFound()` (no
 * distingue «no existe» de «no podés»); si el audit falla, tira y la página no llega a renderizar ni una nota.
 *
 * Sin framer ni nada animado (el estado final es el impreso). El layout `(app)` sigue alrededor (sidebar, bandas): en
 * papel `print-view.tsx` lo saca del flujo con `display: none` (ver `PRINT_CSS`). Solo datos de ESTE paciente; el
 * autor sale de `authorName` (snapshot de `displayUserName`, nunca email).
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Historia clínica · KineSoft" };

export default async function PrintClinicalRecordPage({ params }: { params: { id: string } }) {
  const actor = await getActor();
  const record = await loadClinicalRecordForPrint(actor, params.id);
  if (!record) notFound();
  return <ClinicalRecordPrintView record={record} backHref={`/pacientes/${params.id}?tab=evoluciones`} />;
}
