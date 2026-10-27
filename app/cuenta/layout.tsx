import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { UIProviders } from "@/components/providers/ui-providers";
import { idleLoginHref, readIdleShellState } from "@/lib/idle-logout-internal";
import { safeNext } from "@/lib/safe-next";

/**
 * VX F-d (C-F3): `UIProviders` (motion + toast + confirm) ya no vive en el root. `/cuenta/seguridad` lo necesita:
 * usa `useToast`/`useConfirm` y el `StepUpModal` (`components/account/security-settings.tsx`), y esos hooks tiran
 * sin provider. Los guards de sesión siguen en cada página.
 *
 * PV-Z (ZA M2): cierre por inactividad (IN, §27). `/cuenta/*` cuelga del root, no de `(app)`, así que el redirect del
 * layout `(app)` no lo cubría: con la cookie `kine_idle` de ESTA sesión vencida, la PC compartida que Chrome reabrió
 * seguía entrando a «Seguridad» y al perfil público. Mismo corte que `(app)`: redirect al login por inactividad
 * (que pinta `IdleExpired` y cierra la sesión) ANTES de renderizar; `redirect()` corta también los loaders de la
 * página hija (ver el comentario de `app/(app)/layout.tsx`). `x-pathname` lo pisa el middleware en cada request y
 * `safeNext` descarta lo que no sea un path propio.
 */
export default async function CuentaLayout({ children }: { children: React.ReactNode }) {
  const idle = await readIdleShellState();
  if (idle.kind === "expired") {
    const raw = headers().get("x-pathname");
    redirect(idleLoginHref(raw ? safeNext(raw, "") || null : null));
  }
  return <UIProviders>{children}</UIProviders>;
}
