import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { CatalogTabs } from "@/components/plataforma/catalog/catalog-tabs";

/**
 * Plataforma → Catálogo global (B1.3 CAT-admin): prestadoras, prácticas y
 * especialidades que comparten todos los consultorios. El guard de superadmin
 * vive en `app/(platform)/layout.tsx`; cada action de `lib/catalog-admin.ts` lo
 * vuelve a chequear por su cuenta.
 */
export default function CatalogoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Catálogo global"
        description="Obras sociales, prepagas, prácticas y especialidades que usan todos los consultorios. Lo que edites acá queda marcado como curado y el import de los listados oficiales no lo pisa."
      />
      <Card style={{ padding: 12 }}>
        <CatalogTabs />
      </Card>
      {children}
    </div>
  );
}
