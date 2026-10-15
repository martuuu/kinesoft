import Link from "next/link";
import { Card } from "@/components/ui/card";
import { listAccounts } from "@/lib/platform-billing";
import { saasBillingMode } from "@/lib/env";
import { AccountsList } from "@/components/plataforma/billing/accounts-list";
import { BillingModeNotice } from "@/components/plataforma/billing/billing-mode-notice";
import {
  PRICES_PATH,
  accountsFilterOf,
  filterAccountRows,
  parseAccountsQuery,
} from "@/components/plataforma/billing/billing-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Facturación · Plataforma · KineSoft" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /plataforma/facturacion — estado contable de cada consultorio (PL-3c, plan §20.5.6 sin Mercado Pago): con deuda,
 * comprobantes a revisar, vencidas, por plan y por estado; link al ledger de cada uno. El guard de superadmin está en
 * el layout del grupo y `listAccounts` vuelve a llamar a `requirePlatformAdmin` (el layout es UX, no la barrera).
 */
export default async function PlataformaFacturacionPage({ searchParams }: { searchParams: SearchParams }) {
  const query = parseAccountsQuery(searchParams);
  const page = await listAccounts(accountsFilterOf(query));
  const rows = filterAccountRows(page.rows, query);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 24 }}>
        <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
          Facturación
        </h1>
        <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 680, lineHeight: 1.45 }}>
          El estado de cuenta de cada consultorio: lo que debe, los comprobantes que mandaron y falta revisar, y cuándo
          se genera el próximo cargo. Entrá a un consultorio para imputar un pago o revisar un comprobante. Los precios
          de lista se cambian en <Link href={PRICES_PATH} style={{ color: "var(--sky-700)", fontWeight: 600 }}>Precios</Link>.
        </p>
      </Card>
      <BillingModeNotice mode={saasBillingMode()} />
      <AccountsList rows={rows} nextCursor={page.nextCursor} query={query} />
    </div>
  );
}
