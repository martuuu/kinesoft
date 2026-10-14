import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/screens/auth-shell";
import { env } from "@/lib/env";
import { parseConfirmParams } from "@/lib/auth-confirm-internal";
import { ContinueForm } from "./continue-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirmando · KineSoft",
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
 */
export default function ConfirmContinuePage({ searchParams }: { searchParams: SP }) {
  const params = parseConfirmParams((k) => one(searchParams[k]), [env.NEXT_PUBLIC_APP_URL]);
  const recovery = params?.type === "recovery";

  return (
    <AuthShell
      eyebrow="Tu cuenta"
      heading={params ? "Confirmando tu acceso" : "El link está incompleto"}
      blurb={
        params
          ? "Un momento: estamos validando el link que te llegó por email."
          : "Abrí de nuevo el link del email o pedí uno nuevo desde la pantalla de ingreso."
      }
      footerLinks={[{ label: "Ir a ingresar", href: "/login" }]}
    >
      <h2 className="k-display" style={{ fontSize: 26, margin: "0 0 10px", lineHeight: 1.1 }}>
        {params ? (recovery ? "Un momento…" : "Confirmando…") : "No pudimos leer el link"}
      </h2>
      <p style={{ margin: "0 0 22px", fontSize: 14, lineHeight: 1.5, color: "var(--navy-500)" }}>
        {params
          ? recovery
            ? "Estamos validando tu link para que elijas una contraseña nueva."
            : "Estamos validando tu link para que entres a KineSoft."
          : "Puede que el link se haya cortado al copiarlo. Pedí uno nuevo y abrilo directo desde el email."}
      </p>
      {params ? (
        <ContinueForm tokenHash={params.tokenHash} type={params.type} next={params.next} />
      ) : (
        <Link href="/login" className="k-btn k-btn-primary" style={{ width: "100%", justifyContent: "center" }}>
          Ir a ingresar
        </Link>
      )}
    </AuthShell>
  );
}
