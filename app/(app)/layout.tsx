import { TweaksProvider } from "@/components/layout/tweaks-context";
import { AppShell } from "@/components/layout/app-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <TweaksProvider>
      <AppShell>{children}</AppShell>
    </TweaksProvider>
  );
}
