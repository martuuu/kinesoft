import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { StatusHeading, StatusLink, StatusText } from "@/app/plataforma-mfa/shared";
import { ButtonLink } from "@/components/ui/button";
import { directoryMode } from "@/lib/directory-mode";
import s from "@/components/directory/directory.module.css";

export const metadata: Metadata = {
  // Mismo título que el 404 del root: con `DIRECTORY_MODE=off` el <title> tampoco delata al directorio.
  title: "Página no encontrada · KineSoft",
  robots: { index: false, follow: false },
};

/**
 * DIR-Z-F1 · 404 del directorio (`notFound()` de `/consultorios/[slug]` y `/profesionales/[nombreId]`).
 *
 * Por qué existe: las fichas son ISR (`revalidate = 600` + `generateStaticParams` vacío) y sin este archivo su
 * `notFound()` pintaba `app/not-found.tsx`, que lee la cookie de sesión para el CTA. En `next start` eso tiraba
 * «Page changed from static to dynamic at runtime …, reason: cookies» y respondía 500 en vez de 404 (revisor visual
 * de DIR-Z). Este 404 es ESTÁTICO a propósito: no lee sesión, cookies ni headers (lo vigila
 * `tests/unit/render/directory-not-found.test.tsx`). Si algún día necesita algo del request, la ficha deja de ser ISR.
 *
 * `DIRECTORY_MODE=off`: el layout del grupo no monta el marco (`app/(directory)/layout.tsx`) y acá va el 404 genérico,
 * sin nada que delate que existe un directorio. `directoryMode()` lee `process.env`, no el request: sigue siendo
 * estático.
 */
export default function DirectoryNotFound() {
  if (directoryMode() === "off") {
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading eyebrow="Error 404" title="No encontramos esta página" />
        <StatusText muted last>
          Puede que el link esté mal copiado o que la página ya no exista.
        </StatusText>
        <StatusLink href="/">Ir al inicio</StatusLink>
      </AuthShell>
    );
  }
  return (
    <div className={`${s.card} ${s.empty}`}>
      <p className={s.eyebrow}>Error 404</p>
      <h1 className={s.h1}>No encontramos ese perfil</h1>
      <p className={s.lead}>
        Puede que el link esté mal copiado o que el profesional o el consultorio ya no estén publicados en el
        directorio.
      </p>
      <ul className={s.emptyList} role="list">
        <li>
          <ButtonLink href="/profesionales" variant="primary" size="md">
            Ver profesionales
          </ButtonLink>
        </li>
        <li>
          <ButtonLink href="/" variant="ghost" size="md">
            Ir al inicio
          </ButtonLink>
        </li>
      </ul>
    </div>
  );
}
