import { describe, it, expect, vi } from "vitest";
// PL-Z (a2#4): el provider de Plataforma monta el `StepUpProvider`, que trae la server action `getStepUpOptions`.
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [PL-2d] Mensajes y leads (C-PL11): render del panel del consultorio (Configuración → Soporte), de la bandeja y del
 * hilo de /plataforma, la lógica pura de la bandeja y las plantillas de mail. Componentes REALES con props; se mockean
 * el router de Next, el toast/confirm (providers) y las server actions (red).
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/plataforma/mensajes",
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: () => {}, error: () => {}, warning: () => {}, info: () => {}, dismiss: () => {} }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/platform-inbox", () => ({
  replyInboxThread: async () => ({ ok: true, data: { messageId: "m", mail: "sent" } }),
  setInboxThreadStatus: async () => ({ ok: true, data: { changed: true } }),
  countInboxUnread: async () => 0,
}));

import { SupportMessagesPanel } from "@/components/configuracion/panels/support-messages-panel";
import { InboxList } from "@/components/plataforma/inbox/inbox-list";
import { InboxThreadView } from "@/components/plataforma/inbox/inbox-thread";
import { SupportMessageList } from "@/components/plataforma/inbox/message-list";
import { inboxHref, parseInboxQuery, replyMailMessage, unreadBadgeLabel } from "@/components/plataforma/inbox/inbox-logic";
import {
  NO_PATIENT_DATA_COPY,
  SUPPORT_SESSION_COPY,
  decodeInboxCursor,
  encodeInboxCursor,
  isUnreadForPlatform,
  isUnreadForTenant,
  messageWhen,
  type InboxThreadDetail,
  type SupportThreadRow,
} from "@/lib/support-threads-types";
import { leadReceivedEmail, leadReplyEmail, supportMessagePlatformEmail, supportReplyTenantEmail } from "@/lib/email/templates-support";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

const ROWS: SupportThreadRow[] = [
  {
    id: "t1",
    subject: "No puedo subir el comprobante",
    status: "OPEN",
    createdAt: "2026-10-14T12:00:00.000Z",
    lastMessageAt: "2026-10-14T16:27:00.000Z", // 13:27 AR
    lastAuthorKind: "PLATFORM",
    messageCount: 2,
    unread: true,
  },
  {
    id: "t0",
    subject: "Cambio de plan",
    status: "CLOSED",
    createdAt: "2026-10-01T12:00:00.000Z",
    lastMessageAt: "2026-10-01T13:00:00.000Z",
    lastAuthorKind: "TENANT",
    messageCount: 1,
    unread: false,
  },
];

describe("[PL-2d] Configuración → Soporte → Mensajes", () => {
  it("lista las conversaciones con «Nueva», estado, hora AR y el aviso de no incluir datos de pacientes", () => {
    const html = renderToStaticMarkup(<SupportMessagesPanel initialThreads={ROWS} />);
    const t = text(html);
    expect(t).toContain("No puedo subir el comprobante");
    expect(t).toContain(`Respondió soporte · ${messageWhen(ROWS[0].lastMessageAt)}`);
    expect(messageWhen(ROWS[0].lastMessageAt)).toMatch(/, 13:27$/);
    expect(t).toContain("Nueva");
    expect(t).toContain("Abierta");
    expect(t).toContain("Cerrada");
    expect(t).toContain("Tenés 1 respuesta sin leer.");
    expect(t).toContain(NO_PATIENT_DATA_COPY);
    expect(t).toContain("Nuevo mensaje");
    expect(html.match(/data-unread="true"/g)).toHaveLength(1);
  });

  it("sin conversaciones: estado vacío", () => {
    const t = text(renderToStaticMarkup(<SupportMessagesPanel initialThreads={[]} />));
    expect(t).toContain("Todavía no le escribiste a soporte");
  });

  it("como soporte: solo el aviso, sin botón ni lista", () => {
    const t = text(renderToStaticMarkup(<SupportMessagesPanel support initialThreads={ROWS} />));
    expect(t).toContain(SUPPORT_SESSION_COPY);
    expect(t).not.toContain("Nuevo mensaje");
    expect(t).not.toContain("No puedo subir el comprobante");
  });

  it("los mensajes se muestran como texto (sin HTML) y con el nombre, nunca el email", () => {
    const html = renderToStaticMarkup(
      <SupportMessageList
        messages={[
          { id: "m1", authorKind: "TENANT", authorName: "Ana Titular", mine: true, body: "<b>hola</b>\nlinea 2", createdAt: "2026-10-14T16:27:00.000Z" },
          { id: "m2", authorKind: "PLATFORM", authorName: "Equipo de KineSoft", mine: false, body: "Listo", createdAt: "2026-10-14T17:00:00.000Z" },
        ]}
      />
    );
    expect(html).toContain("&lt;b&gt;hola&lt;/b&gt;");
    expect(html).not.toContain("<b>hola</b>");
    expect(text(html)).toContain(`Ana Titular · ${messageWhen("2026-10-14T16:27:00.000Z")}`);
    expect(text(html)).toContain("Equipo de KineSoft");
  });
});

