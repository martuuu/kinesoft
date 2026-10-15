/**
 * Lista de la bandeja de /plataforma → Mensajes (PL-2d). Sin "use client": filtros y paginado son links que arma el
 * server con la página que trajo `listInbox` (los filtros viven en la URL, como en Usuarios).
 *
 * No leídos: punto + negrita + fondo (no solo color). Origen con Tag («Consultorio» / «Consulta de la web»). En 360 px cada fila
 * se apila (flex-wrap) en vez de scrollear la página.
 */
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { SUPPORT_STATUS_LABEL, messageWhen, type InboxPage } from "@/lib/support-threads-types";
import {
  KIND_FILTERS,
  KIND_LABEL,
  STATUS_FILTERS,
  inboxHref,
  inboxThreadHref,
  type InboxQuery,
} from "@/components/plataforma/inbox/inbox-logic";

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

export function InboxList({ page, query }: { page: InboxPage; query: InboxQuery }) {
  const base = { status: query.status, kind: query.kind };
  return (
    <Card style={{ padding: 16, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "space-between" }}>
        <FilterLinks label="Estado" options={STATUS_FILTERS} current={query.status} hrefOf={(v) => inboxHref({ ...base, status: v })} />
        <FilterLinks label="Origen" options={KIND_FILTERS} current={query.kind} hrefOf={(v) => inboxHref({ ...base, kind: v })} />
      </div>

      {page.rows.length === 0 ? (
        <p style={{ margin: "8px 4px", fontSize: 13.5, color: "var(--navy-500)" }}>
          {query.cursor ? "No hay más mensajes." : "No hay mensajes con este filtro."}
        </p>
      ) : (
        <ul aria-label="Conversaciones" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {page.rows.map((r) => (
            <li key={r.id}>
              <Link
                href={inboxThreadHref(r.id)}
                data-unread={r.unread ? "true" : undefined}
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
                </span>
                <Tag tone={r.kind === "LEAD" ? "lime" : "sky"}>{KIND_LABEL[r.kind]}</Tag>
                <Tag tone="soft">{SUPPORT_STATUS_LABEL[r.status]}</Tag>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {(page.nextCursor || query.cursor) && (
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", fontSize: 13.5 }}>
          {query.cursor && (
            <Link href={inboxHref(base)} style={{ color: "var(--sky-700)" }}>
              Volver al principio
            </Link>
          )}
          {page.nextCursor && (
            <Link href={inboxHref(base, page.nextCursor)} style={{ color: "var(--sky-700)", fontWeight: 600 }}>
              Ver más
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}
