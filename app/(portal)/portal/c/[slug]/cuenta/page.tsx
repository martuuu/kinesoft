import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getPortalAccountPage } from "@/lib/portal-account";
import { requirePortalPatient } from "@/lib/portal-identity-internal";
import { resolveSlugAlias } from "@/lib/public-booking-internal";
import { Tag } from "@/components/ui/tag";
import { AccountStatement } from "@/components/portal/account-statement";
import { BRAND_NAME } from "@/lib/brand";

// PHI y plata del paciente: siempre por request, nunca cacheado (brief ES4 §6).
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  return { title: `Estado de cuenta · ${params.slug} · ${BRAND_NAME}` };
}

/*
 * ES4 S24p. «Cuenta» existe en las dos verticales (`portalSectionsFor`: siempre; ES4-D11): en Clínica general muestra
 * solo los turnos sueltos. Sin vínculo con este consultorio (sin sesión, staff, ficha sin vincular o archivada) → 404,
 * el mismo que un consultorio ajeno: la página no confirma que la ficha exista.
 */
export default async function PortalAccountPageRoute({ params }: { params: { slug: string } }) {
  const data = await getPortalAccountPage(params.slug);
  if (!data) {
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

      <AccountStatement account={data.account} vertical={data.vertical} showPlans={data.showPlans} nowMs={Date.now()} />
    </div>
  );
}
