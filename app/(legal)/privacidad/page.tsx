import type { Metadata } from "next";
import { PrivacidadContent } from "@/components/legal/privacidad-content";
import { BRAND_NAME } from "@/lib/brand";
import { PRIVACY_PATH } from "@/lib/legal";

/**
 * [LG-P] `/privacidad`. Estática (`force-static`): el texto cambia solo con un deploy y una versión nueva
 * (`LEGAL_VERSION`). Indexable a propósito (sin `robots`): la política tiene que ser pública y fácil de encontrar.
 */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Política de privacidad",
  description: `Qué datos trata ${BRAND_NAME}, para qué, con qué proveedores, cuánto tiempo y cómo ejercer tus derechos.`,
  alternates: { canonical: PRIVACY_PATH },
};

export default function PrivacidadPage() {
  return <PrivacidadContent />;
}
