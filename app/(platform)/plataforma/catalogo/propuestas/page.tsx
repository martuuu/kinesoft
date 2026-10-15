import { listPayerPlanProposals } from "@/lib/catalog-admin";
import { ProposalsClient } from "@/components/plataforma/catalog/proposals-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Propuestas · Catálogo · Plataforma" };

/** Planes de prestadora propuestos por consultorios, pendientes de promover al catálogo global. */
export default async function CatalogoPropuestasPage() {
  const proposals = await listPayerPlanProposals();
  return <ProposalsClient proposals={proposals} />;
}
