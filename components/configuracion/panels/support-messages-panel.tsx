"use client";

/**
 * Configuración → Soporte → «Mensajes» (PL-2d, contrato C-PL11, plan §20.5.7). El consultorio le escribe al equipo de
 * KineSoft y ve las respuestas. Decisión de Martin: el consultorio escribe desde acá, a Martin le llega mail, responde
 * desde /plataforma, el consultorio ve la respuesta (y le llega mail); abierto/cerrado.
 *
 * - Lista de conversaciones (lo último que se movió, arriba) con «Nueva» si hay respuesta sin leer.
 * - «Nuevo mensaje» y cada conversación abren un `Drawer` con dirty-guard (asunto/texto o respuesta a medio escribir).
 * - Abrir una conversación la marca leída (`markSupportThreadRead`). Cerrada: se lee, no se responde (cerrar/reabrir es
 *   de Plataforma) y se ofrece escribir una nueva.
 * - Con `support` (superadmin «como soporte») no se carga nada: el server igual lo rechaza, y su bandeja es /plataforma.
 * - `?hilo=<id>` en la URL (link del mail `support_reply_tenant`) abre esa conversación al montar.
 *
 * `initialThreads` lo puede pasar la página (server) para no esperar la primera carga; sin él, se piden al montar. Las
 * actions devuelven `ActionResult` (también los permisos y el modo soporte), así que acá no hay `try/catch` de
 * negocio: un error de red sí se muestra con un copy genérico.
 */
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { useToast } from "@/components/ui/toast";
import { SupportMessageList } from "@/components/plataforma/inbox/message-list";
import {
  createSupportThread,
  getSupportThread,
  listSupportThreads,
  markSupportThreadRead,
  replySupportThread,
} from "@/lib/support-threads";
import {
  NO_PATIENT_DATA_COPY,
  SUPPORT_BODY_MAX,
  SUPPORT_SESSION_COPY,
  SUPPORT_STATUS_LABEL,
  SUPPORT_SUBJECT_MAX,
  messageWhen,
  type SupportThreadDetail,
  type SupportThreadRow,
} from "@/lib/support-threads-types";

const NETWORK_ERROR = "No pudimos conectarnos. Revisá la conexión y probá de nuevo.";

/** PL-3a: mensaje prellenado (p. ej. «Consultanos» del plan Libre en el drawer de cambio de plan). */
export type SupportDraft = { subject: string; body: string };

export function SupportMessagesPanel({
  support = false,
  initialThreads,
  draft = null,
  onDraftUsed,
}: {
  support?: boolean;
  initialThreads?: SupportThreadRow[];
  /** Si viene, abre «Nuevo mensaje» con esto cargado (se puede editar antes de mandar). */
  draft?: SupportDraft | null;
  /** Avisa que el borrador ya se volcó al formulario (para no reabrirlo al volver a la pestaña). */
  onDraftUsed?: () => void;
}) {
  const toast = useToast();
  const [threads, setThreads] = useState<SupportThreadRow[] | null>(initialThreads ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(!!draft && !support);
  const [composeSeed, setComposeSeed] = useState<SupportDraft | null>(support ? null : draft);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!draft || support) return;
    setComposeSeed(draft);
    setComposeOpen(true);
    onDraftUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, support]);

  const reload = useCallback(async () => {
    try {
      const r = await listSupportThreads();
      if (r.ok) {
        setThreads(r.data);
        setLoadError(null);
      } else {
        setLoadError(r.error);
      }
    } catch {
      setLoadError(NETWORK_ERROR);
    }
  }, []);

  useEffect(() => {
    if (support) return;
    if (!initialThreads) void reload();
    // `?hilo=` del mail de respuesta: abre esa conversación.
    try {
      const hilo = new URLSearchParams(window.location.search).get("hilo");
      if (hilo) setOpenId(hilo);
    } catch {
      /* sin window.location: nada que abrir */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [support]);

  if (support) {
    return (
      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Mensajes con soporte</EyebrowLabel>
        <p style={{ margin: "8px 0 0", fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>{SUPPORT_SESSION_COPY}</p>
      </Card>
    );
  }

  const unread = threads?.filter((t) => t.unread).length ?? 0;

  return (
    <Card style={{ padding: 20, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <EyebrowLabel>Mensajes con soporte</EyebrowLabel>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5, maxWidth: 560 }}>
            Escribile al equipo de KineSoft por dudas de la cuenta, el plan o los pagos. Te avisamos por mail cuando te
            respondamos. {NO_PATIENT_DATA_COPY}
          </p>
        </div>
        <Button type="button" onClick={() => setComposeOpen(true)}>
          Nuevo mensaje
        </Button>
      </div>

      {loadError && (
        <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger-fg)" }}>
          {loadError}
        </p>
      )}

      {threads === null && !loadError && <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-500)" }}>Cargando mensajes…</p>}

      {threads !== null && threads.length === 0 && (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-500)" }}>
          Todavía no le escribiste a soporte. Cuando lo hagas, la conversación aparece acá.
        </p>
      )}

      {threads !== null && threads.length > 0 && (
        <>
          {unread > 0 && (
            <p style={{ margin: 0, fontSize: 13, color: "var(--sky-700)", fontWeight: 600 }}>
              {unread === 1 ? "Tenés 1 respuesta sin leer." : `Tenés ${unread} respuestas sin leer.`}
            </p>
          )}
          <ul aria-label="Conversaciones con soporte" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(t.id)}
                  data-unread={t.unread ? "true" : undefined}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    borderRadius: 14,
                    border: "1px solid rgba(15,30,51,0.08)",
                    background: t.unread ? "var(--sky-50)" : "#fff",
                    cursor: "pointer",
                    font: "inherit",
                    color: "var(--navy-900)",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: t.unread ? 700 : 600, fontSize: 14, overflowWrap: "anywhere" }}>
                      {t.subject}
                    </span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)", marginTop: 2 }}>
                      {t.lastAuthorKind === "PLATFORM" ? "Respondió soporte" : "Último mensaje tuyo"} · {messageWhen(t.lastMessageAt)}
                    </span>
                  </span>
                  {t.unread && <Tag tone="lime">Nueva</Tag>}
                  <Tag tone={t.status === "OPEN" ? "sky" : "soft"}>{SUPPORT_STATUS_LABEL[t.status]}</Tag>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <ComposeDrawer
        open={composeOpen}
        seed={composeSeed}
        onClose={() => {
          setComposeOpen(false);
          setComposeSeed(null);
        }}
        onCreated={async (threadId) => {
          setComposeOpen(false);
          setComposeSeed(null);
          toast.success("Mensaje enviado", { description: "Te avisamos por mail cuando te respondamos." });
          await reload();
          setOpenId(threadId);
        }}
      />
      <ThreadDrawer
        threadId={openId}
        onClose={() => setOpenId(null)}
        onChanged={reload}
        onNewMessage={() => {
          setOpenId(null);
          setComposeOpen(true);
        }}
      />
    </Card>
  );
}

