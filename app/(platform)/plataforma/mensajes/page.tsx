import { Card } from "@/components/ui/card";
import { listInbox } from "@/lib/platform-inbox";
import { InboxList } from "@/components/plataforma/inbox/inbox-list";
import { parseInboxQuery } from "@/components/plataforma/inbox/inbox-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mensajes · Plataforma · KineSoft" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /plataforma/mensajes — bandeja de soporte (PL-2d, C-PL11): mensajes de los consultorios (Configuración → Soporte) y
 * leads del formulario de la web. Filtros en la URL (`?estado=&origen=&desde=`). El guard de superadmin está en el
 * layout del grupo y `listInbox` vuelve a llamar a `requirePlatformAdmin` (el layout es UX, no la barrera).
 */
export default async function PlataformaMensajesPage({ searchParams }: { searchParams: SearchParams }) {
  const query = parseInboxQuery(searchParams);
  const page = await listInbox({ status: query.status, kind: query.kind, cursor: query.cursor });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 24 }}>
        <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
          Mensajes
        </h1>
        <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
          Lo que te escriben los consultorios desde Configuración → Soporte y las consultas del formulario de la web
          (leads). Al responder, les llega un aviso por mail.
        </p>
      </Card>
      <InboxList page={page} query={query} />
    </div>
  );
}
