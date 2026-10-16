import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { listPlanPrices, listPriceHistory } from "@/lib/platform-billing";
import { countPriceNoticeRecipients } from "@/lib/platform-billing-read";
import { PlanPricesEditor, PriceHistoryList } from "@/components/plataforma/billing/price-editor";
import { BILLING_PATH } from "@/components/plataforma/billing/billing-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Precios · Plataforma · KineSoft" };

/**
 * /plataforma/precios — precios de lista de los planes SaaS en ARS, con vigencia e historial (PL-3c, PL-D8/PL-D19).
 * El guard de superadmin está en el layout del grupo; cada lectura vuelve a llamar a `requirePlatformAdmin`.
 */
export default async function PlataformaPreciosPage() {
  const [rows, history, recipients] = await Promise.all([listPlanPrices(), listPriceHistory(), countPriceNoticeRecipients()]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Precios"
        description={
          <>
            Los precios de lista de cada plan. Un cambio rige desde el día que elijas y les avisa por mail a los
            consultorios que pagan el precio de lista. El precio a medida de un consultorio se fija en su{" "}
            <Link href={BILLING_PATH} style={{ color: "var(--sky-700)", fontWeight: 600 }}>
              Facturación
            </Link>
            .
          </>
        }
      />
      <PlanPricesEditor rows={rows} recipients={recipients} />
      <PriceHistoryList rows={history} />
    </div>
  );
}
