import type { Metadata } from "next";
import { getPublicPaymentLink } from "@/lib/public-payment-link";
import { PayLinkView, type PayLinkReturn } from "@/components/payments/pay-link-view";
import { BRAND_NAME } from "@/lib/brand";

/**
 * [TP-3i] `/pagar/[token]`: el link de pago que el consultorio le manda al paciente (plan §25.7, C-TP9, TP-D23).
 *
 * Vive en `app/(booking)/` a propósito (§25.2 hallazgo 14): así lo cubre el guard de superficies públicas (sin
 * providers, framer, toast, drawer ni modal) y cae en el grupo de bundle `public` (≤120 kB), no en `workspace`.
 *
 * - **El GET nunca escribe.** Los antivirus de mail y los previews de WhatsApp abren los links: la página solo llama a
 *   `getPublicPaymentLink` (lectura, rate limit sin base) y el vencimiento se calcula, no se graba (lo hace el cron).
 * - **Sin datos del paciente**: `PublicPaymentLink` no los trae (ni se seleccionan).
 * - `force-dynamic` + `revalidate = 0` + `fetchCache = force-no-store`: el estado cambia con el webhook y no puede
 *   quedar en ningún caché (Next manda `Cache-Control: private, no-cache, no-store` en las rutas dinámicas).
 * - `noindex` (además del `Disallow: /pagar/` de `app/robots.ts`) y `referrer: same-origin`: el token viaja en la URL y
 *   no tiene que salir en el Referer hacia Mercado Pago ni hacia ningún otro sitio.
 * - Una sola lectura por request: el título es fijo (un `generateMetadata` con el consultorio leería dos veces y gastaría
 *   el doble del rate limit de 60/min/IP).
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
  title: `Link de pago · ${BRAND_NAME}`,
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

/** `?r=` de las `back_urls` (C-TP9). Cualquier otro valor (o repetido) se ignora: no cambia lo que se ve. */
function returnParam(r: string | string[] | undefined): PayLinkReturn | null {
  return r === "ok" || r === "failed" || r === "pending" ? r : null;
}

export default async function PagarPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { r?: string | string[] };
}) {
  const link = await getPublicPaymentLink(params.token);
  // El link «limpio» (sin `?r=`) para cuando el poller se agota: muestra el estado real. Token ya validado si hay link.
  const resetHref = `/pagar/${encodeURIComponent(params.token)}`;
  return <PayLinkView link={link} r={returnParam(searchParams.r)} resetHref={resetHref} />;
}
