"use client";

/**
 * Configuración → «Facturación» (PL-3a, PL-D21; contrato C-PL9 recortado SIN Mercado Pago, decisión de Martin del
 * 16-oct). `?tab=facturacion` es el link de los mails de cobro. Para el Titular o quien tenga «Planes y pagos».
 *
 * Muestra el estado contable de la cuenta (`getBillingOverview`, lo arma `readLedger` del núcleo de cobros): saldo,
 * próximo cargo, cargos del período con su estado, y pagos (en revisión / aprobado / rechazado con el motivo que
 * escribió Plataforma). «Informar pago» abre el drawer del comprobante; «Ver comprobante» pide una URL firmada de 60 s
 * (`getReceiptUrl`) en el momento del clic (no se guardan URLs).
 *
 * `SAAS_BILLING_MODE=off` (default, PL-D16): no se cobra desde la app; se dice eso en vez de una pantalla vacía.
 * Fechas: períodos y vencimientos son claves civiles AR (`formatDateKey`, sin `Date`); los instantes, día AR.
 */
import { useState, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { formatARS } from "@/lib/format";
import { getBillingOverview, getReceiptUrl } from "@/lib/saas-billing";
import { paymentMethodLabel, type BillingOverview } from "@/lib/saas-billing-types";
import {
  balanceView,
  chargeStatusView,
  formatDateKey,
  formatInstantAR,
  paymentStatusView,
  periodLabel,
} from "@/lib/saas-billing-view";
import { ReceiptUploadDrawer } from "./receipt-upload-drawer";

export const BILLING_OFF_COPY = "Todavía no estamos cobrando desde la app.";
/** PL-Z A2: sin `SAAS_BILLING_TRANSFER_INFO` no hay a dónde transferir, así que tampoco se ofrece «Informar pago». */
export const BILLING_NO_TRANSFER_INFO_COPY = "Todavía no cargamos los datos para transferir. Escribinos desde Soporte.";

const NETWORK_ERROR = "No pudimos conectarnos. Revisá la conexión y probá de nuevo.";

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0, flex: "1 1 180px" }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 700, color: "var(--navy-900)" }}>{value}</span>
      {hint && <span style={{ fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.4 }}>{hint}</span>}
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  padding: "12px 0",
  borderTop: "1px solid rgba(15,30,51,0.06)",
};

