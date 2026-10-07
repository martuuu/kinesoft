import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/session";
import { PlatformNav } from "@/components/plataforma/platform-nav";

/**
 * Guard for the platform-superadmin "Plataforma" panel. `requireSuperAdmin`
 * throws `ForbiddenError` for a non-admin actor (and `UnauthenticatedError`
 * with no session, though the parent (app) layout already redirects those).
 * Either way, non-admins land on /dashboard.
 *
 * [EV0-P2] El shell suma la sub-nav de Plataforma (Resumen · Consultorios ·
 * Ejercicios · Tags · Catálogo global). Va después del guard: un no-admin no
 * llega a ver ni el esqueleto de la sección. Las secciones con nav propia
 * (Catálogo → `CatalogTabs`) la conservan debajo.
 */
export default async function PlataformaLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireSuperAdmin();
  } catch {
    redirect("/dashboard");
  }
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <PlatformNav />
      <div>{children}</div>
    </div>
  );
}
