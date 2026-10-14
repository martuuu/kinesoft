import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { headers } from "next/headers";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { AppShell } from "@/components/layout/app-shell";
import { getAccessSnapshot, tryGetActor } from "@/lib/session";
import { getTenantChoiceState } from "@/lib/tenant-choice";
import { switchTenant } from "@/lib/tenant-switch";
import { getUserPreferences } from "@/lib/preferences";
import { runWithRls } from "@/lib/rls";
import { safeNext } from "@/lib/safe-next";
import { decideAppGate } from "@/lib/onboarding-logic";
import { modulesFor } from "@/lib/tenant-modules";
import { capabilitiesFor } from "@/lib/capabilities";
import { realtimeBootstrap } from "@/lib/realtime-bootstrap";

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
 *   - OWNER con `Tenant.onboardingCompletedAt == null` → `/onboarding`.
 * Ningún destino está dentro de `(app)`, así que el gate no se puede rebotar a sí mismo.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await tryGetActor();
  // Misma foto que usó `tryGetActor` (cache por request): un solo `auth.getUser()` y una sola lectura de
  // membresías. null = sin sesión (o actor demo).
  const choice = await getTenantChoiceState();
  const snapshot = await getAccessSnapshot();

  // El layout no recibe el pathname: lo lee de `x-pathname`, que el middleware
  // pisa en cada request. safeNext lo deja pasar solo si es un path propio, así
  // que un header forjado por el cliente no abre un open redirect.
  const rawPath = headers().get("x-pathname");
  const nextPath = rawPath ? safeNext(rawPath, "") || null : null;

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
    });
  } else {
    const t = await runWithRls(actor.tenantId, async (tx) => {
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
      // Sin foto (actor demo) no hay elección posible.
      needsChoice: !!snapshot && choice.needsChoice,
      role: t.role,
      onboardingCompleted: t.completed,
      nextPath,
    });
  }
  if (gate) redirect(gate);
  if (!actor) redirect("/login");

  // Seed the Tweaks context with the user's persisted agenda preferences so
  // the week view + the Tweaks panel render the right state on first paint.
  const prefs = await getUserPreferences();
  // EV0 (EV-S): módulos del consultorio (vertical × plan × turnero, de
  // `actor.entitlements`) y capabilities del rol para filtrar el nav. Arrays y
  // no Sets porque cruzan al AppShell cliente. Solo UI: la barrera es
  // `assertModule`/`requireCapability` en cada action.
  const modules = Array.from(modulesFor(actor.entitlements));
  const capSet = capabilitiesFor(role);
  const caps = Array.from(capSet);
  // SV07b: qué driver realtime usa este actor (off/local/supabase) y, con
  // supabase, la URL y la anon key públicas. Se le pasan las caps ya calculadas
  // para no releer la membresía; el token del canal lo pide el cliente aparte.
  const realtime = await realtimeBootstrap(actor, capSet);
  // SV11b (SV-D9): a quién se le avisa. Llegada → quien ATIENDE: todo Actor
  // tiene `practitionerId` (también la Secretaria y BILLING), así que «atiende»
  // = rol clínico (`clinical.read`: OWNER/ADMIN/PRACTITIONER). Llamado → quien
  // opera la agenda de todos. Las prefs salen de `agendaPrefs` ya sanitizadas.
  const alertViewer = {
    practitionerId: capSet.has("clinical.read") ? actor.practitionerId : null,
    canOperateAll: capSet.has("agenda.operateAll"),
  };
  const initialAlertPrefs = {
    arrivalAlert: prefs.agendaView.arrivalAlert,
    callAlert: prefs.agendaView.callAlert,
  };
  return (
    <TweaksProvider
      initialAgenda={{
        agendaShowWeekHeader: prefs.agendaShowWeekHeader,
        agendaShowSaturday: prefs.agendaShowSaturday,
        agendaShowSunday: prefs.agendaShowSunday,
      }}
    >
      <AppShell
        isPlatformAdmin={actor.isPlatformAdmin}
        modules={modules}
        caps={caps}
        realtime={realtime}
        alertViewer={alertViewer}
        initialAlertPrefs={initialAlertPrefs}
        // IAM-3b (decisión 6: un usuario, varios consultorios): el selector del sidebar usa la MISMA foto que el
        // gate (`getTenantChoiceState` de arriba, cache por request): ninguna query más. Solo los consultorios
        // usables de esta sesión. El activo es el del Actor (lo que la app está mostrando).
        tenantOptions={choice.options}
        activeTenantId={actor.tenantId}
        switchTenantAction={switchTenant}
      >
        {children}
      </AppShell>
    </TweaksProvider>
  );
}
