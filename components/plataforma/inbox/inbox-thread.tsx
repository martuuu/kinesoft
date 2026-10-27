"use client";

/**
 * Detalle de un ticket de /plataforma → Tickets (PL-2d; tickets en PV §27, TK-U1): encabezado con etapa y origen,
 * acciones de etapa (`TicketActions`), tarjeta «Contacto», mensajes, responder y «Notas internas».
 *
 * Cada acción pasa por `usePlatformAction` (rate limit legible y, con MFA en enforce, la sesión sin segundo paso). Sin
 * `router.refresh()` (PF-0d): las actions hacen `revalidatePath("/plataforma/mensajes", "layout")` y la respuesta ya
 * trae el árbol nuevo del ticket (un refresh sería un segundo render entero).
 * Después de responder se avisa cómo salió el mail (`replyMailMessage`): un lead sin mail no tiene otra forma de ver
 * la respuesta. Responder también toma el ticket (lo hace el server, TK-S2).
 *
 * El email del lead se muestra como DATO en la tarjeta («Email», con link `mailto:`), nunca como nombre (decisión 19).
 */
import Link from "next/link";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { SupportMessageList } from "@/components/plataforma/inbox/message-list";
import { TicketActions } from "@/components/plataforma/inbox/ticket-actions";
import { TicketContactCard } from "@/components/plataforma/inbox/ticket-contact-card";
import { TicketNotes } from "@/components/plataforma/inbox/ticket-notes";
import { INBOX_PATH, STAGE_TAG_TONE, replyMailMessage } from "@/components/plataforma/inbox/inbox-logic";
import { replyInboxThread } from "@/lib/platform-inbox";
import { TICKET_SOURCE_LABEL } from "@/lib/support-ticket-sources";
import { NO_PATIENT_DATA_COPY, TICKET_STAGE_LABEL, type TicketDetail } from "@/lib/support-threads-types";

const GENERIC_ERROR = "No pudimos guardar. Probá de nuevo en unos minutos.";

export function InboxThreadView({ thread }: { thread: TicketDetail }) {
  const runPlatform = usePlatformAction();
  const toast = useToast();
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onReply(e: React.FormEvent) {
    e.preventDefault();
    if (pending || reply.trim() === "") return;
    setPending(true);
    setError(null);
    try {
      const r = await runPlatform(() => replyInboxThread({ threadId: thread.id, body: reply }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setReply("");
      const msg = replyMailMessage(thread.kind, r.data.mail);
      if (msg.tone === "success") toast.success(msg.title, { description: msg.description });
      else toast.warning(msg.title, { description: msg.description, duration: 0 });
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 20, display: "grid", gap: 12 }}>
        <Link
          href={INBOX_PATH}
          style={{ fontSize: 13, color: "var(--sky-700)", textDecoration: "none", display: "inline-flex", alignItems: "center", minHeight: 44, width: "fit-content" }}
        >
          ← Volver a Tickets
        </Link>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
          <h1 className="k-display" style={{ fontSize: 22, margin: 0, overflowWrap: "anywhere", flex: "1 1 260px" }}>
            {thread.subject}
          </h1>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Tag tone="soft">{TICKET_SOURCE_LABEL[thread.source]}</Tag>
            <Tag tone={STAGE_TAG_TONE[thread.stage]}>{TICKET_STAGE_LABEL[thread.stage]}</Tag>
          </div>
        </div>
        <TicketActions threadId={thread.id} kind={thread.kind} stage={thread.stage} />
      </Card>

      <TicketContactCard thread={thread} />

      <Card style={{ padding: 20 }}>
        <SupportMessageList messages={thread.messages} />
      </Card>

      <Card style={{ padding: 20 }}>
        <form onSubmit={onReply} style={{ display: "grid", gap: 10 }}>
          <FormField
            as="textarea"
            label={thread.kind === "LEAD" ? "Responder a quien consultó (le llega por mail)" : "Responder al consultorio"}
            name="body"
            rows={6}
            value={reply}
            onChange={setReply}
            hint={
              thread.kind === "LEAD"
                ? "La respuesta va entera en el mail. Si contesta, te llega a la casilla de soporte."
                : `El consultorio recibe un aviso por mail y lee la respuesta en la app. ${NO_PATIENT_DATA_COPY}`
            }
          />
          {thread.status === "CLOSED" && (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>Si respondés, el ticket se vuelve a abrir.</p>
          )}
          {error && (
            <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger-fg)" }}>
              {error}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="submit" disabled={pending || reply.trim() === ""}>
              {pending ? "Enviando…" : "Responder"}
            </Button>
          </div>
        </form>
      </Card>

      <Card style={{ padding: 20 }}>
        <TicketNotes threadId={thread.id} notes={thread.notes} />
      </Card>
    </div>
  );
}
