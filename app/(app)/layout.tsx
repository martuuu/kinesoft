import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { headers } from "next/headers";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { AppShell } from "@/components/layout/app-shell";
import { tryGetActor } from "@/lib/session";
import { getUserPreferences } from "@/lib/preferences";
import { runWithRls } from "@/lib/rls";
import { safeNext } from "@/lib/safe-next";
import { decideAppGate } from "@/lib/onboarding-logic";
import { getSessionUser } from "@/lib/onboarding-internal";
import { modulesFor } from "@/lib/tenant-modules";
import { capabilitiesFor } from "@/lib/capabilities";
import { realtimeBootstrap } from "@/lib/realtime-bootstrap";

/**
 * Guard for the entire authenticated workspace. Renders the AppShell only
 * when there is a valid actor. The demo fallback
 * (`KINESOFT_ALLOW_DEMO_ACTOR=1`) is honoured by `tryGetActor` itself so
 * local dev keeps working without Supabase.
 *
 * A3c-S-signup — adónde va cada caso (lógica pura en `decideAppGate`):
 *   - sin sesión → `/login?next=<path>`;
 *   - sesión verificada sin membresía → `/onboarding` (ahí se ofrece primero
 *     la invitación pendiente, si la hay; si no, el alta del consultorio);
 *   - OWNER con `Tenant.onboardingCompletedAt == null` → `/onboarding`.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await tryGetActor();

  let gate: string | null;
  // Rol de la membresía activa: ya se lee para el gate de onboarding; se
  // reusa para las capabilities del nav (EV-S) sin otra query.
  let role: Role | null = null;
  if (!actor) {
    const user = await getSessionUser();
    // El layout no recibe el pathname: lo lee de `x-pathname` si el
    // middleware lo expone (handoff a A3b-S-auth / integrador). safeNext lo
    // deja pasar solo si es un path propio, así que un header forjado por el
    // cliente no abre un open redirect.
    const rawPath = headers().get("x-pathname");
    gate = decideAppGate({
      hasSession: !!user,
      hasActor: false,
      role: null,
      onboardingCompleted: false,
      nextPath: rawPath ? safeNext(rawPath, "") || null : null,
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
      hasSession: true,
      hasActor: true,
      role: t.role,
      onboardingCompleted: t.completed,
      nextPath: null,
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
      >
        {children}
      </AppShell>
    </TweaksProvider>
  );
}
