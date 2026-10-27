import { notFound } from "next/navigation";
import { getInboxThread } from "@/lib/platform-inbox";
import { InboxThreadView } from "@/components/plataforma/inbox/inbox-thread";
import { BRAND_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: `Ticket · Plataforma · ${BRAND_NAME}` };

/**
 * /plataforma/mensajes/[id] — un ticket (PL-2d; PV §27, TK-U1: etapa, contacto y notas internas). `getInboxThread` llama a `requirePlatformAdmin` y marca el
 * hilo leído: abrirlo ES leerlo (el contador del nav baja en la próxima navegación). Es el link de los mails
 * `support_message_platform` y `lead_received`.
 */
export default async function PlataformaMensajePage({ params }: { params: { id: string } }) {
  const thread = await getInboxThread(params.id);
  if (!thread) notFound();
  return <InboxThreadView thread={thread} />;
}
