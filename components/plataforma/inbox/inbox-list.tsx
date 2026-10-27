/**
 * Lista de la bandeja de /plataforma → Tickets (PL-2d; tickets en PV §27, TK-U1). Sin "use client": los filtros de
 * etapa son links y el de origen un form GET (funcionan sin JS), con la página que trajo `listInbox` (los filtros viven
 * en la URL, como en Usuarios).
 *
 * Cada fila: tag de etapa («Nuevo / En curso / Resuelto», el texto es el canal; el tono acompaña), origen
 * (`TICKET_SOURCE_LABEL`) y «Tomado por …» si alguien lo tomó. No leídos: punto + negrita + fondo (no solo color). En
 * 360 px cada fila se apila (flex-wrap) en vez de scrollear la página. MB-1f: chips de filtro y paginación de 44 px
 * bajo 768. El origen es un select (10 orígenes no entran como chips en 390 px sin un Drawer de filtros).
 */
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { TICKET_STAGE_LABEL, messageWhen, type TicketInboxPage } from "@/lib/support-threads-types";
import { TICKET_SOURCE_LABEL, motivoOfSource } from "@/lib/support-ticket-sources";
import {
  INBOX_PATH,
  SOURCE_FILTERS,
  STAGE_FILTERS,
  STAGE_TAG_TONE,
  inboxHref,
  inboxThreadHref,
  stageSlugOf,
  type InboxQuery,
} from "@/components/plataforma/inbox/inbox-logic";
import table from "@/components/plataforma/responsive-table.module.css";

function FilterLinks<T extends string>({
  label,
  options,
  current,
  hrefOf,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  current: T;
  hrefOf: (v: T) => string;
}) {
  return (
    <div role="group" aria-label={label} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {options.map((o) => {
        const active = o.value === current;
        return (
          <Link
            key={o.value}
            href={hrefOf(o.value)}
            aria-current={active ? "true" : undefined}
            className={table.chip}
            style={{
              textDecoration: "none",
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              color: active ? "#fff" : "var(--navy-700)",
              background: active ? "var(--sky-700)" : "rgba(15,30,51,0.05)",
            }}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Select «Origen» por GET: lleva la etapa actual como hidden y nada de cursor (cambiar el filtro vuelve al principio).
 * «Todos los orígenes» va con valor vacío, que `parseInboxQuery` lee como `all`.
 */
function SourceFilter({ query }: { query: InboxQuery }) {
  const stageSlug = stageSlugOf(query.stage);
  return (
    <form
      method="get"
      action={INBOX_PATH}
      aria-label="Filtrar por origen"
      style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}
    >
      {stageSlug && <input type="hidden" name="estado" value={stageSlug} />}
      <div style={{ minWidth: 220, flex: "1 1 220px" }}>
        <FormField
          as="select"
          label="Origen"
          name="origen"
          defaultValue={query.source === "all" ? "" : motivoOfSource(query.source)}
          options={SOURCE_FILTERS.map((o) => ({ value: o.value === "all" ? "" : motivoOfSource(o.value), label: o.label }))}
        />
      </div>
      <Button type="submit" variant="ghost">
        Filtrar
      </Button>
    </form>
  );
}

export function InboxList({ page, query }: { page: TicketInboxPage; query: InboxQuery }) {
  // `kind` viaja para no perder el filtro de un link viejo (`?origen=leads`) al cambiar de etapa o paginar.
  const base = { stage: query.stage, source: query.source, kind: query.kind };
  return (
    <Card style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end" }}>
        <FilterLinks label="Etapa" options={STAGE_FILTERS} current={query.stage} hrefOf={(v) => inboxHref({ ...base, stage: v })} />
        <SourceFilter query={query} />
      </div>

      {page.rows.length === 0 ? (
        <p style={{ margin: "8px 4px", fontSize: 13.5, color: "var(--navy-500)" }}>
          {query.cursor ? "No hay más tickets." : "No hay tickets con este filtro."}
        </p>
      ) : (
        <ul aria-label="Tickets" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {page.rows.map((r) => (
            <li key={r.id}>
              <Link
                href={inboxThreadHref(r.id)}
                data-unread={r.unread ? "true" : undefined}
                data-stage={r.stage}
                style={{
                  textDecoration: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                  padding: "12px 14px",
                  borderRadius: 14,
                  border: "1px solid rgba(15,30,51,0.07)",
                  background: r.unread ? "var(--sky-50)" : "#fff",
                  color: "var(--navy-900)",
                }}
              >
                <span
                  aria-label={r.unread ? "Sin leer" : undefined}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    flexShrink: 0,
                    background: r.unread ? "var(--sky-700)" : "transparent",
                  }}
                />
                <span style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: r.unread ? 700 : 600, overflowWrap: "anywhere" }}>{r.subject}</span>
                  <span style={{ display: "block", fontSize: 12.5, color: "var(--navy-500)", marginTop: 2, overflowWrap: "anywhere" }}>
                    {r.fromLabel} · {r.messageCount === 1 ? "1 mensaje" : `${r.messageCount} mensajes`} · {messageWhen(r.lastMessageAt)}
                  </span>
                  {r.takenByName && (
                    <span style={{ display: "block", fontSize: 12.5, color: "var(--navy-700)", marginTop: 2 }}>
                      Tomado por {r.takenByName}
                    </span>
                  )}
                </span>
                <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <Tag tone="soft">{TICKET_SOURCE_LABEL[r.source]}</Tag>
                  <Tag tone={STAGE_TAG_TONE[r.stage]}>{TICKET_STAGE_LABEL[r.stage]}</Tag>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {(page.nextCursor || query.cursor) && (
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", fontSize: 13.5 }}>
          {query.cursor && (
            <Link href={inboxHref(base)} className={table.chip} style={{ color: "var(--sky-700)" }}>
              Volver al principio
            </Link>
          )}
          {page.nextCursor && (
            <Link href={inboxHref(base, page.nextCursor)} className={table.chip} style={{ color: "var(--sky-700)", fontWeight: 600 }}>
              Ver más
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}
