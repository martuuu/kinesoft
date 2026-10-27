/**
 * IN (§27): «Tu sesión se cerró por inactividad». La pinta `/login?reason=idle` cuando la cookie `kine_idle` de la
 * sesión ACTUAL venció (con la gracia de 60 s): típicamente la PC compartida que se cerró sin cerrar sesión y Chrome
 * restauró la pestaña («Continuar donde lo dejaste» restaura también las cookies de sesión). El layout `(app)` redirige
 * acá antes de cualquier loader (no la pinta él: ver el porqué en `app/(app)/layout.tsx`), así que en esta pantalla no
 * hay ni un dato del consultorio ni de pacientes, ni el nombre del usuario.
 *
 * Server component sin JS propio: el form POST a `/api/auth/sign-out` (`idleSignOutAction`, Origin propio) se envía
 * solo con un `<script>` inline (la CSP de las páginas de auth ya permite `'unsafe-inline'` por el bootstrap de RSC);
 * sin JS queda el botón «Ingresar de nuevo», que hace lo mismo. Un client component sumaría bytes al first load del
 * login (grupo `public` del bundle) para una pantalla que casi nunca se ve. Nada de framer ni primitivas de overlay
 * (guard `public-surface-imports`).
 */
import { AuthShell } from "@/components/auth/auth-shell";
import { StatusHeading, StatusText } from "@/app/plataforma-mfa/shared";
import { Button } from "@/components/ui/button";
import { idleSignOutAction } from "@/lib/idle-logout";

export const IDLE_EXPIRED_FORM_ID = "idle-expired-form";

export function IdleExpired({ minutes, nextPath }: { minutes: number; nextPath?: string | null }) {
  return (
    <AuthShell variant="centered" introAs="p">
      <div data-testid="idle-expired">
        <StatusHeading title="Tu sesión se cerró por inactividad" />
        <StatusText muted last>
          Para proteger los datos de tus pacientes, la cerramos después de {minutes} minutos sin uso.
        </StatusText>
        <form id={IDLE_EXPIRED_FORM_ID} action={idleSignOutAction(nextPath)} method="post">
          <Button type="submit" variant="primary" size="md" block data-testid="idle-expired-submit">
            Ingresar de nuevo
          </Button>
        </form>
        <script
          // Id fijo, sin datos de la request: nada que escapar.
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var f=document.getElementById(${JSON.stringify(IDLE_EXPIRED_FORM_ID)});if(f)f.submit()}catch(e){}})();`,
          }}
        />
      </div>
    </AuthShell>
  );
}
