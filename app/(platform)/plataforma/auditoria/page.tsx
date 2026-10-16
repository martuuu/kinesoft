import { PageHeader } from "@/components/ui/page-header";
import { listPlatformAudit } from "@/lib/platform-audit-read";
import { normalizeAuditFilters } from "@/lib/platform-audit-logic";
import { AuditView } from "@/components/plataforma/audit/audit-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Auditoría · Plataforma · KineSoft" };

type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * BO3-E · /plataforma/auditoria. El guard de superadmin del layout es UX; la barrera real es el
 * `requirePlatformAdmin` de `listPlatformAudit`. Los filtros viven en la URL; un valor inválido (editado a mano)
 * se descarta en `normalizeAuditFilters` en vez de romper la página.
 */
export default async function PlataformaAuditoriaPage({ searchParams }: { searchParams: SearchParams }) {
  const filters = normalizeAuditFilters({
    action: first(searchParams.action),
    tenantId: first(searchParams.tenantId),
    actorEmail: first(searchParams.actorEmail),
    targetUserId: first(searchParams.targetUserId),
    from: first(searchParams.from),
    to: first(searchParams.to),
    cursor: first(searchParams.cursor),
  });
  const page = await listPlatformAudit(filters);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Auditoría"
        description={
          <>
            Todo lo que se hizo desde Plataforma: quién, cuándo, sobre qué consultorio o usuario y qué campos tocó. Las
            fechas son de Argentina.
          </>
        }
      />
      <AuditView page={page} filters={filters} />
    </div>
  );
}
