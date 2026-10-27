/**
 * PV (§27) · TK-S2 · filtros de la bandeja de Tickets en la URL (`components/plataforma/inbox/inbox-logic.ts`).
 *
 * `?estado=abiertos|nuevos|en-curso|resueltos|todos` y `?origen=<slug>` (slugs = `TICKET_MOTIVO`). Los de PL-2d
 * (`abiertas|cerradas|todas`, `consultorios|leads`) siguen: hay links guardados y mails viejos que los llevan. La
 * query trae también `status`/`kind` derivados para la lista de PL-2d hasta que TK-U1 (Q3) la reemplace.
 */
import { describe, it, expect } from "vitest";
import {
  INBOX_PATH,
  SOURCE_FILTERS,
  STAGE_FILTERS,
  inboxHref,
  parseInboxQuery,
  type InboxQuery,
} from "@/components/plataforma/inbox/inbox-logic";
import { SUPPORT_TICKET_SOURCES, TICKET_MOTIVO, TICKET_SOURCE_LABEL } from "@/lib/support-ticket-sources";

function roundTrip(q: Partial<InboxQuery>, cursor: string | null = null): InboxQuery {
  const href = inboxHref(q, cursor);
  const url = new URL(href, "http://x");
  expect(url.pathname).toBe(INBOX_PATH);
  return parseInboxQuery(Object.fromEntries(url.searchParams));
}

describe("[TK-18] parseInboxQuery nuevos y viejos", () => {
  it("default: abiertos (Nuevos + En curso), todos los orígenes", () => {
    expect(parseInboxQuery({})).toEqual({ stage: "open", source: "all", status: "OPEN", kind: "all", cursor: null });
  });

  it("?estado= nuevos", () => {
    const cases: Array<[string, InboxQuery["stage"], InboxQuery["status"]]> = [
      ["abiertos", "open", "OPEN"],
      ["nuevos", "NEW", "OPEN"],
      ["en-curso", "IN_PROGRESS", "OPEN"],
      ["resueltos", "CLOSED", "CLOSED"],
      ["todos", "all", "all"],
    ];
    for (const [estado, stage, status] of cases) {
      expect(parseInboxQuery({ estado }), estado).toMatchObject({ stage, status });
    }
  });

  it("?estado= viejos (PL-2d) siguen", () => {
    expect(parseInboxQuery({ estado: "abiertas" })).toMatchObject({ stage: "open", status: "OPEN" });
    expect(parseInboxQuery({ estado: "cerradas" })).toMatchObject({ stage: "CLOSED", status: "CLOSED" });
    expect(parseInboxQuery({ estado: "todas" })).toMatchObject({ stage: "all", status: "all" });
  });

  it("?origen=<slug> para cada origen; los viejos consultorios|leads siguen como tipo", () => {
    for (const [slug, source] of Object.entries(TICKET_MOTIVO)) {
      expect(parseInboxQuery({ origen: slug }), slug).toMatchObject({ source, kind: "all" });
    }
    expect(parseInboxQuery({ origen: "consultorios" })).toMatchObject({ source: "all", kind: "TENANT" });
    expect(parseInboxQuery({ origen: "leads" })).toMatchObject({ source: "all", kind: "LEAD" });
  });

  it("basura, arrays y claves de Object.prototype → default (nunca rompe)", () => {
    const d = parseInboxQuery({});
    expect(parseInboxQuery({ estado: "basura", origen: "basura" })).toEqual(d);
    expect(parseInboxQuery({ estado: "constructor", origen: "__proto__" })).toEqual(d);
    expect(parseInboxQuery({ origen: "toString" })).toEqual(d);
    expect(parseInboxQuery({ estado: ["nuevos", "todos"], origen: ["precio"] })).toMatchObject({ stage: "NEW", source: "PRICING" });
    expect(parseInboxQuery({ desde: "x".repeat(201) }).cursor).toBeNull();
    expect(parseInboxQuery({ desde: "c|1" }).cursor).toBe("c|1");
  });

  it("ida y vuelta por la URL con los filtros nuevos", () => {
    for (const stage of ["open", "NEW", "IN_PROGRESS", "CLOSED", "all"] as const) {
      for (const source of ["all", ...SUPPORT_TICKET_SOURCES] as const) {
        expect(roundTrip({ stage, source }, "c|1")).toMatchObject({ stage, source, cursor: "c|1" });
      }
    }
    // El default no ensucia la URL.
    expect(inboxHref({ stage: "open", source: "all" })).toBe(INBOX_PATH);
    expect(inboxHref({ stage: "IN_PROGRESS", source: "PLAN_LIBRE" })).toBe(`${INBOX_PATH}?estado=en-curso&origen=plan-libre`);
  });

  it("ida y vuelta con la forma de PL-2d ({status, kind}): la lista vieja sigue andando hasta TK-U1", () => {
    for (const q of [
      { status: "OPEN", kind: "all" },
      { status: "CLOSED", kind: "TENANT" },
      { status: "all", kind: "LEAD" },
    ] as const) {
      expect(roundTrip(q, "c|1")).toMatchObject({ ...q, cursor: "c|1" });
    }
    // Con `stage`, `stage` manda (el `status` de la query es derivado).
    expect(roundTrip({ stage: "NEW", status: "CLOSED" })).toMatchObject({ stage: "NEW", status: "OPEN" });
  });

  it("opciones de filtro para la UI: etapas y orígenes con el copy del brief", () => {
    expect(STAGE_FILTERS.map((f) => [f.value, f.label])).toEqual([
      ["open", "Abiertos"],
      ["NEW", "Nuevos"],
      ["IN_PROGRESS", "En curso"],
      ["CLOSED", "Resueltos"],
      ["all", "Todos"],
    ]);
    expect(SOURCE_FILTERS[0]).toEqual({ value: "all", label: "Todos los orígenes" });
    expect(SOURCE_FILTERS.slice(1)).toEqual(SUPPORT_TICKET_SOURCES.map((s) => ({ value: s, label: TICKET_SOURCE_LABEL[s] })));
  });
});
