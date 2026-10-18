"use client";

import { useMemo, useState, useTransition, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconCheck } from "@/components/ui/icons";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { PaymentMethodPicker, rememberPaymentMethod } from "@/components/billing/payment-method-picker";
import { setBookingInsurerPaid, setBookingCopagoPaid } from "@/lib/bookings";
import { COLLECT_COPY, copagoRemainingCents } from "@/lib/booking-collect";
import { canCollectCopago, canConfirmInsurer, type Capability } from "@/lib/capabilities";
import { formatARS } from "@/lib/format";
import { paymentMethodLabel, type PaymentMethod } from "@/lib/payment-method";
import { Summary, BookingStatusTag } from "../ui";
import type { PatientBookingFull } from "@/lib/patients-types";
import type { PatientPlanBalances, PlanDTO } from "@/lib/plans-read-types";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { PlanBalance, PlanGroupHeader } from "@/components/planes/plan-balance";
import {
  billingSummary,
  bookingPlanOrdinal,
  groupBookingsByPlan,
  isBillingVisible,
  planGroupMetas,
  shouldGroupByPlan,
  type PlanGroupMeta,
} from "@/components/planes/plan-booking-groups";
import tableStyles from "./profile-table.module.css";

/** Facturación columns: Fecha · Servicio · Obra social · OS · Copago · Turno. */
const FACT_COLS = "92px 1fr 0.9fr 1.25fr 1.25fr 96px";
/**
 * P3.Z (F3b): la grilla superaba los 360 px de un teléfono dentro de una Card
 * con `overflow:hidden` y los toggles de cobro quedaban cortados. Desde 768 la
 * tabla scrollea DENTRO de la card; B4b: bajo 768 cada fila es una card con
 * rótulos (`profile-table.module.css`) y los toggles miden 44 px.
 */
const FACT_MIN_WIDTH = 720;
const FACT_TABLE_VARS = { "--pt-cols": FACT_COLS, "--pt-min-w": `${FACT_MIN_WIDTH}px` } as CSSProperties;

/** Fecha de la fila de Facturación (D8, puro): `dd/mm/aa` en hora AR. */
export function factDateLabel(d: Date | string): string {
  return new Date(d).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

function TableScroll({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="profile-table-scroll" className={tableStyles.scroller} style={FACT_TABLE_VARS}>
      <div className={tableStyles.inner}>{children}</div>
    </div>
  );
}

/**
 * Money + a "Confirmar / Cobrado" toggle for one billing side (OS or copago).
 *
 * T3 (C-AS2): `paidLabel` dice cómo pagó el copago («Pagado · Efectivo»; «Sin informar» si se cobró antes de M12) y
 * `canToggle=false` deja solo el estado, sin botón: quien no cobra esa fila (el profesional en un turno ajeno, la
 * Secretaria en la obra social, un cobro de Mercado Pago) ve qué pasó pero no lo cambia. El server decide igual.
 */
function PaidCell({
  amountCents,
  paid,
  available,
  pending,
  onToggle,
  paidLabel = "Cobrado",
  canToggle = true,
}: {
  amountCents: number;
  paid: boolean;
  available: boolean;
  pending: boolean;
  onToggle: (next: boolean) => void;
  paidLabel?: string;
  canToggle?: boolean;
}) {
  if (!available) return <span style={{ fontSize: 12, color: "var(--navy-500)" }}>—</span>;
  const paidChip = { display: "inline-flex", alignItems: "center", gap: 4, border: "none", background: "var(--success-bg)", color: "var(--success-fg)", fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999 } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <span className="k-mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>
        {formatARS(amountCents)}
      </span>
      {!canToggle ? (
        paid ? (
          <span style={paidChip}>
            <IconCheck size={9} stroke={3} /> {paidLabel}
          </span>
        ) : (
          <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--navy-500)" }}>Pendiente</span>
        )
      ) : paid ? (
        <button
          type="button"
          onClick={() => onToggle(false)}
          disabled={pending}
          title={`${paidLabel} — click para deshacer`}
          aria-label={`${paidLabel}. Deshacer cobro`}
          style={{ ...paidChip, cursor: "pointer" }}
        >
          <IconCheck size={9} stroke={3} /> {paidLabel}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onToggle(true)}
          disabled={pending}
          style={{ border: "1px solid var(--sky-700)", color: "var(--sky-700)", background: "rgba(31,79,190,0.06)", cursor: "pointer", fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999 }}
        >
          Confirmar
        </button>
      )}
    </div>
  );
}

