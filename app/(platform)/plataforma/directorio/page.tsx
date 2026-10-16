import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { getPlatformDirectory } from "@/lib/platform-directory-read";
import { directoryMode } from "@/lib/directory-mode";
import { DIRECTORY_MODE_COPY } from "@/components/plataforma/directory/moderation-logic";
import {
  DirectoryClinicList,
  DirectoryFilters,
  DirectoryProfileList,
} from "@/components/plataforma/directory/directory-lists";

export const dynamic = "force-dynamic";
export const metadata = { title: "Directorio · Plataforma · KineSoft" };

type SearchParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/**
 * /plataforma/directorio — moderación del directorio público (DIR-3e, C-DIR9): consultorios que el titular publicó
 * (o que Plataforma ocultó) y todos los perfiles públicos creados, con ocultar/mostrar con motivo y verificar la
 * matrícula. El guard de superadmin está en el layout del grupo; `getPlatformDirectory` vuelve a llamar a
 * `requirePlatformAdmin` (el layout es UX, no la barrera) y tolera cualquier `?estado=` (cae a «todos»).
 *
 * Plataforma no publica nada: el opt-in del consultorio es del titular y el del perfil es de la persona (DIR-D9). Acá
 * solo se oculta encima y se verifica.
 */
export default async function PlataformaDirectorioPage({ searchParams }: { searchParams: SearchParams }) {
  const view = await getPlatformDirectory({ q: first(searchParams.q), estado: first(searchParams.estado) });
  const mode = directoryMode();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Directorio"
        description="Los consultorios que se publicaron en el directorio y los perfiles públicos de los profesionales. Desde acá se oculta algo que no debería verse (con un motivo que ve el titular) y se marca una matrícula como verificada después de cotejarla."
      />
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
        {DIRECTORY_MODE_COPY[mode]}
      </p>
      <Card style={{ padding: 16 }}>
        <DirectoryFilters filters={view.filters} />
      </Card>
      <DirectoryProfileList view={view} mode={mode} />
      <DirectoryClinicList view={view} mode={mode} />
    </div>
  );
}
