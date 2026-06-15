import { redirect } from "next/navigation";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { AppShell } from "@/components/layout/app-shell";
import { tryGetActor } from "@/lib/session";
import { getUserPreferences } from "@/lib/preferences";

/**
 * Guard for the entire authenticated workspace. Renders the AppShell only
 * when there is a valid actor; otherwise redirects to `/login`. The demo
 * fallback (`KINESOFT_ALLOW_DEMO_ACTOR=1`) is honoured by `tryGetActor`
 * itself so local dev keeps working without Supabase.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await tryGetActor();
  if (!actor) redirect("/login");
  // Seed the Tweaks context with the user's persisted agenda preferences so
  // the week view + the Tweaks panel render the right state on first paint.
  const prefs = await getUserPreferences();
  return (
    <TweaksProvider
      initialAgenda={{
        agendaShowWeekHeader: prefs.agendaShowWeekHeader,
        agendaShowSaturday: prefs.agendaShowSaturday,
        agendaShowSunday: prefs.agendaShowSunday,
      }}
    >
      <AppShell>{children}</AppShell>
    </TweaksProvider>
  );
}
