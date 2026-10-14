import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { PlatformNav } from "@/components/plataforma/platform-nav";

/**
 * Guard del panel "Plataforma". BO2-F: `requirePlatformAdmin` (C-BO2) en vez de
 * `requireSuperAdmin`: no pasa por `buildActor` (no necesita un consultorio «casa»)
 * y rechaza al superadmin deshabilitado. Tira `ForbiddenError` a un no-admin (y
 * `UnauthenticatedError` sin sesión, aunque el layout (app) ya redirige esos).
 * En los dos casos, el no-admin cae en /dashboard.
 *
 * [EV0-P2] El shell suma la sub-nav de Plataforma (Resumen · Consultorios ·
 * Ejercicios · Tags · Catálogo global). Va después del guard: un no-admin no
 * llega a ver ni el esqueleto de la sección. Las secciones con nav propia
 * (Catálogo → `CatalogTabs`) la conservan debajo.
 */
export default async function PlataformaLayout({ children }: { children: React.ReactNode }) {
  try {
    await requirePlatformAdmin();
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
