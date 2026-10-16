import { redirect } from "next/navigation";
import type { Viewport } from "next";
import type { Role } from "@prisma/client";
import { headers } from "next/headers";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { UIProviders } from "@/components/providers/ui-providers";
import type { Palette } from "@/lib/preferences-constants";
import { AppShell } from "@/components/layout/app-shell";
import { getAccessSnapshot, getSessionBlock, tryGetActor } from "@/lib/session";
import { tenantAccessEnforcement } from "@/lib/env";
import { AccessBanner, bannerAudienceFor } from "@/components/layout/access-banner";
import { ReadOnlyWriteGuard } from "@/components/layout/read-only-write-guard";
import { canWrite, effectiveMode } from "@/lib/tenant-access";
import { SupportBanner } from "@/components/layout/support-banner";
import { shellTenantChoice } from "@/components/layout/shell-tenant-choice";
import { endSupport } from "@/lib/platform-support";
import { getTenantChoiceState } from "@/lib/tenant-choice";
import { switchTenant } from "@/lib/tenant-switch";
import { getUserPreferences } from "@/lib/preferences";
import { runWithRls } from "@/lib/rls";
import { safeNext } from "@/lib/safe-next";
import { decideAppGate } from "@/lib/onboarding-logic";
import { modulesFor } from "@/lib/tenant-modules";
import { capabilitiesForActor } from "@/lib/authz";
import { realtimeBootstrap } from "@/lib/realtime-bootstrap";

