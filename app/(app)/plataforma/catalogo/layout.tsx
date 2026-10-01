import { Card } from "@/components/ui/card";
import { CatalogTabs } from "@/components/plataforma/catalog/catalog-tabs";

/**
 * Plataforma → Catálogo global (B1.3 CAT-admin): prestadoras, prácticas y
 * especialidades que comparten todos los consultorios. El guard de superadmin
 * vive en `plataforma/layout.tsx`; cada action de `lib/catalog-admin.ts` lo
 * vuelve a chequear por su cuenta.
 */
export default function CatalogoLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card style={{ padding: 20, display: "grid", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 19, fontWeight: 700, color: "var(--navy-900)", margin: 0, letterSpacing: "-0.01em" }}>
            Catálogo global
          </h1>
          <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "3px 0 0", maxWidth: 720, lineHeight: 1.45 }}>
            Obras sociales, prepagas, prácticas y especialidades que usan todos los consultorios. Lo que edites acá
            queda marcado como curado y el import de los listados oficiales no lo pisa.
          </p>
        </div>
        <CatalogTabs />
      </Card>
      {children}
    </div>
  );
}
