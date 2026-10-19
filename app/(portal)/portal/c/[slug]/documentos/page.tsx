import Link from "next/link";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { getPortalUser, requirePortalPatient } from "@/lib/portal-identity-internal";
import { listPortalDocuments } from "@/lib/portal-documents-internal";
import { resolveSlugAlias } from "@/lib/public-booking-internal";
import { portalSectionsFor } from "@/lib/portal-nav";
import { PORTAL_DOCUMENTS_COPY as COPY } from "@/lib/portal-copy";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { PortalTabs } from "@/components/portal/portal-tabs";
import { BRAND_NAME } from "@/lib/brand";

/*
 * T4 (FC-4a, C-FC8) · «Documentos»: lo que el profesional compartió con el paciente (la foto ya impresa, nunca la
 * historia clínica). Server, +0 kB de cliente (§24.9): la lista son links y nada más.
 *
 * Gate: `requirePortalPatient(slug)` (vínculo por userId; staff, ficha sin vincular o archivada, consultorio ajeno →
 * 404, sin distinguir «no existe» de «no es tuyo»). `documentos` es CORE (`portalSectionsFor`), y la lectura vuelve a
 * mirar la sección: una sola fuente con el nav.
 * Sin sesión (o con el email sin verificar) → al ingreso del portal con `?c=`: es adonde llega el CTA del mail «Tenés
 * un documento nuevo», y un 404 con la sesión vencida diría «no existe» (lección de P4.Z en «Cuenta»). Es redirect y
 * no una tarjeta «ok» para que la página nunca devuelva un árbol sin un paciente detrás (matriz del portal).
 * `force-dynamic`: PHI, nada de cache (brief ES4 §6).
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  // Sin títulos de documentos en la pestaña del navegador: quedan en el historial.
  return { title: `${COPY.title} · ${params.slug} · ${BRAND_NAME}` };
}

export default async function PortalDocumentsPage({ params }: { params: { slug: string } }) {
  const ref = await requirePortalPatient(params.slug);
  if (!ref) {
    // FC-4i: `&n=documentos` → después de entrar vuelve a «Documentos» (allow-list en lib/portal-nav.ts).
    if (!(await getPortalUser())) redirect(`/portal?c=${encodeURIComponent(params.slug)}&n=documentos`);
    // BO2-D: slug viejo → 308 al vigente, solo si el paciente está vinculado allá (misma regla que /c/<slug>).
    const moved = await resolveSlugAlias(params.slug);
    if (moved && (await requirePortalPatient(moved.slug))) {
      permanentRedirect(`/portal/c/${encodeURIComponent(moved.slug)}/documentos`);
    }
    notFound();
  }

  const docs = await listPortalDocuments(ref);
  const slug = encodeURIComponent(ref.tenant.slug);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Link
        href="/portal"
        className="k-link"
        style={{ fontSize: 14, display: "inline-flex", alignItems: "center", minHeight: 44, alignSelf: "flex-start" }}
      >
        ← Mis consultorios
      </Link>

      <header>
        <Tag tone="lime">{ref.tenant.name}</Tag>
        <h1 className="k-display" style={{ fontSize: 26, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          {COPY.title}
        </h1>
        {/* Un solo vacío (criterio de ES4-Z): sin documentos, el texto va en la tarjeta y no en el encabezado. */}
        {docs.length > 0 && <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>{COPY.lead(ref.tenant.name)}</p>}
      </header>

      <PortalTabs slug={ref.tenant.slug} sections={portalSectionsFor(ref.modules)} active="documentos" />

      {docs.length === 0 ? (
        <Card glass style={{ padding: 22 }}>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>{COPY.empty(ref.tenant.name)}</p>
        </Card>
      ) : (
        <ul aria-label={COPY.listLabel} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {docs.map((d) => (
            <li key={d.id}>
              {/* Toda la tarjeta es el link (44 px de alto mínimo, criterio AA de VX §5). */}
              <Link
                href={`/portal/c/${slug}/documentos/${encodeURIComponent(d.id)}`}
                style={{ display: "block", textDecoration: "none", color: "inherit" }}
              >
                <Card glass style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 12, minHeight: 44 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--navy-900)", overflowWrap: "anywhere" }}>
                      {d.title}
                    </p>
                    <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "2px 0 0" }}>
                      {COPY.dateOf(d.occurredAt)} · {COPY.sharedOn(d.sharedAt)}
                    </p>
                  </div>
                  <span aria-hidden style={{ fontSize: 14, fontWeight: 600, color: "var(--sky-700)" }}>
                    {COPY.open} →
                  </span>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
