import Link from "next/link";
import { LEGAL_LINKS } from "@/lib/legal";
import s from "./legal-document.module.css";

/**
 * [LG-P] Los dos links legales (Términos y Política de privacidad) para los pies de las superficies públicas: portal,
 * turnero, layout de `/terminos` y `/privacidad`. Server-safe (sin hooks ni "use client"): lo monta también el wizard
 * del turnero, que es cliente.
 *
 * - `block`: ocupa una fila propia dentro de un pie en flex (el del turnero es una línea centrada «Turnos online con
 *   [logo]»; con los dos links al lado no entraba a 360 px). El pie que lo use tiene que permitir `flex-wrap`.
 * - `newTab`: para links al lado de un formulario a medio llenar (casillas de aceptación), así leer los términos no
 *   pierde lo cargado. En los pies, misma pestaña.
 * Las etiquetas salen de `LEGAL_LINKS` (`lib/legal.ts`): un solo lugar para el texto de los links.
 * Sin `<ul>`: dos links dentro de un `<nav>` etiquetado alcanzan, y el marco del turnero afirma que «sin contacto no
 * hay lista» (`tests/unit/render/booking-unavailable.test.tsx`).
 */
export function LegalLinks({
  block = false,
  newTab = false,
  className,
}: {
  block?: boolean;
  newTab?: boolean;
  className?: string;
}) {
  const tab = newTab ? { target: "_blank", rel: "noopener noreferrer" } : {};
  return (
    <nav aria-label="Legales" className={[s.legalLinks, block ? s.legalLinksBlock : "", className ?? ""].join(" ").trim()}>
      {LEGAL_LINKS.map((l) => (
        <Link key={l.href} href={l.href} prefetch={false} className={s.legalLink} {...tab}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
