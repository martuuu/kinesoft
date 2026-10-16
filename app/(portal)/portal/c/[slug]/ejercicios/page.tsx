import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getPortalExercisesView } from "@/lib/portal-exercises";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { ButtonLink } from "@/components/ui/button";
import { IconArrow } from "@/components/ui/icons";
import { PortalExerciseList } from "@/components/portal/exercise-list";
import { PortalTabs } from "@/components/portal/portal-tabs";
import { BRAND_NAME } from "@/lib/brand";

/*
 * ES4 S24e · «Tus ejercicios». Gate server-side con `portalSectionsFor` (vía `getPortalExercisesView`): sin `planes` ∧
 * `ejercicios` es 404, igual que sin ficha vinculada (no se distingue «no existe» de «no es tuyo»).
 * `force-dynamic`: PHI y URLs firmadas de 10 min, nada de cache (brief §6).
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  return { title: `${params.slug} · Tus ejercicios · ${BRAND_NAME}` };
}

export default async function PortalExercisesPage({ params }: { params: { slug: string } }) {
  const view = await getPortalExercisesView(params.slug);

  if (view.kind === "signedOut") {
    return (
      <Card glass style={{ padding: 22, display: "grid", gap: 12, justifyItems: "start" }}>
        <p style={{ fontSize: 15, color: "var(--navy-500)", margin: 0 }}>Iniciá sesión para ver tus ejercicios.</p>
        <ButtonLink href={`/portal?c=${encodeURIComponent(params.slug)}`} variant="primary" size="md">
          Entrar con Google o con tu email <IconArrow size={14} />
        </ButtonLink>
      </Card>
    );
  }
  if (view.kind === "notFound") {
    if (view.movedSlug) permanentRedirect(`/portal/c/${encodeURIComponent(view.movedSlug)}/ejercicios`);
    notFound();
  }

  const planHref = `/portal/c/${encodeURIComponent(params.slug)}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Link
        href={planHref}
        className="k-link"
        style={{ fontSize: 14, display: "inline-flex", alignItems: "center", minHeight: 44, alignSelf: "flex-start" }}
      >
        ← Tu plan
      </Link>

      <header>
        <Tag tone="lime">{view.tenantName}</Tag>
        <h1 className="k-display" style={{ fontSize: 26, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          Tus ejercicios
        </h1>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
          {view.data
            ? `Los ejercicios de «${view.data.programTitle}». Hacelos como te indicó tu profesional; si algo te duele, frená y consultale.`
            : "Lo que tu profesional te indique para hacer en casa va a aparecer acá."}
        </p>
      </header>

      <PortalTabs slug={params.slug} sections={view.sections} active="ejercicios" />

      {view.data ? (
        <PortalExerciseList data={view.data} vertical={view.vertical} />
      ) : (
        <Card glass style={{ padding: 22 }}>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
            Todavía no tenés ejercicios cargados en tu plan.
          </p>
        </Card>
      )}
    </div>
  );
}
