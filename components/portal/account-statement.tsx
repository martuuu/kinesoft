/**
 * Estado de cuenta del portal (ES4 S24p). Server component puro (sin "use client", sin estado): el portal es superficie
 * pública con presupuesto de bundle (D-VX22) y no puede importar Drawer/Modal/Toast/framer (guard
 * `public-surface-imports`). Solo pinta el `PortalAccountDTO`: la decisión de qué monto es explícito ya la tomó el
 * server (`lib/portal-account-internal.ts`).
 *
 * - Montos con `formatARS` (centavos → pesos). `to_confirm` → «A confirmar en el consultorio», nunca «$0».
 * - Fechas con `formatDateAR` (hora AR fija: en Vercel el host es UTC y un turno de las 23:30 caería al día siguiente).
 * - «sesión» solo en Kinesiología, «turno» en Clínica general (lib/portal-copy.ts).
 */
import type { TenantVertical } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { formatARS, formatDateAR } from "@/lib/format";
import { portalSessionWord } from "@/lib/portal-copy";
import type { PortalAccountDTO, PortalMoney } from "@/lib/portal-account-types";

export const TO_CONFIRM_COPY = "A confirmar en el consultorio";

function money(m: PortalMoney): string {
  return m.kind === "amount" ? formatARS(m.cents) : TO_CONFIRM_COPY;
}

const row: React.CSSProperties = {
  padding: "12px 16px",
  display: "flex",
  alignItems: "center",
  gap: 12,
  borderTop: "1px solid rgba(15,30,51,0.06)",
};

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}>
      <span style={{ color: "var(--navy-500)" }}>{label}</span>
      <span className="k-mono" style={{ fontWeight: strong ? 700 : 600, textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

export function AccountStatement({
  account,
  vertical,
  showPlans,
  nowMs,
}: {
  account: PortalAccountDTO;
  vertical: TenantVertical;
  showPlans: boolean;
  nowMs: number;
}) {
  const word = portalSessionWord(vertical);
  const { totals } = account;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card glass style={{ padding: 18, display: "grid", gap: 8 }}>
        <EyebrowLabel tone="accent">Resumen</EyebrowLabel>
        {totals.pendingCents > 0 ? (
          <Figure label="Te falta pagar" value={formatARS(totals.pendingCents)} strong />
        ) : (
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Estás al día.</p>
        )}
        {totals.creditCents > 0 && <Figure label="Tenés a favor" value={formatARS(totals.creditCents)} />}
        <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>
          Cuenta solo lo ya atendido con monto definido. Para pagar o por cualquier duda, hablá con el consultorio.
        </p>
      </Card>

      {showPlans && account.plans.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <EyebrowLabel as="h2">Tus planes</EyebrowLabel>
          {account.plans.map((p) => (
            <Card key={p.programId} style={{ padding: 18, display: "grid", gap: 8 }}>
              <div className="k-display" style={{ fontSize: 16, fontWeight: 700 }}>
                {p.title}
              </div>
              <Figure label="Precio acordado" value={p.agreed ? money(p.agreed) : TO_CONFIRM_COPY} />
              <Figure label="Pagado" value={formatARS(p.collectedCents)} />
              {p.inProcessCents > 0 && <Figure label="Pago en proceso" value={formatARS(p.inProcessCents)} />}
              {p.pendingCents > 0 && (
                <Figure label={`Pendiente por ${word.many} realizadas`} value={formatARS(p.pendingCents)} strong />
              )}
              {p.creditCents > 0 && <Figure label="A favor" value={formatARS(p.creditCents)} />}
            </Card>
          ))}
        </section>
      )}

      <section>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px" }}>
            <EyebrowLabel as="h2">{showPlans ? `Turnos fuera de un plan` : "Tus turnos"}</EyebrowLabel>
          </div>
          {account.looseBookings.length === 0 ? (
            <p style={{ ...row, margin: 0, fontSize: 14, color: "var(--navy-500)" }}>
              No tenés turnos en los últimos 12 meses.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {account.looseBookings.map((b) => {
                const upcoming = new Date(b.date).getTime() > nowMs;
                return (
                  <li key={b.id} style={row}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{b.serviceName}</div>
                      <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                        {formatDateAR(b.date, "short")}
                      </div>
                    </div>
                    <div style={{ display: "grid", justifyItems: "end", gap: 4, textAlign: "right" }}>
                      <span
                        className={b.amount.kind === "amount" ? "k-mono" : undefined}
                        style={{
                          fontSize: b.amount.kind === "amount" ? 14 : 12,
                          fontWeight: b.amount.kind === "amount" ? 700 : 500,
                          color: b.amount.kind === "amount" ? undefined : "var(--navy-500)",
                        }}
                      >
                        {money(b.amount)}
                      </span>
                      {b.paid ? (
                        <Tag tone="lime">Pagado</Tag>
                      ) : upcoming ? (
                        <Tag tone="soft">Próximo</Tag>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
