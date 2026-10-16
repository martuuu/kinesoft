"use client";

/**
 * Hilo de /plataforma → Mensajes (PL-2d): datos de quién escribe, mensajes, responder y cerrar/reabrir.
 *
 * Cada acción pasa por `usePlatformAction` (rate limit legible y, con MFA en enforce, la sesión sin segundo paso). Sin
 * `router.refresh()` (PF-0d): las actions hacen `revalidatePath("/plataforma/mensajes", "layout")` y la respuesta ya
 * trae el árbol nuevo del hilo (un refresh sería un segundo render entero).
 * Después de responder se avisa cómo salió el mail (`replyMailMessage`): un lead sin mail no tiene otra forma de ver
 * la respuesta.
 *
 * El email del lead se muestra como DATO («Email: …», con link `mailto:`), nunca como nombre (decisión 19).
 */
import Link from "next/link";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { SupportMessageList } from "@/components/plataforma/inbox/message-list";
import { KIND_LABEL, INBOX_PATH, replyMailMessage } from "@/components/plataforma/inbox/inbox-logic";
import { replyInboxThread, setInboxThreadStatus } from "@/lib/platform-inbox";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import { NO_PATIENT_DATA_COPY, SUPPORT_STATUS_LABEL, messageWhen, type InboxThreadDetail } from "@/lib/support-threads-types";

const GENERIC_ERROR = "No pudimos guardar. Probá de nuevo en unos minutos.";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 13.5, color: "var(--navy-700)" }}>
      <span style={{ color: "var(--navy-500)" }}>{label}: </span>
      {children}
    </div>
  );
}

export function InboxThreadView({ thread }: { thread: InboxThreadDetail }) {
  const runPlatform = usePlatformAction();
  const confirm = useConfirm();
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

  async function onToggleStatus() {
    const closing = thread.status === "OPEN";
    if (closing) {
      const ok = await confirm({
        title: "¿Cerrar la conversación?",
        message:
          thread.kind === "TENANT"
            ? "El consultorio la va a ver cerrada y no va a poder responder ahí. Si responde por otra, aparece como nueva."
            : "Queda en Cerradas. Si respondés, se vuelve a abrir.",
        confirmLabel: "Cerrar",
        cancelLabel: "Volver",
      });
      if (!ok) return;
    }
    setPending(true);
    setError(null);
    try {
      const r = await runPlatform(() => setInboxThreadStatus({ threadId: thread.id, status: closing ? "CLOSED" : "OPEN" }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(closing ? "Conversación cerrada" : "Conversación reabierta");
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 20, display: "grid", gap: 10 }}>
        <Link href={INBOX_PATH} style={{ fontSize: 13, color: "var(--sky-700)", textDecoration: "none" }}>
          ← Volver a Mensajes
        </Link>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
          <h1 className="k-display" style={{ fontSize: 22, margin: 0, overflowWrap: "anywhere", flex: "1 1 260px" }}>
            {thread.subject}
          </h1>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Tag tone={thread.kind === "LEAD" ? "lime" : "sky"}>{KIND_LABEL[thread.kind]}</Tag>
            <Tag tone="soft">{SUPPORT_STATUS_LABEL[thread.status]}</Tag>
          </div>
        </div>
        <div style={{ display: "grid", gap: 4 }}>
          {thread.tenant && (
            <Fact label="Consultorio">
              <Link href={`/plataforma/consultorios/${encodeURIComponent(thread.tenant.id)}`} style={{ color: "var(--sky-700)" }}>
                {thread.tenant.name}
              </Link>
            </Fact>
          )}
          {thread.lead && (
            <>
              <Fact label="Nombre">{thread.lead.name}</Fact>
              <Fact label="Email">
                <a href={`mailto:${thread.lead.email}`} style={{ color: "var(--sky-700)" }}>
                  {thread.lead.email}
                </a>
              </Fact>
              {thread.lead.phone && <Fact label="Teléfono">{thread.lead.phone}</Fact>}
              {thread.lead.clinicName && <Fact label="Consultorio">{thread.lead.clinicName}</Fact>}
              {thread.lead.planInterest && <Fact label="Plan que le interesa">{SAAS_PLAN_LABEL[thread.lead.planInterest]}</Fact>}
            </>
          )}
          <Fact label="Empezó">{messageWhen(thread.createdAt)}</Fact>
          {thread.closedAt && <Fact label="Cerrada">{messageWhen(thread.closedAt)}</Fact>}
        </div>
      </Card>

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
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>Si respondés, la conversación se vuelve a abrir.</p>
          )}
          {error && (
            <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger-fg)" }}>
              {error}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" onClick={() => void onToggleStatus()} disabled={pending}>
              {thread.status === "OPEN" ? "Cerrar conversación" : "Reabrir"}
            </Button>
            <Button type="submit" disabled={pending || reply.trim() === ""}>
              {pending ? "Enviando…" : "Responder"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
