import { notFound } from "next/navigation";
import { getInboxThread } from "@/lib/platform-inbox";
import { InboxThreadView } from "@/components/plataforma/inbox/inbox-thread";

export const dynamic = "force-dynamic";
export const metadata = { title: "Conversación · Mensajes · Plataforma · KineSoft" };

/**
 * /plataforma/mensajes/[id] — una conversación (PL-2d). `getInboxThread` llama a `requirePlatformAdmin` y marca el
 * hilo leído: abrirlo ES leerlo (el contador del nav baja en la próxima navegación). Es el link de los mails
 * `support_message_platform` y `lead_received`.
 */
export default async function PlataformaMensajePage({ params }: { params: { id: string } }) {
  const thread = await getInboxThread(params.id);
  if (!thread) notFound();
  return <InboxThreadView thread={thread} />;
}
