import type { Metadata } from "next";
import { buttonClassName } from "@/components/ui/button";
import s from "@/components/sede/sede.module.css";

export const metadata: Metadata = {
  // Mismo título que el 404 del root: no delata si el slug existe con la sede apagada.
  title: "Página no encontrada",
  robots: { index: false, follow: false },
};

/**
 * CF3 (SD-U) · 404 de la sede `/<slug>`: inexistente, sede apagada, consultorio suspendido o de baja, slug reservado o
 * con forma inválida. El MISMO texto en todos los casos: no confirma que un consultorio existe ni por qué no se ve.
 *
 * ESTÁTICO a propósito (sin sesión, cookies ni headers; lo vigila `tests/unit/render/cf3-sede-page.test.tsx`): la
 * página es ISR y el 404 del root lee la cookie de sesión → 500 en `next start` (DIR-Z-F1). Si algún día necesita algo
 * del request, la sede deja de ser ISR.
 */
export default function SedeNotFound() {
  return (
    <main id="main" className={s.notFound}>
      <div className={s.notFoundCard}>
        <p className={s.eyebrow}>Error 404</p>
        <h1 className={s.h2}>No encontramos esta página</h1>
        <p className={s.note}>Puede que el link esté mal copiado o que la página ya no exista.</p>
        <a href="/" className={buttonClassName({ variant: "primary", size: "md" })}>
          Ir al inicio
        </a>
      </div>
    </main>
  );
}
