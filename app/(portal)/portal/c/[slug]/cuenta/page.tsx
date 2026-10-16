import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getPortalAccountPage } from "@/lib/portal-account";
import { getPortalUser, requirePortalPatient } from "@/lib/portal-identity-internal";
import { resolveSlugAlias } from "@/lib/public-booking-internal";
import { Tag } from "@/components/ui/tag";
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { IconArrow } from "@/components/ui/icons";
import { PortalTabs } from "@/components/portal/portal-tabs";
import { AccountStatement } from "@/components/portal/account-statement";
import { BRAND_NAME } from "@/lib/brand";

// PHI y plata del paciente: siempre por request, nunca cacheado (brief ES4 §6).
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  return { title: `Estado de cuenta · ${params.slug} · ${BRAND_NAME}` };
}

/*
 * ES4 S24p. «Cuenta» existe en las dos verticales (`portalSectionsFor`: siempre; ES4-D11): en Clínica general muestra
 * solo los turnos sueltos. Sin vínculo con este consultorio (staff, ficha sin vincular o archivada) → 404, el mismo
 * que un consultorio ajeno: la página no confirma que la ficha exista.
 * ES4 P4.Z (hallazgo S26p `portal-cuenta-sin-sesion-404`): SIN SESIÓN (o con el email sin verificar) ya no es 404 sino
 * el CTA a entrar, como `/ejercicios` y `/c/<slug>`: un paciente con la sesión vencida que abría el link de su estado
 * de cuenta veía «no existe». No confirma nada de la ficha: el CTA sale igual para cualquier slug.
 */
export default async function PortalAccountPageRoute({ params }: { params: { slug: string } }) {
  const data = await getPortalAccountPage(params.slug);
  if (!data) {
    // Solo en el camino sin datos (el normal no paga la lectura): `getPortalUser` está memoizado por request.
    if (!(await getPortalUser())) {
      return (
        <Card glass style={{ padding: 22, display: "grid", gap: 12, justifyItems: "start" }}>
          <p style={{ fontSize: 15, color: "var(--navy-500)", margin: 0 }}>Iniciá sesión para ver tu estado de cuenta.</p>
          <ButtonLink href={`/portal?c=${encodeURIComponent(params.slug)}`} variant="primary" size="md">
            Entrar con Google o con tu email <IconArrow size={14} />
          </ButtonLink>
        </Card>
      );
    }
    // BO2-D: slug viejo → 308 al vigente, solo si el paciente está vinculado allá (misma regla que /c/<slug>).
    const moved = await resolveSlugAlias(params.slug);
    if (moved && (await requirePortalPatient(moved.slug))) {
      permanentRedirect(`/portal/c/${encodeURIComponent(moved.slug)}/cuenta`);
    }
    notFound();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Link
        href={`/portal/c/${encodeURIComponent(params.slug)}`}
        className="k-link"
        style={{ fontSize: 14, display: "inline-flex", alignItems: "center", minHeight: 44, alignSelf: "flex-start" }}
      >
        ← Volver
      </Link>

      <header>
        <Tag tone="lime">{data.tenantName}</Tag>
        <h1 className="k-display" style={{ fontSize: 26, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          Estado de cuenta
        </h1>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
          Hola {data.firstName}. Acá ves lo que pagaste y lo que te queda por pagar en este consultorio.
        </p>
      </header>

      <PortalTabs slug={params.slug} sections={data.sections} active="cuenta" />

      <AccountStatement account={data.account} vertical={data.vertical} showPlans={data.showPlans} nowMs={Date.now()} />
    </div>
  );
}
