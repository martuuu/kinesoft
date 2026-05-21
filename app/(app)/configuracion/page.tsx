import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { getTenantSettings } from "@/lib/tenant-settings";
import { listInsurers } from "@/lib/insurers";
import { listServicesWithCounts } from "@/lib/services";
import { listTeamMembers, listPendingInvitations } from "@/lib/invitations";
import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Configuración · KineSoft" };

/**
 * /configuracion — Subscriber control panel.
 *
 * Restricted to OWNER + ADMIN. PRACTITIONER users get a redirect to
 * /dashboard since they can't act on any of these forms anyway (the
 * server actions also enforce role independently).
 */
export default async function ConfiguracionPage() {
  const actor = await getActor();
  const membership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
  if (!membership || (membership.role !== "OWNER" && membership.role !== "ADMIN")) {
    redirect("/dashboard");
  }

  const [tenant, insurers, services, team, pending, practitioners] = await Promise.all([
    getTenantSettings(),
    listInsurers(),
    listServicesWithCounts(),
    listTeamMembers(),
    listPendingInvitations(),
    prisma.practitioner.findMany({
      where: { tenantId: actor.tenantId },
      include: { user: { select: { fullName: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <ConfiguracionClient
      role={membership.role}
      tenant={tenant}
      insurers={insurers}
      services={services}
      team={team}
      pending={pending}
      practitioners={practitioners.map((p) => ({
        id: p.id,
        name: p.user.fullName ?? p.user.email,
      }))}
    />
  );
}