/**
 * MB-0b (C-MB5, MB-D13): `viewportFit: "cover"` SOLO en el workspace: la barra inferior (C-MB1) necesita que
 * `env(safe-area-inset-bottom)` valga lo que mide el indicador de inicio del iPhone (sin `cover` vale 0 y la barra
 * queda debajo). Las superficies públicas siguen con el viewport del root. Nunca `maximumScale`/`userScalable`: el
 * zoom al 200 % es requisito de accesibilidad.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1F4FBE",
};

/**
 * Guard for the entire authenticated workspace. Renders the AppShell only
 * when there is a valid actor. The demo fallback
 * (`KINESOFT_ALLOW_DEMO_ACTOR=1`) is honoured by `tryGetActor` itself so
 * local dev keeps working without Supabase.
 *
 * A3c-S-signup / IAM-3a — adónde va cada caso (lógica pura en `decideAppGate`):
 *   - sin sesión → `/login?next=<path>`;
 *   - sesión sin ninguna membresía → `/onboarding` (ahí se ofrece primero
 *     la invitación pendiente, si la hay; si no, el alta del consultorio);
 *   - membresías pero ninguna usable → `/sin-acceso` (antes `/onboarding`, que
 *     rebotaba a /dashboard: bucle del 14-oct);
 *   - 2+ consultorios usables sin cookie válida → `/elegir-consultorio?next=`
 *     (decisión 6: se pregunta en cada login);
 *   - OWNER con `Tenant.onboardingCompletedAt == null` → `/onboarding`;
 *   - BO1-A: usuario deshabilitado → `/cuenta-desactivada`; consultorio suspendido
 *     o dado de baja sin otro usable → `/suspendido` (con otro usable entra a ese).
 *   - PL-1e (C-PL6): 2FA prendida y sin pasar en esta sesión → `/verificar-acceso?next=<path>`
 *     (sin Actor: `getActor` tira `two_factor`; el estado sale de la misma foto, sin queries).
 * Ningún destino está dentro de `(app)`, así que el gate no se puede rebotar a sí mismo.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await tryGetActor();
  // PF-0b: las preferencias dependen solo del actor: se piden YA, en paralelo con el gate (antes iban en serie
  // después del gate y del tx de tenant+rol). Si el gate redirige, la lectura se descarta; el `catch` vacío solo
  // evita el «unhandled rejection» en ese caso: el `await` de abajo vuelve a tirar el error si se usa.
  const prefsP = actor ? getUserPreferences() : null;
  prefsP?.catch(() => {});
  // Misma foto que usó `tryGetActor` (cache por request): una sola verificación de la sesión y una sola lectura de
  // membresías; las tres salen de esa foto sin queries. null = sin sesión (o actor demo).
  // BO1-A: `block` = usuario deshabilitado / consultorio suspendido o dado de baja.
  const [choice, snapshot, block] = await Promise.all([getTenantChoiceState(), getAccessSnapshot(), getSessionBlock()]);

  // El layout no recibe el pathname: lo lee de `x-pathname`, que el middleware
  // pisa en cada request. safeNext lo deja pasar solo si es un path propio, así
  // que un header forjado por el cliente no abre un open redirect.
  const rawPath = headers().get("x-pathname");
  const nextPath = rawPath ? safeNext(rawPath, "") || null : null;

  // PL-1e: misma foto; con la 2FA pendiente no hay Actor (`resolveActor` corta antes), así que cae en la rama `!actor`.
  const twoFactorRequired = snapshot?.twoFactor.state === "required";
  let gate: string | null;
  // Rol de la membresía activa: ya se lee para el gate de onboarding; se
  // reusa para las capabilities del nav (EV-S) sin otra query.
  let role: Role | null = null;
  if (!actor) {
    gate = decideAppGate({
      hasSession: !!snapshot,
      hasActor: false,
      access: snapshot?.state ?? null,
      needsChoice: false,
      role: null,
      onboardingCompleted: false,
      nextPath,
      block: block?.kind ?? null,
      twoFactorRequired,
    });
  } else {
    // PF-0b: el rol y `onboardingCompletedAt` del consultorio activo ya están en la foto (la misma fila de
    // Membership + Tenant de la que salió el actor, leída en este request): sin tx (eran 4 idas y vueltas en serie
    // en cada página). Soporte (sin membresía en el destino) y el actor demo (sin foto) siguen leyéndolos.
    const fromSnapshot = !actor.support ? snapshot?.memberships.find((m) => m.tenantId === actor.tenantId) : undefined;
    const t = fromSnapshot
      ? { completed: !!fromSnapshot.tenant.onboardingCompletedAt, role: fromSnapshot.role }
      : await runWithRls(actor.tenantId, async (tx) => {
          const [tenant, m] = await Promise.all([
            tx.tenant.findUnique({ where: { id: actor.tenantId }, select: { onboardingCompletedAt: true } }),
            tx.membership.findUnique({
              where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
              select: { role: true },
            }),
          ]);
          return { completed: !!tenant?.onboardingCompletedAt, role: m?.role ?? null };
        });
    role = t.role;
    gate = decideAppGate({
      hasSession: !!snapshot,
      hasActor: true,
      access: snapshot?.state ?? null,
      // Sin foto (actor demo) no hay elección posible. BO2-E: el soporte ya eligió consultorio al entrar (la
      // cookie de soporte gana sobre la de consultorio); pedirle elegir lo mandaría a su consultorio propio.
      needsChoice: !!snapshot && choice.needsChoice && !actor.support,
      role: t.role,
      onboardingCompleted: t.completed,
      nextPath,
      // BO2-E: los bloqueos de la foto son los del consultorio PROPIO del superadmin (o su usuario); el destino de
      // soporte suspendido igual se puede mirar (la banda muestra su acceso real y todo va en solo lectura).
      block: actor.support ? null : (block?.kind ?? null),
      // Red: con Actor no debería estar pendiente (se corta antes de armarlo), pero si una carrera lo dejara, manda.
      twoFactorRequired,
    });
  }
  if (gate) redirect(gate);
  if (!actor) redirect("/login");

  // PL-F (handoff 8): con la barra superior el dashboard esconde su `ProfileMenu`, así que el switch «Aparezco en el
  // turnero online» del propio profesional también va en el menú de cuenta del topbar. Se lee una vez acá, solo si
  // el actor tiene ficha (misma query que `lib/dashboard.ts`); el soporte no tiene ficha propia en el destino.
  // PF-Z (`layout-app-tx-en-serie`): arranca en paralelo con las preferencias; antes esperaba a que terminaran y
  // sumaba una ida y vuelta a la base al primer byte de TODAS las páginas.
  let practitionerId: string | null = null;
  if (!actor.support) practitionerId = actor.practitionerId;
  const ownPublicBookingP = practitionerId
    ? runWithRls(actor.tenantId, (tx) =>
        tx.practitioner.findFirst({
          where: { id: practitionerId, tenantId: actor.tenantId },
          select: { id: true, publicBookingEnabled: true },
        })
      ).then((p) => (p ? { practitionerId: p.id, enabled: p.publicBookingEnabled } : null))
    : Promise.resolve(null);
  // Seed the Tweaks context with the user's persisted agenda preferences so
  // the week view + the Tweaks panel render the right state on first paint.
  // `actor` no es null acá (redirect de arriba), así que `prefsP` tampoco.
  const [prefs, ownPublicBooking] = await Promise.all([prefsP ?? getUserPreferences(), ownPublicBookingP]);
  // EV0 (EV-S): módulos del consultorio (vertical × plan × turnero, de
  // `actor.entitlements`) y capabilities del rol para filtrar el nav. Arrays y
  // no Sets porque cruzan al AppShell cliente. Solo UI: la barrera es
  // `assertModule`/`requireCapability` en cada action.
  const modules = Array.from(modulesFor(actor.entitlements));
  // BO2-E: el soporte no tiene membresía: sus capacidades son `SUPPORT_CAPS` (Secretaria sin clínico +
  // Configuración). PL-1 (H-PL1, H1b-16): para un miembro, por MIEMBRO (rol + si atiende + delegaciones, de
  // `Actor.membership`, sin query): con `capabilitiesFor(role)` un Titular sin agenda veía el nav clínico y una
  // Secretaria con «Configuración» no lo veía. Es la misma función que usan las actions.
  const capSet = await capabilitiesForActor(actor);
  const caps = Array.from(capSet);
  // SV07b: qué driver realtime usa este actor (off/local/supabase) y, con
  // supabase, la URL y la anon key públicas. Se le pasan las caps ya calculadas
  // para no releer la membresía; el token del canal lo pide el cliente aparte.
  const realtime = await realtimeBootstrap(actor, capSet);
  // SV11b (SV-D9): a quién se le avisa. Llegada → quien ATIENDE = rol clínico
  // (`clinical.read`: OWNER/ADMIN/PRACTITIONER). Desde IAM-4a la Secretaria y
  // BILLING ya llegan con `practitionerId` null; el chequeo de `clinical.read`
  // queda como red. Llamado → quien opera la agenda de todos. Las prefs salen
  // de `agendaPrefs` ya sanitizadas.
  const alertViewer = {
    practitionerId: capSet.has("clinical.read") ? actor.practitionerId : null,
    canOperateAll: capSet.has("agenda.operateAll"),
  };
  const initialAlertPrefs = {
    arrivalAlert: prefs.agendaView.arrivalAlert,
    callAlert: prefs.agendaView.callAlert,
  };
  const shellChoice = shellTenantChoice(!!actor.support, choice.options, switchTenant);
  const enforcement = tenantAccessEnforcement();
  return (
    <UIProviders>
      {/* VX F-d: paleta sin flash. Corre antes del primer pintado del shell (está antes en el HTML) y pone
          `data-palette` en <html> con la misma precedencia que `hydrateTweaks`; sin esto, una paleta distinta de sky
          pintaba sky hasta que hidrataba `TweaksProvider`. */}
      <script dangerouslySetInnerHTML={{ __html: paletteScript(prefs.palette) }} />
      <TweaksProvider
        initialAgenda={{
          agendaShowWeekHeader: prefs.agendaShowWeekHeader,
          agendaShowSaturday: prefs.agendaShowSaturday,
          agendaShowSunday: prefs.agendaShowSunday,
        }}
        // PL-F1c: la paleta guardada en el server manda desde el primer render (antes solo la aplicaba el dashboard
        // al montarse, y pisaba lo elegido en Tweaks).
        initialPalette={prefs.palette}
        // RX-0 (C-RX2): cara de /sala (`agendaPrefs.receptionLayout`, ya sanitizada) para que Apariencia y el
        // escritorio arranquen con la elegida, sin flash.
        initialReceptionLayout={prefs.agendaView.receptionLayout}
      >
        <AppShell
          isPlatformAdmin={actor.isPlatformAdmin}
          // PL-F1c: avatar y menú de cuenta de la barra superior. `practitionerName` ya pasa por `displayUserName`
          // (nunca el email, decisión 19).
          userName={actor.practitionerName}
          ownPublicBooking={ownPublicBooking}
          modules={modules}
          vertical={actor.entitlements.vertical}
          caps={caps}
          realtime={realtime}
          alertViewer={alertViewer}
          initialAlertPrefs={initialAlertPrefs}
          // IAM-3b (decisión 6: un usuario, varios consultorios): el selector del sidebar usa la MISMA foto que el
          // gate (`getTenantChoiceState` de arriba, cache por request): ninguna query más. Solo los consultorios
          // usables de esta sesión. El activo es el del Actor (lo que la app está mostrando).
          // BO3-F: en soporte, sin selector (porqué en `shellTenantChoice`).
          tenantOptions={shellChoice.options}
          activeTenantId={actor.tenantId}
          switchTenantAction={shellChoice.switchAction}
          banner={
            actor.support ? <SupportBanner tenantName={actor.tenantName} endSupportAction={endSupport} /> : null
          }
        >
          {/* BO1-A: prueba por vencer, gracia o solo lectura (modo REAL; visible con `banner`/`enforce`). BO3-F: en
              soporte habla en tercera persona del consultorio (el superadmin no es el titular) y suma suspendido/baja,
              que el soporte sí puede mirar. */}
          {/* BO-Z B4: el llamado a escribir a soporte es para titular/admin; el resto lee «Avisale al titular». */}
          <AccessBanner
            access={actor.access}
            enforcement={enforcement}
            support={!!actor.support}
            audience={bannerAudienceFor(role)}
          />
          {/* BO-Z B10: red de escrituras rechazadas en solo lectura REAL (modo efectivo). En soporte no: ya la monta la
              banda de soporte con su propio copy. */}
          {!actor.support && !canWrite(effectiveMode(actor.access.mode, enforcement)) && <ReadOnlyWriteGuard />}
          {children}
        </AppShell>
      </TweaksProvider>
    </UIProviders>
  );
}