/**
 * S22f (ES3 P3.1): con el módulo `planes` y algún turno de plan cargado,
 * Facturación se agrupa por plan, cada plan con su saldo P7 DEL SERVER
 * (`PlanBalance`: pactado, realizado, cobrado, en proceso, pendiente / a
 * favor; la OS pagada aparte), más "Turnos sueltos". Sin módulo o sin turnos
 * de plan → lista plana. En los dos modos los cancelados y ausentes CON cobro
 * se muestran y suman en "percibido" (SR-D4F, Martin 08-oct).
 *
 * Los toggles devuelven `notice?` (P2.Z, B-M3: marcar/desmarcar el cobro de
 * un turno previo re-estampa el reemplazo de la sesión) → toast informativo.
 * El saldo del plan no se recalcula en el cliente después de un toggle: el
 * caller (perfil) re-pide `getPatientPlanBalances` con `onBillingChanged`.
 */
export type FacturacionViewProps = {
  bookings: PatientBookingFull[] | null;
  loading: boolean;
  patchBooking: (id: string, partial: Partial<PatientBookingFull>) => void;
  /** `useTenantModules().has('planes')`. Sin módulo: nunca se agrupa. */
  plansEnabled?: boolean;
  /** `getPatientPlans` (data): disciplina, estado y "Sesión n de N". */
  plans?: readonly PlanDTO[] | null;
  /** `getPatientPlanBalances` (data): saldo P7 por plan y totales. */
  planBalances?: PatientPlanBalances | null;
  /** Acceso full + `clinical.read`. Sin esto el grupo muestra la disciplina, nunca el título. */
  showPlanTitles?: boolean;
  /** Después de un toggle de cobro OK: el perfil vuelve a pedir el saldo al server. */
  onBillingChanged?: () => void;
  /**
   * T3 (C-AS2): capabilities y profesional del VIEWER, para mostrar solo los toggles que el server acepta
   * (`canCollectCopago` por fila; la obra social con `canConfirmInsurer` = `billing.manage`). Sin esto (un caller
   * de antes de T3) se muestran los dos como antes y decide el server.
   */
  billingAccess?: { capabilities: readonly Capability[]; practitionerId: string | null };
};

