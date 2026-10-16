import { PageHeader } from "@/components/ui/page-header";
import { listTagsForAdmin } from "@/lib/tags-admin";
import { TagAdminPanel } from "@/components/plataforma/tag-admin-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Categorías · Plataforma · KineSoft" };

/**
 * /plataforma/tags — platform-superadmin tag (category) authoring.
 *
 * The superadmin guard lives in the group layout `app/(platform)/layout.tsx`; the
 * server actions (`createTag` / `renameTag` / `deleteTag`) re-check on their
 * own, so this page only loads the catalog and hands it to the client panel.
 */
export default async function PlataformaTagsPage() {
  const tags = await listTagsForAdmin();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Categorías"
        description={
          <>
            Gestioná las categorías del catálogo — grupo muscular, elementos,
            disciplina, objetivos…
          </>
        }
      />

      <TagAdminPanel tags={tags} />
    </div>
  );
}
