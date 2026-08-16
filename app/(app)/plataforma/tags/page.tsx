import { Card } from "@/components/ui/card";
import { listTagsForAdmin } from "@/lib/tags-admin";
import { TagAdminPanel } from "@/components/plataforma/tag-admin-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Categorías · Plataforma · KineSoft" };

/**
 * /plataforma/tags — platform-superadmin tag (category) authoring.
 *
 * The superadmin guard lives in the parent `plataforma/layout.tsx`; the
 * server actions (`createTag` / `renameTag` / `deleteTag`) re-check on their
 * own, so this page only loads the catalog and hands it to the client panel.
 */
export default async function PlataformaTagsPage() {
  const tags = await listTagsForAdmin();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 24 }}>
        <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
          Categorías / Tags
        </h1>
        <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
          Gestioná las categorías del catálogo — grupo muscular, elementos,
          disciplina, objetivos…
        </p>
      </Card>

      <TagAdminPanel tags={tags} />
    </div>
  );
}
