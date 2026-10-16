import type { Metadata } from "next";
import { getPublicPlanCatalog } from "@/lib/saas-plans-public";
import { env, saasBillingMode } from "@/lib/env";
import { BRAND_NAME } from "@/lib/brand";
import { SiteHeader } from "@/components/landing/site-header";
import { Hero } from "@/components/landing/hero";
import { Features } from "@/components/landing/features";
import { Specialty } from "@/components/landing/specialty";
import { Steps } from "@/components/landing/steps";
import { LandingPricing } from "@/components/landing/pricing";
import { Faq } from "@/components/landing/faq";
import { LandingContact } from "@/components/landing/contact";
import { SiteFooter } from "@/components/landing/site-footer";
import base from "@/components/landing/landing.module.css";

/**
 * [VX2-c1] Landing B editorial (D-VX2, prototipo `design_source/vx0/landing-b.html` con las correcciones del brief
 * §0.3.5). Reemplaza a `components/screens/landing-screen.tsx` (H-LAND: copy con claims que no existían, stats y
 * testimonios inventados, framer en el bundle).
 *
 * - **ISR 1 h** (C-VX-L, D-VX29): la página no lee la cookie ni nada por request. El catálogo de precios trae su
 *   propio cache con tag (`SAAS_PLANS_TAG`), que Plataforma revalida al editar precios; esta hora es la red.
 * - `startedAt` = `Date.now()` del render ISR (C-VX-L): el form lo reemplaza al montar, y sin JS queda el del render,
 *   que siempre tiene más de 3 s de antigüedad (el anti-bot de `leadBotVerdict` lo acepta).
 * - `trialDays` sale de la fila Individual del catálogo; si el catálogo vino vacío (base caída en el build), `null`:
 *   el copy no promete una cantidad de días que no pudo leer.
 * - Superficie pública (C-F7): sin providers ni framer; lo único cliente es el menú mobile y el form de contacto.
 */
export const revalidate = 3600;

const TITLE = `${BRAND_NAME} — agenda, turnos online e historia clínica para tu consultorio`;
const DESCRIPTION =
  "Agenda, turnos online, historia clínica y cobros para tu consultorio. Con herramientas propias para kinesiología.";

export const metadata: Metadata = {
  // Sin metadataBase, Next arma las URLs absolutas de og:url/og:image con localhost (el root no lo define).
  metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "es_AR",
    siteName: BRAND_NAME,
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default async function HomePage() {
  const plans = await getPublicPlanCatalog();
  const startedAt = Date.now();
  const trialDays = plans.find((p) => p.plan === "INDIVIDUAL")?.trialDays ?? null;
  const showBilling = saasBillingMode() === "manual";

  return (
    <div className={base.page}>
      <a className="k-skip-link" href="#main">
        Saltar al contenido
      </a>
      <SiteHeader />
      <main id="main">
        <Hero trialDays={trialDays} />
        <Features />
        <Specialty />
        <Steps trialDays={trialDays} />
        <LandingPricing plans={plans} />
        <Faq trialDays={trialDays} showBilling={showBilling} />
        <LandingContact startedAt={startedAt} />
      </main>
      <SiteFooter />
    </div>
  );
}