export function FacturacionView({
  bookings,
  loading,
  patchBooking,
  plansEnabled = false,
  plans = null,
  planBalances = null,
  showPlanTitles = false,
  onBillingChanged,
  billingAccess,
}: FacturacionViewProps) {
  const toast = useToast();
  const [pending, start] = useTransition();
  // T3: el turno cuyo cobro se está registrando (modal con el medio de pago, obligatorio) y el medio elegido.
  const [collecting, setCollecting] = useState<PatientBookingFull | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);
  const caps = useMemo(
    () => (billingAccess ? new Set<Capability>(billingAccess.capabilities) : null),
    [billingAccess]
  );
  const canCollect = (b: PatientBookingFull) =>
    !caps || canCollectCopago(caps, billingAccess?.practitionerId ?? null, b.practitionerId);
  const canInsurer = !caps || canConfirmInsurer(caps);

  if (loading || bookings === null) {
    return (
      <Card glass style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
        Cargando movimientos…
      </Card>
    );
  }

  const grouped = shouldGroupByPlan(plansEnabled, bookings);
  // Turnos que facturan + cancelados/ausentes con cobro (SR-D4F).
  const visible = bookings.filter(isBillingVisible);
  const summary = billingSummary(bookings, { grouped, planBalances });

  // Optimistic lock (A2a-S06): each toggle sends the row version it was
  // rendered with and patches back the NEW `updatedAt` the server returns.
  // Without that patch the second toggle in a row (OS, then copago) would carry
  // the old version and bounce as "cambió en otra sesión".
  const confirmOS = (b: PatientBookingFull, next: boolean) => {
    patchBooking(b.id, { insurerPaidAt: next ? new Date() : null });
    start(async () => {
      const r = await setBookingInsurerPaid(b.id, next, new Date(b.updatedAt).toISOString());
      if (!r.ok) {
        patchBooking(b.id, { insurerPaidAt: b.insurerPaidAt });
        toast.error("No pudimos actualizar el pago de la obra social", { description: r.error });
        return;
      }
      patchBooking(b.id, { updatedAt: new Date(r.data.updatedAt) });
      if (r.data.notice) toast.info(r.data.notice);
      onBillingChanged?.();
    });
  };
  // Desmarcar va directo (como antes); marcar abre el modal del medio de pago: «pagado» sin medio no existe (C-AS2).
  const confirmCopago = (b: PatientBookingFull, next: boolean) => {
    if (next) {
      setMethod(null);
      setMethodError(null);
      setCollecting(b);
      return;
    }
    writeCopago(b, { paid: false });
  };
  const writeCopago = (b: PatientBookingFull, input: { paid: true; method: PaymentMethod } | { paid: false }) => {
    patchBooking(b.id, input.paid ? { paymentStatus: "PAID", copagoPaymentMethod: input.method } : { paymentStatus: "UNPAID", copagoPaymentMethod: null });
    start(async () => {
      const r = await setBookingCopagoPaid(b.id, input, new Date(b.updatedAt).toISOString());
      if (!r.ok) {
        patchBooking(b.id, { paymentStatus: b.paymentStatus, copagoPaymentMethod: b.copagoPaymentMethod });
        toast.error("No pudimos actualizar el copago", { description: r.error });
        return;
      }
      if (input.paid) rememberPaymentMethod(input.method);
      patchBooking(b.id, { updatedAt: new Date(r.data.updatedAt), copagoPaymentMethod: r.data.method });
      if (r.data.notice) toast.info(r.data.notice);
      onBillingChanged?.();
    });
  };
  const submitCollect = () => {
    if (!collecting) return;
    if (!method) {
      setMethodError(COLLECT_COPY.methodRequired);
      return;
    }
    writeCopago(collecting, { paid: true, method });
    setCollecting(null);
  };

  const columnsHeader = (
    <div className={tableStyles.head} style={{ padding: "12px 18px", gap: 14, fontSize: 10, fontWeight: 700, color: "var(--navy-500)", letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
      <span>Fecha</span>
      <span>Servicio</span>
      <span>Obra social</span>
      <span>OS (prestadora)</span>
      <span>Copago (paciente)</span>
      <span style={{ textAlign: "right" }}>Turno</span>
    </div>
  );
  const row = (b: PatientBookingFull, plan: PlanGroupMeta | null) => {
    // PF1.1 (D8): la columna «Obra social» dice la cobertura del turno aunque la OS no reintegre nada (monto 0);
    // antes decía «Particular» a un paciente de OSDE con un servicio sin parte de OS. El toggle de la OS sigue
    // existiendo solo con monto.
    const insured = b.obraSocial.toLowerCase() !== "particular";
    const hasOS = insured && b.osAmountCents > 0;
    const ord = plan ? bookingPlanOrdinal(b, plan) : null;
    const offStatus = b.status === "CANCELLED" || b.status === "NO_SHOW";
    return (
      <div
        key={b.id}
        data-testid="fact-row"
        data-plan={b.programId ?? undefined}
        className={tableStyles.row}
        style={{ padding: "14px 18px", gap: 14, alignItems: "center", fontSize: 13, borderBottom: "1px solid rgba(15,30,51,0.04)", opacity: offStatus ? 0.75 : 1 }}
      >
        {/* D8: `dd/mm/aa` en una línea (con `month: "short"` salía «27 de jul de / 26» partido en dos). */}
        <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)", whiteSpace: "nowrap" }}>
          {factDateLabel(b.scheduledFor)}
        </span>
        <span data-label="Servicio" className={tableStyles.wide} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {ord && plan && (
            <DisciplineChip discipline={plan.discipline} ordinal={ord.ordinal} totalLive={ord.totalLive} size="xs" />
          )}
          <span style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.serviceName}</span>
        </span>
        <span data-label="Obra social" className={tableStyles.wide} style={{ color: "var(--navy-500)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {insured ? b.obraSocial : "Particular"}
        </span>
        <div data-label="OS (prestadora)">
          <PaidCell amountCents={b.osAmountCents} paid={!!b.insurerPaidAt} available={hasOS} pending={pending} onToggle={(n) => confirmOS(b, n)} canToggle={canInsurer} />
        </div>
        <div data-label="Copago (paciente)">
          <PaidCell
            amountCents={b.copagoCents}
            paid={b.paymentStatus === "PAID"}
            available
            pending={pending}
            onToggle={(n) => confirmCopago(b, n)}
            paidLabel={`Pagado · ${paymentMethodLabel(b.copagoPaymentMethod)}`}
            // AUTHORIZED = Mercado Pago retuvo el pago: no se toca a mano (el server lo rechaza igual).
            canToggle={canCollect(b) && b.paymentStatus !== "AUTHORIZED"}
          />
        </div>
        {/* B4b: el estado del turno va arriba a la derecha de la card bajo 768, al lado de la fecha. */}
        <div className={tableStyles.actions} style={{ display: "flex", justifyContent: "flex-end" }}>
          <BookingStatusTag status={b.status} />
        </div>
      </div>
    );
  };

  const summaryCard = (
    <Card glass style={{ padding: 18, display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
      <Summary label="OS percibido" value={formatARS(summary.osPaidCents)} tone="lime" />
      <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
      <Summary label="Copago percibido" value={formatARS(summary.copagoPaidCents)} tone="lime" />
      <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
      <Summary label="Pendiente de cobro" value={formatARS(summary.pendingCents)} tone="sky" />
      {summary.creditCents > 0 && (
        <>
          <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
          <Summary label="A favor del paciente" value={formatARS(summary.creditCents)} tone="sky" />
        </>
      )}
      <span style={{ width: 1, height: 32, background: "rgba(15,30,51,0.08)" }} />
      <Summary label="Turnos facturados" value={String(summary.billableCount)} />
    </Card>
  );

  const footnote = (
    <div style={{ fontSize: 11, color: "var(--navy-500)", paddingLeft: 4, lineHeight: 1.5 }}>
      <strong>OS</strong> = monto que reintegra la obra social al consultorio · <strong>Copago</strong> = lo que abona el paciente. Tocá «Confirmar» en cada lado cuando lo cobres.
      {grouped && (
        <> En cada plan, «Pendiente» es lo realizado que falta cobrar; lo que paga la obra social va aparte.</>
      )}
    </div>
  );

  const collectAmount = collecting ? copagoRemainingCents({ resolvedCopagoCents: collecting.copagoCents, deposits: [] }) : 0;
  const collectModal = (
    <Modal
      open={collecting != null}
      onClose={() => setCollecting(null)}
      title="Registrar cobro"
      description={collecting ? `${collecting.serviceName} · ${factDateLabel(collecting.scheduledFor)}` : undefined}
      width={460}
    >
      {collecting && (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, fontSize: 14, color: "var(--navy-500)" }}>
            <span>Importe</span>
            <b className="k-mono" style={{ fontSize: 24, color: "var(--navy-900)" }}>{formatARS(collectAmount)}</b>
          </div>
          <PaymentMethodPicker
            value={method}
            onChange={(m) => {
              setMethod(m);
              setMethodError(null);
            }}
            error={methodError}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" onClick={() => setCollecting(null)}>
              Cancelar
            </Button>
            <Button type="button" variant="primary" onClick={submitCollect}>
              {`Marcar pagado · ${formatARS(collectAmount)}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );

  if (grouped) {
    const groups = groupBookingsByPlan(visible, planGroupMetas({ plans, planBalances, showPlanTitles }), {
      includeBalanceOnly: true,
    });
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {summaryCard}
        {groups.map((g) => {
          const plan = g.kind === "plan" ? g.plan : null;
          return (
            <Card key={g.key} data-testid="fact-group" style={{ padding: 0, overflow: "hidden" }}>
              <PlanGroupHeader plan={plan} count={g.bookings.length} />
              {plan?.balance && (
                <div style={{ padding: "12px 18px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
                  <PlanBalance balance={plan.balance} status={plan.status} />
                </div>
              )}
              {g.bookings.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--navy-500)", fontSize: 12.5 }}>
                  {plan ? "Sin turnos para facturar entre los cargados." : "Sin turnos sueltos para facturar."}
                </div>
              ) : (
                <TableScroll>
                  {columnsHeader}
                  {g.bookings.map((b) => row(b, plan))}
                </TableScroll>
              )}
            </Card>
          );
        })}
        {footnote}
        {collectModal}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {summaryCard}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {visible.length === 0 ? (
          <>
            <div style={FACT_TABLE_VARS}>{columnsHeader}</div>
            <div style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
              Sin turnos confirmados para facturar todavía.
            </div>
          </>
        ) : (
          <TableScroll>
            {columnsHeader}
            {visible.map((b) => row(b, null))}
          </TableScroll>
        )}
      </Card>
      {footnote}
      {collectModal}
    </div>
  );
}
