import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { ButtonLink } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand";
import st from "@/components/screens/auth-screens.module.css";
import { env } from "@/lib/env";
import { parseConfirmParams } from "@/lib/auth-confirm-internal";
import { ContinueForm } from "./continue-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Confirmando · ${BRAND_NAME}`,
  // El token viaja en la URL de esta página: ni indexarla ni mandarlo como Referer a otro sitio.
  // `same-origin` y NO `no-referrer`: con `no-referrer` Chrome manda `Origin: null` en el POST del form
  // (lo midió Traze: todo link terminaba en «inválido»). A otro sitio no sale nada igual.
  robots: { index: false, follow: false },
  referrer: "same-origin",
};

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

/**
 * Paso intermedio del link del mail (IAM-2c). `GET /auth/confirm` trae acá SIN gastar el token; esta
 * página lo manda por POST a `/auth/confirm` (sola al cargar, o con «Continuar» si el navegador no corre
 * JavaScript). Un escáner de links del correo que solo abre la URL no llega a canjearlo.
 *
 * Los parámetros se vuelven a sanear acá (alguien puede llegar a esta URL a mano) y otra vez en el POST.
 *
 * VX2-a: AuthShell `centered` con la h1 en la card (antes había h1 en la intro y h2 en la card).
 */
export default function ConfirmContinuePage({ searchParams }: { searchParams: SP }) {
  const params = parseConfirmParams((k) => one(searchParams[k]), [env.NEXT_PUBLIC_APP_URL]);
  const recovery = params?.type === "recovery";

  return (
    <AuthShell variant="centered" footerLinks={[{ label: "Ir a ingresar", href: "/login" }]}>
      <div className={st.stack}>
        <div className={st.head}>
          <h1 className={st.title}>
            {params ? (recovery ? "Un momento…" : "Confirmando tu acceso") : "No pudimos leer el link"}
          </h1>
          <p className={st.sub}>
            {params
              ? recovery
                ? "Estamos validando tu link para que elijas una contraseña nueva."
                : `Estamos validando tu link para que entres a ${BRAND_NAME}.`
              : "Puede que el link se haya cortado al copiarlo. Abrí de nuevo el link del email o pedí uno nuevo desde la pantalla de ingreso."}
          </p>
        </div>
        {params ? (
          <ContinueForm tokenHash={params.tokenHash} type={params.type} next={params.next} />
        ) : (
          <ButtonLink href="/login" size="lg" block>
            Ir a ingresar
          </ButtonLink>
        )}
      </div>
    </AuthShell>
  );
}
