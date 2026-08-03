import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/session";

/**
 * Guard for the platform-superadmin "Plataforma" panel. `requireSuperAdmin`
 * throws `ForbiddenError` for a non-admin actor (and `UnauthenticatedError`
 * with no session, though the parent (app) layout already redirects those).
 * Either way, non-admins land on /dashboard.
 */
export default async function PlataformaLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireSuperAdmin();
  } catch {
    redirect("/dashboard");
  }
  return <>{children}</>;
}
