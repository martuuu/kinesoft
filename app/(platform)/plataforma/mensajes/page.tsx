import { PageHeader } from "@/components/ui/page-header";
import { listInbox } from "@/lib/platform-inbox";
import { InboxList } from "@/components/plataforma/inbox/inbox-list";
import { parseInboxQuery } from "@/components/plataforma/inbox/inbox-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tickets · Plataforma" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /plataforma/mensajes — «Tickets» (PL-2d, C-PL11; PV §27, TK-U1): todo contacto (la web, el alta, las pantallas de
 * cuenta y Configuración → Soporte) entra como ticket. La ruta sigue siendo `/mensajes` (D-TK2: mails y links viejos).
 * Filtros en la URL (`?estado=&origen=&desde=`): se le pasan a `listInbox` la etapa y el origen (`stage`/`source`).
 * Antes iba `status`, y `?estado=nuevos` mostraba todos los abiertos (tomados incluidos). `kind` sigue viajando por los
 * links viejos `?origen=consultorios|leads`. El guard de superadmin está en el layout del grupo y `listInbox` vuelve a
 * llamar a `requirePlatformAdmin` (el layout es UX, no la barrera).
 */
export default async function PlataformaMensajesPage({ searchParams }: { searchParams: SearchParams }) {
  const query = parseInboxQuery(searchParams);
  const page = await listInbox({ stage: query.stage, source: query.source, kind: query.kind, cursor: query.cursor });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="Tickets"
        description="Todo lo que llega por la web, el alta, las pantallas de cuenta y Configuración → Soporte. Tomalo, anotá cómo seguiste y marcalo resuelto."
      />
      <InboxList page={page} query={query} />
    </div>
  );
}
