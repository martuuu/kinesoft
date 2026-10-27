/**
 * Tarjeta «Contacto» de un ticket (PV §27, TK-U1): lo que Martin necesita para comunicarse con quien escribió («Yo me
 * comunico luego con cada cliente»). Las filas y sus links salen de `ticketContactRows` (puro, con test): solo las que
 * tienen dato. Presentacional y sin estado (server-safe): la monta el detalle del ticket.
 *
 * Los links externos (`mailto:`, `tel:`, `wa.me`) en Plataforma están bien: es el superadmin hablando con su cliente,
 * no datos de pacientes. `wa.me` abre en otra pestaña (`noopener`); mail y teléfono los resuelve el sistema.
 * Rótulo y valor en una grilla de 2 columnas que en 390 px se apila (auto-fit), sin scroll horizontal.
 */
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { ticketContactRows } from "@/components/plataforma/inbox/inbox-logic";
import type { TicketDetail } from "@/lib/support-threads-types";

const linkStyle: React.CSSProperties = {
  color: "var(--sky-700)",
  overflowWrap: "anywhere",
  display: "inline-flex",
  alignItems: "center",
  minHeight: 24,
};

export function TicketContactCard({ thread }: { thread: TicketDetail }) {
  const rows = ticketContactRows(thread);
  return (
    <Card style={{ padding: 20, display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--navy-900)" }}>Contacto</h2>
      <dl style={{ margin: 0, display: "grid", gap: 6, gridTemplateColumns: "minmax(0, max-content) minmax(0, 1fr)", columnGap: 14 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "contents" }}>
            <dt style={{ fontSize: 13, color: "var(--navy-500)" }}>{r.label}</dt>
            <dd style={{ margin: 0, fontSize: 13.5, color: "var(--navy-900)", overflowWrap: "anywhere" }}>
              {r.href ? (
                r.external ? (
                  <a
                    href={r.href}
                    style={linkStyle}
                    {...(r.href.startsWith("https://") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  >
                    {r.value}
                  </a>
                ) : (
                  <Link href={r.href} style={linkStyle}>
                    {r.value}
                  </Link>
                )
              ) : (
                r.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
