import { Card } from "@/components/ui/card";
import { listPlatformTenants } from "@/lib/platform-tenants-read";
import { PlatformTenantListQuery } from "@/lib/platform-tenants-schemas";
import { TenantList } from "@/components/plataforma/tenants/tenant-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Consultorios · Plataforma · KineSoft" };

type SearchParams = Record<string, string | string[] | undefined>;

/** `?plan=PRO&plan=FREE` llega como array: se toma el primero. */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * /plataforma/consultorios — lista con filtros (EV0 · EV-P3, plan §15.4). Los
 * filtros viven en la URL. Un searchParam inválido (`?plan=GOLD`, editado a mano)
 * cae a "sin filtros", igual que hace `listPlatformTenants`, para que el form
 * muestre lo mismo que la lista.
 */
export default async function PlataformaConsultoriosPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = {
    q: first(searchParams.q) ?? "",
    vertical: first(searchParams.vertical) ?? "",
    plan: first(searchParams.plan) ?? "",
    status: first(searchParams.status) ?? "",
    page: first(searchParams.page) ?? "1",
  };
  const parsed = PlatformTenantListQuery.safeParse(raw);
  const query = parsed.success ? parsed.data : PlatformTenantListQuery.parse({});
  const page = await listPlatformTenants(query);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 24 }}>
        <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
          Consultorios
        </h1>
        <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
          Todos los consultorios de KineSoft. Entrá a uno para ver su uso y cambiar tipo, plan, trial o turnero.
        </p>
      </Card>
      <TenantList page={page} query={query} />
    </div>
  );
}
