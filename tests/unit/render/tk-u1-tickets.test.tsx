import { describe, it, expect, vi } from "vitest";
// El provider de Plataforma monta el `StepUpProvider`, que trae la server action `getStepUpOptions` (red).
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [TK-21] Tickets en /plataforma (PV §27, TK-U1): tags de etapa y origen en la lista, tarjeta «Contacto» (solo filas
 * con dato), notas internas y botones según la etapa. Componentes REALES con props; se mockean el router de Next, el
 * toast/confirm (providers) y las server actions (red).
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/plataforma/mensajes",
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: () => {}, error: () => {}, warning: () => {}, info: () => {}, dismiss: () => {} }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/platform-inbox", () => ({
  replyInboxThread: async () => ({ ok: true, data: { messageId: "m", mail: "sent" } }),
  setInboxThreadStatus: async () => ({ ok: true, data: { changed: true } }),
  takeInboxThread: async () => ({ ok: true, data: { changed: true } }),
  addInboxNote: async () => ({ ok: true, data: { noteId: "n" } }),
  countInboxUnread: async () => 0,
}));

import { InboxList } from "@/components/plataforma/inbox/inbox-list";
import { InboxThreadView } from "@/components/plataforma/inbox/inbox-thread";
import { TicketContactCard } from "@/components/plataforma/inbox/ticket-contact-card";
import { TicketNotes } from "@/components/plataforma/inbox/ticket-notes";
import { parseInboxQuery, resolveConfirmMessage, ticketContactRows } from "@/components/plataforma/inbox/inbox-logic";
import { messageWhen, type TicketDetail, type TicketInboxRow } from "@/lib/support-threads-types";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const ROW_BASE = {
  createdAt: "2026-10-27T12:00:00.000Z",
  lastMessageAt: "2026-10-27T13:00:00.000Z",
  messageCount: 1,
  unread: false,
} as const;

const ROWS: TicketInboxRow[] = [
  { ...ROW_BASE, id: "n1", kind: "LEAD", status: "OPEN", subject: "Precio", fromLabel: "Laura", tenantId: null, source: "PRICING", stage: "NEW", takenByName: null },
  { ...ROW_BASE, id: "p1", kind: "TENANT", status: "OPEN", subject: "Factura", fromLabel: "Kine Centro", tenantId: "ten", source: "TENANT_SUPPORT", stage: "IN_PROGRESS", takenByName: "Martín N." },
  { ...ROW_BASE, id: "c1", kind: "TENANT", status: "CLOSED", subject: "Suspendido", fromLabel: "Kine Sur", tenantId: "ten2", source: "TENANT_SUSPENDED", stage: "CLOSED", takenByName: "Martín N." },
];

function detail(over: Partial<TicketDetail>): TicketDetail {
  return {
    id: "t1",
    kind: "LEAD",
    subject: "Consulta",
    status: "OPEN",
    createdAt: "2026-10-27T12:00:00.000Z",
    closedAt: null,
    tenant: null,
    lead: null,
    messages: [],
    source: "LANDING",
    stage: "NEW",
    takenAt: null,
    takenByName: null,
    contact: { name: null, email: null, phone: null, clinicName: null, planInterest: null, tenant: null, userId: null },
    notes: [],
    ...over,
  };
}

const LEAD = detail({
  kind: "LEAD",
  source: "PRICING",
  lead: { name: "Laura", email: "laura@example.com", phone: "11 5555-1234", clinicName: "Kinesio Sur", planInterest: "CLINICA" },
  contact: {
    name: "Laura",
    email: "laura@example.com",
    phone: "11 5555-1234",
    clinicName: "Kinesio Sur",
    planInterest: "CLINICA",
    tenant: null,
    userId: null,
  },
});

const TENANT = detail({
  id: "t2",
  kind: "TENANT",
  source: "TENANT_SUSPENDED",
  stage: "IN_PROGRESS",
  takenAt: "2026-10-27T14:00:00.000Z",
  takenByName: "Martín N.",
  tenant: { id: "ten1", name: "Kine Centro", slug: "kine-centro" },
  contact: {
    name: "Ana Titular",
    email: "ana@kine.com",
    phone: null,
    clinicName: "Kine Centro",
    planInterest: null,
    tenant: { id: "ten1", name: "Kine Centro", slug: "kine-centro", phone: null, whatsapp: "11 6666-7777" },
    userId: "u-1",
  },
});

