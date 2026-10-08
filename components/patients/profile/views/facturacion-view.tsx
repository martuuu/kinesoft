"use client";

import { useTransition } from "react";
import { Card } from "@/components/ui/card";
import { IconCheck } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { setBookingInsurerPaid, setBookingCopagoPaid } from "@/lib/bookings";
import { formatARS } from "@/lib/format";
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

/** Facturación columns: Fecha · Servicio · Obra social · OS · Copago · Turno. */
const FACT_COLS = "92px 1fr 0.9fr 1.25fr 1.25fr 96px";
/**
 * P3.Z (F3b): la grilla superaba los 360 px de un teléfono dentro de una Card
 * con `overflow:hidden` y los toggles de cobro quedaban cortados. La tabla
 * scrollea DENTRO de la card (como Sesiones), la página no (AGENTS §5).
 */
const FACT_MIN_WIDTH = 720;

function TableScroll({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="profile-table-scroll" style={{ overflowX: "auto" }}>
      <div style={{ minWidth: FACT_MIN_WIDTH }}>{children}</div>
    </div>
  );
}

/** Money + a "Confirmar / Cobrado" toggle for one billing side (OS or copago). */
function PaidCell({
  amountCents,
  paid,
  available,
  pending,
  onToggle,
}: {
  amountCents: number;
  paid: boolean;
  available: boolean;
  pending: boolean;
  onToggle: (next: boolean) => void;
}) {
  if (!available) return <span style={{ fontSize: 12, color: "var(--navy-300)" }}>—</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <span className="k-mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>
        {formatARS(amountCents)}
      </span>
      {paid ? (
        <button
          type="button"
          onClick={() => onToggle(false)}
          disabled={pending}
          title="Cobrado — click para deshacer"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, border: "none", cursor: "pointer", background: "rgba(54,179,126,0.14)", color: "#1F7A52", fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999 }}
        >
          <IconCheck size={9} stroke={3} /> Cobrado
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
}: FacturacionViewProps) {
  const toast = useToast();
  const [pending, start] = useTransition();

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
  const confirmCopago = (b: PatientBookingFull, next: boolean) => {
    patchBooking(b.id, { paymentStatus: next ? "PAID" : "UNPAID" });
    start(async () => {
      const r = await setBookingCopagoPaid(b.id, next, new Date(b.updatedAt).toISOString());
      if (!r.ok) {
        patchBooking(b.id, { paymentStatus: b.paymentStatus });
        toast.error("No pudimos actualizar el copago", { description: r.error });
        return;
      }
      patchBooking(b.id, { updatedAt: new Date(r.data.updatedAt) });
      if (r.data.notice) toast.info(r.data.notice);
      onBillingChanged?.();
    });
  };

  const columnsHeader = (
    <div style={{ padding: "12px 18px", display: "grid", gridTemplateColumns: FACT_COLS, gap: 14, fontSize: 10, fontWeight: 700, color: "var(--navy-300)", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
      <span>Fecha</span>
      <span>Servicio</span>
      <span>Obra social</span>
      <span>OS (prestadora)</span>
      <span>Copago (paciente)</span>
      <span style={{ textAlign: "right" }}>Turno</span>
    </div>
  );
  const row = (b: PatientBookingFull, plan: PlanGroupMeta | null) => {
    const hasOS = b.obraSocial.toLowerCase() !== "particular" && b.osAmountCents > 0;
    const ord = plan ? bookingPlanOrdinal(b, plan) : null;
    const offStatus = b.status === "CANCELLED" || b.status === "NO_SHOW";
    return (
      <div
        key={b.id}
        data-testid="fact-row"
        data-plan={b.programId ?? undefined}
        style={{ padding: "14px 18px", display: "grid", gridTemplateColumns: FACT_COLS, gap: 14, alignItems: "center", fontSize: 13, borderBottom: "1px solid rgba(15,30,51,0.04)", opacity: offStatus ? 0.75 : 1 }}
      >
        <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)" }}>
          {new Date(b.scheduledFor).toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "2-digit", timeZone: "America/Argentina/Buenos_Aires" })}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {ord && plan && (
            <DisciplineChip discipline={plan.discipline} ordinal={ord.ordinal} totalLive={ord.totalLive} size="xs" />
          )}
          <span style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.serviceName}</span>
        </span>
        <span style={{ color: "var(--navy-500)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {hasOS ? b.obraSocial : "Particular"}
        </span>
        <PaidCell amountCents={b.osAmountCents} paid={!!b.insurerPaidAt} available={hasOS} pending={pending} onToggle={(n) => confirmOS(b, n)} />
        <PaidCell amountCents={b.copagoCents} paid={b.paymentStatus === "PAID"} available pending={pending} onToggle={(n) => confirmCopago(b, n)} />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
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
    <div style={{ fontSize: 11, color: "var(--navy-300)", paddingLeft: 4, lineHeight: 1.5 }}>
      <strong>OS</strong> = monto que reintegra la obra social al consultorio · <strong>Copago</strong> = lo que abona el paciente. Tocá «Confirmar» en cada lado cuando lo cobres.
      {grouped && (
        <> En cada plan, «Pendiente» es lo realizado que falta cobrar; lo que paga la obra social va aparte.</>
      )}
    </div>
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
                <div style={{ padding: 16, textAlign: "center", color: "var(--navy-300)", fontSize: 12.5 }}>
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
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {summaryCard}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {visible.length === 0 ? (
          <>
            {columnsHeader}
            <div style={{ padding: 24, textAlign: "center", color: "var(--navy-300)", fontSize: 13 }}>
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
    </div>
  );
}
