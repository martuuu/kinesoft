import { notFound } from "next/navigation";
import { getTenantLedger } from "@/lib/platform-billing";
import { saasBillingMode } from "@/lib/env";
import { TenantLedgerView } from "@/components/plataforma/billing/ledger-view";
import { BillingModeNotice } from "@/components/plataforma/billing/billing-mode-notice";

export const dynamic = "force-dynamic";
export const metadata = { title: "Facturación · Consultorio · Plataforma" };

/**
 * /plataforma/consultorios/[id]/facturacion — ledger del consultorio (PL-3c): cargos y pagos, comprobantes a revisar,
 * «Registrar pago», condonar/anular y precio a medida. `getTenantLedger` re-chequea `requirePlatformAdmin` y devuelve
 * null para un id inexistente → 404 (el layout ya lo da para el detalle; esto cubre la carrera de un borrado).
 */
export default async function ConsultorioFacturacionPage({ params }: { params: { id: string } }) {
  const ledger = await getTenantLedger(params.id);
  if (!ledger) notFound();
  // MPS-4b: el modo decide qué partes de Mercado Pago, ajustes y re-anclaje se muestran (con `off`, nada a medio hacer).
  const mode = saasBillingMode();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <BillingModeNotice mode={mode} />
      <TenantLedgerView ledger={ledger} mode={mode} />
    </div>
  );
}