function ComposeDrawer({
  open,
  seed,
  onClose,
  onCreated,
}: {
  open: boolean;
  seed: SupportDraft | null;
  onClose: () => void;
  onCreated: (threadId: string) => void | Promise<void>;
}) {
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [body, setBody] = useState(seed?.body ?? "");
  // Un borrador nuevo (otro «Consultanos») pisa lo cargado: es lo que se acaba de pedir.
  useEffect(() => {
    if (!seed) return;
    setSubject(seed.subject);
    setBody(seed.body);
  }, [seed]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dirty = subject.trim() !== "" || body.trim() !== "";

  function reset() {
    setSubject("");
    setBody("");
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await createSupportThread({ subject, body });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      reset();
      await onCreated(r.data.threadId);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Nuevo mensaje a soporte"
      dirty={dirty}
      dirtyMessage="Tenés un mensaje sin enviar. Si cerrás, se pierde."
    >
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.5 }}>
          {NO_PATIENT_DATA_COPY} Si la consulta es sobre un turno o una ficha, describí el caso sin nombres ni documentos.
        </p>
        <FormField label="Asunto" name="subject" required value={subject} onChange={setSubject} placeholder="Ej.: No puedo cargar el comprobante" />
        <FormField
          as="textarea"
          label="Mensaje"
          name="body"
          required
          rows={8}
          value={body}
          onChange={setBody}
          hint={`Hasta ${SUPPORT_BODY_MAX} caracteres.`}
        />
        {subject.length > SUPPORT_SUBJECT_MAX && (
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--danger-fg)" }}>El asunto puede tener hasta {SUPPORT_SUBJECT_MAX} caracteres.</p>
        )}
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger-fg)" }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancelar
          </Button>
          <Button type="submit" disabled={pending || !dirty}>
            {pending ? "Enviando…" : "Enviar"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function ThreadDrawer({
  threadId,
  onClose,
  onChanged,
  onNewMessage,
}: {
  threadId: string | null;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onNewMessage: () => void;
}) {
  const [detail, setDetail] = useState<SupportThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async (id: string) => {
    try {
      const r = await getSupportThread(id);
      if (!r.ok) {
        setError(r.error);
        setDetail(null);
        return;
      }
      setDetail(r.data);
      setError(null);
      // Abrir es leer. Si falla, la próxima vez sigue «Nueva»: no vale la pena un error en pantalla.
      const m = await markSupportThreadRead(id);
      if (m.ok) await onChanged();
    } catch {
      setError(NETWORK_ERROR);
    }
  }, [onChanged]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setReply("");
    if (threadId) void load(threadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!threadId || pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await replySupportThread({ threadId, body: reply });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setReply("");
      await load(threadId);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer
      open={threadId !== null}
      onClose={onClose}
      title={detail?.subject ?? "Conversación"}
      width={560}
      dirty={reply.trim() !== ""}
      dirtyMessage="Tenés una respuesta sin enviar. Si cerrás, se pierde."
    >
      <div style={{ display: "grid", gap: 16 }}>
        {detail && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Tag tone={detail.status === "OPEN" ? "sky" : "soft"}>{SUPPORT_STATUS_LABEL[detail.status]}</Tag>
            <span style={{ fontSize: 12, color: "var(--navy-500)" }}>Empezó el {messageWhen(detail.createdAt)}</span>
          </div>
        )}
        {!detail && !error && <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-500)" }}>Cargando…</p>}
        {detail && <SupportMessageList messages={detail.messages} />}

        {detail?.status === "OPEN" && (
          <form onSubmit={onSubmit} style={{ display: "grid", gap: 10 }}>
            <FormField
              as="textarea"
              label="Tu respuesta"
              name="body"
              rows={5}
              value={reply}
              onChange={setReply}
              hint={NO_PATIENT_DATA_COPY}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button type="submit" disabled={pending || reply.trim() === ""}>
                {pending ? "Enviando…" : "Responder"}
              </Button>
            </div>
          </form>
        )}
        {detail?.status === "CLOSED" && (
          <div style={{ display: "grid", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)" }}>
              Esta conversación está cerrada. Si necesitás algo más, escribinos un mensaje nuevo.
            </p>
            <div>
              <Button type="button" variant="ghost" onClick={onNewMessage}>
                Nuevo mensaje
              </Button>
            </div>
          </div>
        )}
        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger-fg)" }}>
            {error}
          </p>
        )}
      </div>
    </Drawer>
  );
}