describe("[PL-2d] /plataforma → Mensajes", () => {
  it("bandeja: filtros activos, no leídos, origen, contador de mensajes y «Ver más» con cursor", () => {
    const html = renderToStaticMarkup(
      <InboxList
        query={{ status: "OPEN", kind: "all", cursor: null }}
        page={{
          rows: [
            {
              id: "a",
              kind: "TENANT",
              status: "OPEN",
              subject: "Factura",
              fromLabel: "Kine Centro",
              tenantId: "ten",
              createdAt: "2026-10-14T12:00:00.000Z",
              lastMessageAt: "2026-10-14T16:27:00.000Z",
              messageCount: 3,
              unread: true,
            },
            {
              id: "b",
              kind: "LEAD",
              status: "OPEN",
              subject: "Consulta de Laura",
              fromLabel: "Laura · Kinesio Sur",
              tenantId: null,
              createdAt: "2026-10-14T12:00:00.000Z",
              lastMessageAt: "2026-10-14T12:00:00.000Z",
              messageCount: 1,
              unread: false,
            },
          ],
          nextCursor: "2026-10-14T12:00:00.000Z|b",
        }}
      />
    );
    const t = text(html);
    expect(t).toContain("Kine Centro · 3 mensajes");
    expect(t).toContain("Laura · Kinesio Sur · 1 mensaje");
    expect(t).toContain("Consultorio");
    // PL-Z: en la UI ya no se dice «Lead».
    expect(t).toContain("Consulta de la web");
    expect(t).not.toMatch(/\bLeads?\b/);
    expect(html.match(/data-unread="true"/g)).toHaveLength(1);
    expect(html).toContain('href="/plataforma/mensajes/a"');
    expect(html).toMatch(/aria-current="true"[^>]*>Abiertas</);
    expect(html).toMatch(/aria-current="true"[^>]*>Todo</);
    expect(html).toContain(`href="/plataforma/mensajes?desde=${encodeURIComponent("2026-10-14T12:00:00.000Z|b")}"`);
  });

  it("hilo de un lead: datos del lead (email como dato, con mailto), mensajes y responder", () => {
    const thread: InboxThreadDetail = {
      id: "l1",
      kind: "LEAD",
      subject: "Consulta de Laura · Kinesio Sur",
      status: "OPEN",
      createdAt: "2026-10-14T12:00:00.000Z",
      closedAt: null,
      tenant: null,
      lead: { name: "Laura", email: "laura@example.com", phone: "11 5555", clinicName: "Kinesio Sur", planInterest: "CLINICA" },
      messages: [{ id: "m", authorKind: "LEAD", authorName: "Laura", mine: false, body: "¿Precios?", createdAt: "2026-10-14T12:00:00.000Z" }],
    };
    const html = renderToStaticMarkup(<InboxThreadView thread={thread} />);
    const t = text(html);
    expect(t).toContain("Email: laura@example.com");
    expect(html).toContain('href="mailto:laura@example.com"');
    expect(t).toContain("Plan que le interesa: Clínica");
    expect(t).toContain("Responder a quien consultó (le llega por mail)");
    expect(t).toContain("Cerrar conversación");
    expect(t).toContain("¿Precios?");
  });

  it("hilo cerrado de consultorio: link al consultorio, «Reabrir» y aviso de que responder reabre", () => {
    const html = renderToStaticMarkup(
      <InboxThreadView
        thread={{
          id: "t",
          kind: "TENANT",
          subject: "Hola",
          status: "CLOSED",
          createdAt: "2026-10-14T12:00:00.000Z",
          closedAt: "2026-10-15T12:00:00.000Z",
          tenant: { id: "ten1", name: "Kine Centro", slug: "kine-centro" },
          lead: null,
          messages: [],
        }}
      />
    );
    const t = text(html);
    expect(html).toContain('href="/plataforma/consultorios/ten1"');
    expect(t).toContain("Reabrir");
    expect(t).toContain("Si respondés, la conversación se vuelve a abrir.");
  });
});

