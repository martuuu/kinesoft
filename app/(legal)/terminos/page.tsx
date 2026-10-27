import type { Metadata } from "next";
import { TerminosContent } from "@/components/legal/terminos-content";
import { BRAND_NAME } from "@/lib/brand";
import { TERMS_PATH } from "@/lib/legal";

/**
 * [LG-P] `/terminos`. Estática (`force-static`): el texto cambia solo con un deploy y una versión nueva
 * (`LEGAL_VERSION`). Indexable a propósito (sin `robots`): quien evalúa contratar tiene que poder encontrarla.
 */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Términos y condiciones",
  description: `Las reglas para usar ${BRAND_NAME}: cuentas, planes y pagos, datos de pacientes, cobros online y soporte.`,
  alternates: { canonical: TERMS_PATH },
};

export default function TerminosPage() {
  return <TerminosContent />;
}