describe("[TK-21] tags y tarjeta", () => {
  it("lista: tag de etapa (Nuevo / En curso / Resuelto), origen con su etiqueta y «Tomado por»", () => {
    const html = renderToStaticMarkup(<InboxList page={{ rows: ROWS, nextCursor: null }} query={parseInboxQuery({})} />);
    const t = text(html);
    for (const s of ["Nuevo", "En curso", "Resuelto"]) expect(t).toContain(s);
    expect(t).toContain("Web · precios");
    expect(t).toContain("Soporte del consultorio");
    expect(t).toContain("Consultorio suspendido");
    expect(t.match(/Tomado por Martín N\./g)).toHaveLength(2);
    expect(html).toContain('href="/plataforma/mensajes/n1"');
  });

  it("lista: filtros de etapa como links (Abiertos activo por default) y select de origen por GET", () => {
    const html = renderToStaticMarkup(<InboxList page={{ rows: [], nextCursor: null }} query={parseInboxQuery({ estado: "nuevos" })} />);
    const t = text(html);
    for (const s of ["Abiertos", "Nuevos", "En curso", "Resueltos", "Todos"]) expect(t).toContain(s);
    expect(html).toMatch(/aria-current="true"[^>]*>Nuevos</);
    expect(html).toContain('href="/plataforma/mensajes?estado=en-curso"');
    expect(html).toContain('href="/plataforma/mensajes"'); // «Abiertos» no ensucia la URL
    expect(html).toMatch(/<form[^>]*method="get"[^>]*action="\/plataforma\/mensajes"/);
    expect(html).toContain('name="estado" value="nuevos"');
    expect(t).toContain("Todos los orígenes");
    expect(html).toMatch(/<option value="precio"[^>]*>Web · precios<\/option>/);
    expect(t).toContain("No hay tickets con este filtro.");
    // Sin la palabra vieja.
    expect(t).not.toMatch(/conversaci/i);
  });

  it("lista: el origen elegido queda seleccionado en el select", () => {
    const html = renderToStaticMarkup(<InboxList page={{ rows: [], nextCursor: null }} query={parseInboxQuery({ origen: "suspendido" })} />);
    expect(html).toMatch(/<option(?=[^>]*value="suspendido")(?=[^>]*selected="")[^>]*>Consultorio suspendido<\/option>/);
    expect(html).not.toMatch(/<option(?=[^>]*value="precio")(?=[^>]*selected="")/);
  });

  it("contacto de un LEAD: nombre, email (mailto), teléfono (tel), WhatsApp (wa.me), consultorio, identidad, plan, origen, recibido; sin Usuario ni Tomado por", () => {
    const rows = ticketContactRows(LEAD);
    expect(rows.map((r) => r.label)).toEqual([
      "Nombre", "Email", "Teléfono", "WhatsApp", "Consultorio", "Identidad", "Plan que le interesa", "Origen", "Recibido",
    ]);
    const html = renderToStaticMarkup(<TicketContactCard thread={LEAD} />);
    const t = text(html);
    expect(t).toContain("Contacto");
    expect(html).toContain('href="mailto:laura@example.com"');
    expect(html).toContain('href="tel:1155551234"');
    expect(html).toContain('href="https://wa.me/5491155551234"');
    expect(t).toContain("Clínica");
    expect(t).toContain("Web · precios");
    expect(t).toContain(messageWhen(LEAD.createdAt));
    expect(t).not.toContain("Usuario");
    expect(t).not.toContain("Tomado por");
  });

  it("contacto de un TENANT: link al consultorio y al usuario, WhatsApp del consultorio, tomado por; sin teléfono ni plan", () => {
    const rows = ticketContactRows(TENANT);
    expect(rows.map((r) => r.label)).toEqual(["Nombre", "Email", "WhatsApp", "Consultorio", "Usuario", "Origen", "Recibido", "Tomado por"]);
    const html = renderToStaticMarkup(<TicketContactCard thread={TENANT} />);
    const t = text(html);
    expect(html).toContain('href="/plataforma/consultorios/ten1"');
    expect(html).toContain('href="/plataforma/usuarios/u-1"');
    expect(html).toContain('href="https://wa.me/5491166667777"');
    expect(t).toContain("Consultorio suspendido");
    expect(t).toContain(`Martín N. · ${messageWhen(TENANT.takenAt!)}`);
    expect(t).not.toContain("Teléfono");
    expect(t).not.toContain("Plan que le interesa");
  });

  it("contacto sin datos opcionales: solo Origen y Recibido", () => {
    expect(ticketContactRows(detail({ kind: "TENANT" })).map((r) => r.label)).toEqual(["Origen", "Recibido"]);
  });

  // ZA B1: un LEAD sin `userId` salió del formulario web: el nombre, el email y el origen los tipeó quien sea. Que la
  // tarjeta lo diga, para que nadie trate «Cuenta desactivada · Ana» de la web como un pedido de la dueña de la cuenta.
  it("[ZF1a] LEAD sin usuario: fila «Identidad: Sin verificar (formulario web)»; LEAD de sesión y TENANT, sin ella", () => {
    const rows = ticketContactRows(LEAD);
    expect(rows.map((r) => r.label)).toEqual([
      "Nombre", "Email", "Teléfono", "WhatsApp", "Consultorio", "Identidad", "Plan que le interesa", "Origen", "Recibido",
    ]);
    expect(rows.find((r) => r.label === "Identidad")).toEqual({ label: "Identidad", value: "Sin verificar (formulario web)" });
    expect(text(renderToStaticMarkup(<TicketContactCard thread={LEAD} />))).toContain("Sin verificar (formulario web)");
    expect(ticketContactRows(detail({})).map((r) => r.label)).toEqual(["Identidad", "Origen", "Recibido"]);
    const sessionLead = detail({ source: "ACCOUNT_DISABLED", contact: { ...LEAD.contact, userId: "u-9" } });
    expect(ticketContactRows(sessionLead).some((r) => r.label === "Identidad")).toBe(false);
    expect(ticketContactRows(TENANT).some((r) => r.label === "Identidad")).toBe(false);
  });

  it("notas internas: hint, vacío, lista con «Vos» en las propias, contador y botón", () => {
    const empty = text(renderToStaticMarkup(<TicketNotes threadId="t1" notes={[]} />));
    expect(empty).toContain("Notas internas");
    expect(empty).toContain("Solo las ve el equipo de Plataforma. Ej.: “Lo llamé por WhatsApp el 30/10, quedó en mandar los datos”.");
    expect(empty).toContain("Todavía no hay notas.");
    expect(empty).toContain("Agregar nota");
    expect(empty).toContain("0 / 2000");
    const html = renderToStaticMarkup(
      <TicketNotes
        threadId="t1"
        notes={[
          { id: "a", authorName: "Martín N.", body: "<b>Lo llamé</b>", createdAt: "2026-10-27T15:00:00.000Z", mine: true },
          { id: "b", authorName: "Sofía P.", body: "Mandó los datos", createdAt: "2026-10-27T16:00:00.000Z", mine: false },
        ]}
      />
    );
    const t = text(html);
    expect(html).toContain("&lt;b&gt;Lo llamé&lt;/b&gt;");
    expect(t).toContain(`Vos · ${messageWhen("2026-10-27T15:00:00.000Z")}`);
    expect(t).toContain(`Sofía P. · ${messageWhen("2026-10-27T16:00:00.000Z")}`);
    expect(t).not.toContain("Todavía no hay notas.");
  });

  it("detalle: botones según la etapa y «← Volver a Tickets»", () => {
    const nuevo = text(renderToStaticMarkup(<InboxThreadView thread={LEAD} />));
    expect(nuevo).toContain("← Volver a Tickets");
    expect(nuevo).toContain("Tomar");
    expect(nuevo).toContain("Marcar resuelto");
    expect(nuevo).not.toContain("Reabrir");
    expect(nuevo).toContain("Notas internas");
    expect(nuevo).toContain("Responder a quien consultó (le llega por mail)");

    const enCurso = text(renderToStaticMarkup(<InboxThreadView thread={TENANT} />));
    expect(enCurso).not.toMatch(/\bTomar\b/);
    expect(enCurso).toContain("Marcar resuelto");
    expect(enCurso).toContain("En curso");

    const resuelto = text(renderToStaticMarkup(<InboxThreadView thread={{ ...TENANT, status: "CLOSED", stage: "CLOSED", closedAt: "2026-10-28T12:00:00.000Z" }} />));
    expect(resuelto).toContain("Reabrir");
    expect(resuelto).not.toContain("Marcar resuelto");
    expect(resuelto).not.toMatch(/\bTomar\b/);
    expect(resuelto).toContain("Resuelto");
  });

  it("copy del confirm de «Marcar resuelto» por tipo", () => {
    expect(resolveConfirmMessage("TENANT")).toBe("El consultorio lo va a ver cerrado. Si vuelve a escribir, entra como ticket nuevo.");
    expect(resolveConfirmMessage("LEAD")).toBe("Pasa a Resueltos. Si respondés, se vuelve a abrir.");
  });
});
