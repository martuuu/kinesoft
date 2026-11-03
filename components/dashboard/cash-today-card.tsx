/**
 * Tarjeta «Cobrado hoy» del Inicio de la Secretaria (CF2 · P.2, sesión P-D; plan §29 D-CF2-16/17).
 *
 * La Secretaria no ve el widget de Ingresos (SR-D5I), pero es la que cobra en la recepción y al cierre tiene que
 * saber cuánto entró por profesional y cuánto de eso se destina a otro (reparto, D-CF2-18). Va en el slot del widget
 * (`oRevenue`, columna derecha; en mobile su mismo `order`): para la Secretaria ese slot estaba vacío.
 *
 * Sin estado ni efectos (server-renderizable): los números llegan calculados y proyectados a `desk` (sin OS) desde
 * `loadDashboard`; acá solo se formatean. La hora es la del cálculo en el server («Actualizado a las …»), en AR con
 * `formatDateAR` (nunca la del host). «Ver caja» lleva al detalle (`/caja`, solo hoy para la Secretaria).
 */
import { Card } from "@/components/ui/card";
import { ButtonLink } from "@/components/ui/button";
import { IconArrow } from "@/components/ui/icons";
import { formatARS, formatDateAR } from "@/lib/format";
import { CAJA_PATH } from "@/lib/caja-types";
import type { DashboardCashToday } from "@/lib/dashboard";

const NAMES = new Intl.ListFormat("es", { style: "long", type: "conjunction" });

export type CashTodayCardRowView = {
  id: string;
  name: string;
  total: string;
  /** «Destina $X a Ana P.» o `null` si no destina nada. */
  given: string | null;
  /** «Recibe $X» o `null`. */
  received: string | null;
};

/** Textos de la tarjeta, puros (render test). */
export function cashTodayCardView(s: DashboardCashToday): {
  empty: boolean;
  rows: CashTodayCardRowView[];
  total: string;
  updatedAt: string;
} {
  return {
    empty: s.rows.length === 0,
    rows: s.rows.map((r) => {
      const to = r.givenTo.map((g) => g.practitionerName);
      return {
        id: r.practitionerId,
        name: r.practitionerName,
        total: formatARS(r.grossCents),
        given: r.givenCents > 0 ? `Destina ${formatARS(r.givenCents)}${to.length ? ` a ${NAMES.format(to)}` : ""}` : null,
        received: r.receivedCents > 0 ? `Recibe ${formatARS(r.receivedCents)}` : null,
      };
    }),
    total: formatARS(s.totalCents),
    updatedAt: `Actualizado a las ${formatDateAR(s.computedAt, "time")}`,
  };
}

export function CashTodayCard({ summary, className }: { summary: DashboardCashToday; className?: string }) {
  const v = cashTodayCardView(summary);
  return (
    <Card
      className={className}
      style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}
      aria-labelledby="dash-cash-today-title"
    >
      <div>
        <h2 id="dash-cash-today-title" className="k-display" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          Cobrado hoy
        </h2>
        <div style={{ fontSize: 11, color: "var(--navy-500)" }}>Copagos y cobros online, por profesional</div>
      </div>

      {v.empty ? (
        // ZB-13: el mismo texto que el vacío de /caja (`caja-view.tsx` emptyToday), adonde lleva «Ver caja».
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", padding: 8 }}>Todavía no hay cobros registrados hoy.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {v.rows.map((r) => (
            <li key={r.id} style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span
                  title={r.name}
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--navy-900)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {r.name}
                </span>
                <span className="k-mono" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-900)", flexShrink: 0 }}>
                  {r.total}
                </span>
              </div>
              {(r.given || r.received) && (
                <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                  {[r.given, r.received].filter(Boolean).join(" · ")}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 8,
          borderTop: "1px solid var(--navy-100)",
          paddingTop: 10,
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-700)" }}>Total del día</span>
        <span className="k-display" style={{ fontSize: 18, fontWeight: 700, color: "var(--navy-900)" }}>
          {v.total}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--navy-500)" }}>{v.updatedAt}</div>

      <ButtonLink href={CAJA_PATH} variant="ghost" block style={{ fontSize: 12.5, padding: 10, marginTop: 4 }}>
        Ver caja <IconArrow size={13} />
      </ButtonLink>
    </Card>
  );
}
