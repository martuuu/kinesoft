/**
 * Aviso del modo de cobro (PL-D16, `SAAS_BILLING_MODE`). Con `off` (default del deploy) el cron no genera cargos ni
 * manda mails: sin este aviso, una lista sin deuda se lee como «todos pagaron». Sin "use client" (lo monta un server
 * component con `saasBillingMode()`).
 */
import type { SaasBillingMode } from "@/lib/saas-billing-types";
import { WarnBox } from "@/components/plataforma/tenants/detail-ui";

export function BillingModeNotice({ mode }: { mode: SaasBillingMode }) {
  if (mode !== "off") return null;
  return (
    <WarnBox>
      El cobro de la suscripción está apagado: no se generan cargos ni se mandan avisos de pago. Igual podés imputar
      pagos y cambiar precios; los cargos empiezan cuando se active el cobro manual.
    </WarnBox>
  );
}