/**
 * VX F-d: script inline de paleta sin flash. MISMAS claves y valores que `components/layout/tweaks-context.tsx`
 * (`STORAGE_KEY` = "kinesoft:tweaks", `PALETTES`, default "sky") y la misma precedencia que `hydrateTweaks`: la
 * paleta del server (`UserPreferences.palette`) gana; si no hay, la de `localStorage`; si no, sky. Todo en
 * `try/catch`: con el storage bloqueado (Safari privado) o el JSON roto queda la del server o sky, nunca un error.
 * Si cambia una clave o una paleta en `tweaks-context.tsx`, se cambia acá también.
 * La paleta del server es un valor del enum; igual pasa por la lista y por `JSON.stringify` (no se concatena texto
 * libre dentro de un <script>). `<html>` necesita `suppressHydrationWarning` en el root: este script le agrega el
 * atributo antes de que React hidrate.
 */
const PALETTE_VALUES: readonly Palette[] = ["sky", "mint", "coral", "violet"];

function paletteScript(serverPalette: Palette | null | undefined): string {
  const server = serverPalette && PALETTE_VALUES.includes(serverPalette) ? serverPalette : null;
  return (
    "(function(){var P=" +
    JSON.stringify(PALETTE_VALUES) +
    ";var p=" +
    JSON.stringify(server) +
    ';if(!p){try{var r=JSON.parse(window.localStorage.getItem("kinesoft:tweaks")||"null");' +
    "if(r&&P.indexOf(r.palette)>=0)p=r.palette}catch(e){}}" +
    'try{document.documentElement.setAttribute("data-palette",p||"sky")}catch(e){}})();'
  );
}
