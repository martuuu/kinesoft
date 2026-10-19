import Link from "next/link";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { getPortalUser, requirePortalPatient } from "@/lib/portal-identity-internal";
import { getPortalDocument } from "@/lib/portal-documents-internal";
import { resolveSlugAlias } from "@/lib/public-booking-internal";
import { PORTAL_DOCUMENTS_COPY as COPY } from "@/lib/portal-copy";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { buttonClassName } from "@/components/ui/button";
import { HcPrintableView } from "@/components/hc/hc-printable-view";
import { BRAND_NAME } from "@/lib/brand";

/*
 * T4 (FC-4a, C-FC8) · un documento compartido, en pantalla desde el SNAPSHOT (`getPortalDocument`), no desde el PDF
 * ni desde la historia clínica. Server, +0 kB de cliente (§24.9).
 *
 * Mismo gate que la lista. Además, `getPortalDocument` devuelve null para un id ajeno, revocado, de otro consultorio
 * o con el snapshot ilegible → 404, el mismo para todo: la página no confirma que el documento exista.
 * La vista en pantalla no se audita (FC-D28); la descarga sí, en la ruta `…/pdf`.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  // El título del documento NO va en la pestaña: queda en el historial y en la lista de pestañas compartidas.
  return { title: `${COPY.title} · ${params.slug} · ${BRAND_NAME}` };
}

export default async function PortalDocumentPage({ params }: { params: { slug: string; id: string } }) {
  const ref = await requirePortalPatient(params.slug);
  if (!ref) {
    if (!(await getPortalUser())) redirect(`/portal?c=${encodeURIComponent(params.slug)}`);
    const moved = await resolveSlugAlias(params.slug);
    if (moved && (await requirePortalPatient(moved.slug))) {
      permanentRedirect(`/portal/c/${encodeURIComponent(moved.slug)}/documentos/${encodeURIComponent(params.id)}`);
    }
    notFound();
  }

  const doc = await getPortalDocument(ref, params.id);
  if (!doc) notFound();

  const base = `/portal/c/${encodeURIComponent(ref.tenant.slug)}/documentos`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Link
        href={base}
        className="k-link"
        style={{ fontSize: 14, display: "inline-flex", alignItems: "center", minHeight: 44, alignSelf: "flex-start" }}
      >
        {COPY.back}
      </Link>

      <header style={{ display: "grid", gap: 6, justifyItems: "start" }}>
        <Tag tone="lime">{ref.tenant.name}</Tag>
        <h1 className="k-display" style={{ fontSize: 24, margin: "4px 0 0", letterSpacing: "-0.02em", overflowWrap: "anywhere" }}>
          {doc.title}
        </h1>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>{COPY.sharedOn(doc.sharedAt)}</p>
        {/*
          `<a>` y no `<Link>`/`ButtonLink`: un Link de Next prefetchea su destino, y el destino es la ruta que baja el
          PDF y deja `patientDocument.download` en el audit. Una descarga que el paciente no pidió sería un rastro falso.
        */}
        <a href={`${base}/${encodeURIComponent(doc.id)}/pdf`} className={buttonClassName({ variant: "primary", size: "md" })} style={{ marginTop: 6 }}>
          {COPY.download}
        </a>
      </header>

      <Card glass style={{ padding: "20px 18px" }}>
        <HcPrintableView content={doc.content} verificationCode={doc.verificationCode} />
      </Card>

      <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>{COPY.verificationHint}</p>
    </div>
  );
}