describe("[PL-2d] lógica pura", () => {
  it("query de la bandeja: default abiertas; ida y vuelta por la URL", () => {
    expect(parseInboxQuery({})).toEqual({ status: "OPEN", kind: "all", cursor: null });
    expect(parseInboxQuery({ estado: "todas", origen: "leads", desde: "x" })).toEqual({ status: "all", kind: "LEAD", cursor: "x" });
    expect(parseInboxQuery({ estado: "basura", origen: "basura" })).toEqual({ status: "OPEN", kind: "all", cursor: null });
    for (const q of [
      { status: "OPEN", kind: "all" },
      { status: "CLOSED", kind: "TENANT" },
      { status: "all", kind: "LEAD" },
    ] as const) {
      const href = inboxHref(q, "c|1");
      const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
      expect(parseInboxQuery(sp)).toEqual({ ...q, cursor: "c|1" });
    }
  });

  it("cursor, no leídos, contador y copy del mail", () => {
    const d = new Date("2026-10-14T16:27:00.123Z");
    expect(decodeInboxCursor(encodeInboxCursor(d, "abc"))).toEqual({ lastAt: d, id: "abc" });
    expect(decodeInboxCursor("basura")).toBeNull();
    expect(decodeInboxCursor("2026-10-14T16:27:00.000Z|a'b")).toBeNull();
    expect(isUnreadForTenant(null, null)).toBe(false);
    expect(isUnreadForTenant(d, null)).toBe(true);
    expect(isUnreadForTenant(d, new Date(d.getTime() + 1))).toBe(false);
    expect(isUnreadForPlatform(d, new Date(d.getTime() - 1))).toBe(true);
    expect(unreadBadgeLabel(0)).toBeNull();
    expect(unreadBadgeLabel(10)).toBe("9+");
    expect(replyMailMessage("LEAD", "failed").description).toContain("escribile por otro medio");
    expect(replyMailMessage("TENANT", "sent").tone).toBe("success");
  });
});

describe("[PL-2d] plantillas de mail", () => {
  it("aviso a Plataforma y respuesta al consultorio: asunto y link, sin texto del mensaje (no hay de dónde sacarlo)", () => {
    const a = supportMessagePlatformEmail({ tenantName: "Kine <b>Centro</b>", subject: "Cobro\ndoble", isReply: false, url: "https://app.kinesoft.ar/plataforma/mensajes/t1" });
    expect(a.subject).toBe("Mensaje de Kine bCentro/b: Cobro doble");
    expect(a.html).toContain("Kine &lt;b&gt;Centro&lt;/b&gt;");
    expect(a.html).toContain("https://app.kinesoft.ar/plataforma/mensajes/t1");
    expect(a.text).toContain("No incluyas datos de pacientes");
    const r = supportReplyTenantEmail({ tenantName: "Kine Centro", subject: "Cobro", url: "javascript:alert(1)" });
    expect(r.html).not.toContain("javascript:");
    expect(r.subject).toBe("Te respondimos: Cobro");
  });

  it("lead: el aviso a Martin lleva el mensaje escapado; la respuesta al lead lleva el texto entero", () => {
    const l = leadReceivedEmail({
      name: "Laura",
      email: "laura@example.com",
      phone: null,
      clinicName: "Kinesio Sur",
      planLabel: "Clínica",
      message: '<a href="https://evil">Hacé clic</a>',
      url: "https://app.kinesoft.ar/plataforma/mensajes/l1",
    });
    expect(l.html).not.toContain('<a href="https://evil"');
    expect(l.html).toContain("&lt;a href=&quot;https://evil&quot;&gt;");
    expect(l.subject).toBe("Consulta de Laura (Kinesio Sur)");
    const rep = leadReplyEmail({ name: "Laura", subject: "Consulta de Laura", body: "Hola\nEl plan sale $X." });
    expect(rep.subject).toBe("Re: Consulta de Laura");
    expect(rep.html).toContain("Hola<br />El plan sale $X.");
    expect(rep.text).toContain("El plan sale $X.");
  });
});