export function BillingPanel({ initial }: { initial: BillingOverview }) {
  const [o, setO] = useState<BillingOverview>(initial);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  async function reload() {
    try {
      setO(await getBillingOverview());
    } catch {
      setError(NETWORK_ERROR);
    }
  }

  async function openReceipt(paymentId: string) {
    setOpening(paymentId);
    setError(null);
    // La pestaña se abre en el clic (si no, el navegador la bloquea por no venir del gesto) y se navega cuando llega la
    // URL firmada. `opener = null`: la página del comprobante no puede tocar esta.
    const w = typeof window !== "undefined" ? window.open("", "_blank") : null;
    if (w) w.opener = null;
    try {
      const r = await getReceiptUrl(paymentId);
      if (!r.ok) {
        w?.close();
        setError(r.error);
        return;
      }
      if (w) w.location.href = r.data.url;
      else window.location.assign(r.data.url);
    } catch {
      w?.close();
      setError(NETWORK_ERROR);
    } finally {
      setOpening(null);
    }
  }

  const off = o.mode === "off";
  const balance = balanceView(o.balanceCents, (c) => formatARS(c));

  return (
    <div style={{ display: "grid", gap: 14 }} data-billing-mode={o.mode}>
      <Card style={{ padding: 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <EyebrowLabel>Facturación</EyebrowLabel>
            <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5, maxWidth: 560 }}>
              Plan {o.planLabel}
              {o.effectivePriceCents != null ? ` · ${formatARS(o.effectivePriceCents)} por mes` : " · precio a confirmar"}.
              {o.subscriptionStatus === "TRIALING" && o.trialEndsAt && ` Estás en la prueba hasta el ${formatInstantAR(o.trialEndsAt)}: hasta entonces no se cobra nada.`}
            </p>
          </div>
          {o.canSubmitReceipt && (
            <Button type="button" onClick={() => setUploadOpen(true)} data-receipt-open>
              Informar pago
            </Button>
          )}
        </div>

        {off ? (
          <p data-billing-off style={{ margin: 0, padding: 12, borderRadius: "var(--r-sm)", background: "rgba(15,30,51,0.04)", fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>
            <strong>{BILLING_OFF_COPY}</strong> Mientras tanto usá KineSoft como siempre: te avisamos por mail cuando se genere
            el primer cargo.
          </p>
        ) : (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Stat
              label="Saldo"
              value={<span data-balance-tone={balance.tone} style={{ color: balance.tone === "warn" ? "var(--st-noshow-fg)" : undefined }}>{balance.label}</span>}
              hint={o.overdueCount > 0 ? (o.overdueCount === 1 ? "1 cargo vencido." : `${o.overdueCount} cargos vencidos.`) : undefined}
            />
            <Stat
              label="Próximo cargo"
              value={o.nextCharge ? (o.nextCharge.amountCents != null ? formatARS(o.nextCharge.amountCents) : "A confirmar") : "—"}
              hint={o.nextCharge ? `Período desde el ${formatDateKey(o.nextCharge.periodStart)}.` : undefined}
            />
            {o.pendingReviewCount > 0 && (
              <Stat
                label="Comprobantes en revisión"
                value={o.pendingReviewCount}
                hint="Los revisamos y te avisamos por mail."
              />
            )}
          </div>
        )}

        {/* PL-Z A2: los datos para transferir (`SAAS_BILLING_TRANSFER_INFO`) van debajo del saldo; sin ellos, se avisa
            y no se ofrece «Informar pago» (`canSubmitReceipt` ya viene false del server). */}
        {!off &&
          (o.transferInfo ? (
            <p data-transfer-info style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5, overflowWrap: "anywhere", whiteSpace: "pre-line" }}>
              <strong>Transferí a:</strong> {o.transferInfo}
            </p>
          ) : (
            <p data-transfer-info-missing style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>
              {BILLING_NO_TRANSFER_INFO_COPY}
            </p>
          ))}

        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger-fg)" }}>
            {error}
          </p>
        )}
      </Card>

      {(!off || o.charges.length > 0) && (
        <Card style={{ padding: 20 }}>
          <EyebrowLabel>Cargos</EyebrowLabel>
          {o.charges.length === 0 ? (
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--navy-500)" }}>Todavía no hay cargos.</p>
          ) : (
            <ul aria-label="Cargos" style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
              {o.charges.map((c) => {
                const st = chargeStatusView(c);
                return (
                  <li key={c.id} data-charge={c.id} data-charge-status={st.label} style={rowStyle}>
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>{periodLabel(c.periodStart, c.periodEnd)}</span>
                      <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
                        {c.status === "PAID" && c.paidAt ? `Pagado el ${formatInstantAR(c.paidAt)}` : `Vence el ${formatDateKey(c.dueDate)}`}
                        {c.status === "OPEN" && c.paidCents > 0 && ` · faltan ${formatARS(c.remainingCents)}`}
                      </span>
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="k-mono" style={{ fontSize: 14, fontWeight: 600 }}>{formatARS(c.amountCents)}</span>
                      <Tag tone={st.tone}>{st.label}</Tag>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {(!off || o.payments.length > 0) && (
        <Card style={{ padding: 20 }}>
          <EyebrowLabel>Pagos</EyebrowLabel>
          {o.payments.length === 0 ? (
            <p style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--navy-500)" }}>
              Todavía no informaste pagos. Cuando pagues, tocá «Informar pago» y adjuntá el comprobante.
            </p>
          ) : (
            <ul aria-label="Pagos" style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
              {o.payments.map((p) => {
                const st = paymentStatusView(p.status);
                return (
                  <li key={p.id} data-payment={p.id} data-payment-status={st.label} style={rowStyle}>
                    <span style={{ display: "grid", gap: 2, minWidth: 0, flex: "1 1 220px" }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>
                        {formatARS(p.amountCents)}
                        <span style={{ fontWeight: 400, color: "var(--navy-500)" }}>
                          {" "}
                          · {p.paidAt ? `pagado el ${formatInstantAR(p.paidAt)}` : `informado el ${formatInstantAR(p.createdAt)}`}
                        </span>
                      </span>
                      <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
                        {p.chargePeriodStart ? `Cargo del ${formatDateKey(p.chargePeriodStart)}` : "A cuenta"}
                        {/* PL-F1a: el medio sale de su columna (M8c); los pagos de antes dicen «Sin informar». La rama
                            «· Mercado Pago» por `source` se quitó: sin cobro por MP nunca se mostraba. */}
                        <span data-payment-method={p.method ?? ""}> · {paymentMethodLabel(p.method)}</span>
                      </span>
                      {p.note && (
                        <span style={{ fontSize: 12.5, color: "var(--navy-500)", overflowWrap: "anywhere" }}>«{p.note}»</span>
                      )}
                      {p.status === "REJECTED" && (
                        <span data-reject-reason style={{ fontSize: 12.5, color: "var(--danger-fg)", overflowWrap: "anywhere" }}>
                          Motivo: {p.reviewNote ?? "sin detalle. Escribinos desde Soporte."}
                        </span>
                      )}
                      {p.status === "PENDING_REVIEW" && (
                        <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>Lo estamos revisando.</span>
                      )}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Tag tone={st.tone}>{st.label}</Tag>
                      {p.hasReceipt && (
                        <Button type="button" variant="ghost" onClick={() => void openReceipt(p.id)} disabled={opening === p.id}>
                          {opening === p.id ? "Abriendo…" : "Ver comprobante"}
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {o.canSubmitReceipt && (
        <ReceiptUploadDrawer
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          charges={o.charges}
          transferInfo={o.transferInfo}
          onSubmitted={async () => {
            setUploadOpen(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}
