"use client";

import { useMemo, useState, useTransition, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconCheck } from "@/components/ui/icons";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { rememberPaymentMethod } from "@/components/billing/payment-method-picker";
import { CollectForm, validateCollect } from "@/components/agenda/booking-drawer/collect-modal";
import { setBookingInsurerPaid, setBookingCopagoPaid } from "@/lib/bookings";
import { isPublicReservation } from "@/lib/booking-capacity";
import {
  COLLECT_COPY,
  UNDO_COLLECT_CONFIRM,
  collectImputationLine,
  collectModalDescription,
  copagoCollectViewFor,
  copagoRemainingCents,
  type CopagoCollectView,
} from "@/lib/booking-collect";
import { canCollectCopago, canConfirmInsurer, type Capability } from "@/lib/capabilities";
import { formatARS } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/payment-method";
import { isStaleError } from "@/lib/reception-view-state";
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

/** Chip «pagado» (OS y copago): el mismo verde en las dos columnas. */
const PAID_CHIP = { display: "inline-flex", alignItems: "center", gap: 4, border: "none", background: "var(--success-bg)", color: "var(--success-fg)", fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999 } as const;
/** Botón «Confirmar» / «Cobrar». `k-tap-m` lo lleva a 44 px bajo 768 (T3-Z M2: medía ~22 px en el teléfono). */
const ACTION_PILL = { display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--sky-700)", color: "var(--sky-700)", background: "rgba(31,79,190,0.06)", cursor: "pointer", fontSize: 10.5, fontWeight: 700, padding: "3px 8px", borderRadius: 999 } as const;

/**
 * Monto + «Confirmar / Cobrado» de la obra social (lo que la OS le reintegra al consultorio).
 *
 * `canToggle=false` deja solo el estado, sin botón: la Secretaria no confirma pagos de obra social
 * (`canConfirmInsurer`). El server decide igual.
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
  const paidChip = PAID_CHIP;
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
          className="k-tap-m"
          title={`${paidLabel} · tocá para deshacer`}
          aria-label={`${paidLabel}. Deshacer`}
          style={{ ...paidChip, cursor: "pointer" }}
        >
          <IconCheck size={9} stroke={3} /> {paidLabel}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onToggle(true)}
          disabled={pending}
          className="k-tap-m"
          style={ACTION_PILL}
        >
          Confirmar
        </button>
      )}
    </div>
  );
}

/**
 * Monto + estado/acción del copago (T3-Z, A3/M1). El estado sale de `copagoCollectViewFor`, el mismo del drawer: un
 * cobro AUTHORIZED de Mercado Pago dice «Pago retenido por Mercado Pago» sin botón (antes se ofrecía como
 * pendiente), REFUNDED no tiene botón y una reserva pública pagada por MP sin medio dice «Pagado por Mercado Pago»
 * sin deshacer (antes «Pagado · Sin informar» con deshacer, que el server rechazaba). La acción dice «Cobrar», como el
 * drawer y /sala (antes «Confirmar», el verbo de la obra social).
 */
function CopagoCell({
  amountCents,
  view,
  pending,
  onCollect,
  onUndo,
}: {
  amountCents: number;
  view: CopagoCollectView;
  pending: boolean;
  onCollect: () => void;
  onUndo: () => void;
}) {
  const paid = view.label?.startsWith("Pagado") ?? false;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <span className="k-mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>
        {formatARS(amountCents)}
      </span>
      {view.action === "collect" ? (
        <button type="button" onClick={onCollect} disabled={pending} className="k-tap-m" style={ACTION_PILL}>
          Cobrar
        </button>
      ) : view.action === "undo" && view.label ? (
        <button
          type="button"
          onClick={onUndo}
          disabled={pending}
          className="k-tap-m"
          title={`${view.label} · tocá para deshacer`}
          aria-label={`${view.label}. Deshacer cobro`}
          style={{ ...PAID_CHIP, cursor: "pointer" }}
        >
          <IconCheck size={9} stroke={3} /> {view.label}
        </button>
      ) : view.label && paid ? (
        <span style={PAID_CHIP}>
          <IconCheck size={9} stroke={3} /> {view.label}
        </span>
      ) : view.label ? (
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--navy-500)" }}>{view.label}</span>
      ) : null}
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
  /** Nombre del paciente para la descripción del modal «Registrar cobro» (B2). Sin él, servicio · día y hora. */
  patientName?: string;
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
  patientName,
}: FacturacionViewProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  // T3: el turno cuyo cobro se está registrando (modal con el medio de pago, obligatorio) y el medio elegido.
  const [collecting, setCollecting] = useState<PatientBookingFull | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
  // T3-Z (A2): deshacer pregunta con el MISMO confirm que el drawer (antes un toque al chip lo deshacía sin avisar).
  // Confirmado, va optimista como el toggle de la OS.
  const undoCopago = async (b: PatientBookingFull) => {
    if (pending || saving) return;
    const ok = await confirm(UNDO_COLLECT_CONFIRM(formatARS(b.copagoCents)));
    if (!ok) return;
    patchBooking(b.id, { paymentStatus: "UNPAID", copagoPaymentMethod: null });
    start(async () => {
      const r = await setBookingCopagoPaid(b.id, { paid: false }, new Date(b.updatedAt).toISOString());
      if (!r.ok) {
        patchBooking(b.id, { paymentStatus: b.paymentStatus, copagoPaymentMethod: b.copagoPaymentMethod });
        toast.error(COLLECT_COPY.undoFailed, { description: r.error });
        return;
      }
      patchBooking(b.id, { updatedAt: new Date(r.data.updatedAt), copagoPaymentMethod: null });
      toast.success("Cobro deshecho", r.data.notice ? { description: r.data.notice } : undefined);
      onBillingChanged?.();
    });
  };
  const openCollect = (b: PatientBookingFull) => {
    setMethod(null);
    setMethodError(null);
    setCollecting(b);
  };
  const closeCollect = () => {
    if (!saving) setCollecting(null);
  };
  // Cobrar ya no es optimista (T3-Z M1): el modal espera al server como en el drawer y /sala, y el toast dice el monto
  // y el medio. Antes cerraba al toque y, si el server rechazaba (MP, permiso, stale), el «Pagado» se deshacía solo.
  const submitCollect = async () => {
    if (!collecting || saving) return;
    const v = validateCollect(method);
    if (!v.ok) {
      setMethodError(v.error);
      return;
    }
    const b = collecting;
    const amount = copagoRemainingCents({ resolvedCopagoCents: b.copagoCents, deposits: [] });
    setSaving(true);
    let r: Awaited<ReturnType<typeof setBookingCopagoPaid>>;
    try {
      r = await setBookingCopagoPaid(b.id, { paid: true, method: v.method }, new Date(b.updatedAt).toISOString());
    } catch {
      r = { ok: false, error: "Revisá la conexión y reintentá." };
    }
    setSaving(false);
    if (r.ok) {
      rememberPaymentMethod(v.method);
      patchBooking(b.id, { paymentStatus: "PAID", copagoPaymentMethod: r.data.method, updatedAt: new Date(r.data.updatedAt) });
      toast.success(
        `Cobro registrado · ${formatARS(amount)} · ${PAYMENT_METHOD_LABEL[v.method]}`,
        r.data.notice ? { description: r.data.notice } : undefined
      );
      setCollecting(null);
      onBillingChanged?.();
      return;
    }
    if (isStaleError(r.error)) {
      toast.warning("El turno cambió en otra sesión", { description: "Recargá la ficha para ver lo último." });
      setCollecting(null);
      return;
    }
    toast.error(COLLECT_COPY.collectFailed, { description: r.error });
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
          <CopagoCell
            amountCents={b.copagoCents}
            view={copagoCollectViewFor(
              {
                ...b,
                publicReservation: isPublicReservation({ idempotencyKey: b.idempotencyKey, patientId: b.patientId }),
              },
              canCollect(b)
            )}
            pending={pending || saving}
            onCollect={() => openCollect(b)}
            onUndo={() => void undoCopago(b)}
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
      <strong>OS</strong> = monto que reintegra la obra social al consultorio · <strong>Copago</strong> = lo que abona el paciente. Tocá «Cobrar» cuando pague el paciente y «Confirmar» cuando pague la obra social.
      {grouped && (
        <> En cada plan, «Pendiente» es lo realizado que falta cobrar; lo que paga la obra social va aparte.</>
      )}
    </div>
  );

  const collectModal = (
    <FacturacionCollectModal
      collecting={collecting}
      patientName={patientName}
      method={method}
      onMethod={(m) => {
        setMethod(m);
        setMethodError(null);
      }}
      error={methodError}
      saving={saving}
      onClose={closeCollect}
      onConfirm={() => void submitCollect()}
    />
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

/**
 * Modal «Registrar cobro» de Facturación. El mismo cuerpo que el modal del drawer (`CollectForm`, T3-Z M1): antes
 * Facturación tenía una copia propia sin la nota, sin el estado «Registrando…» y con los botones sin apilar en el
 * teléfono. T3-Y: componente aparte (exportado) para que el render test vea la línea «Se imputa a …» sin depender del
 * estado del view; el nombre público viene en la fila (`PatientBookingFull.practitionerName`).
 */
export function FacturacionCollectModal({
  collecting,
  patientName,
  method,
  onMethod,
  error,
  saving,
  onClose,
  onConfirm,
}: {
  /** null = cerrado (el Modal queda montado para la animación de salida). */
  collecting: PatientBookingFull | null;
  patientName?: string;
  method: PaymentMethod | null;
  onMethod: (m: PaymentMethod) => void;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const amount = collecting ? copagoRemainingCents({ resolvedCopagoCents: collecting.copagoCents, deposits: [] }) : 0;
  return (
    <Modal
      open={collecting != null}
      onClose={onClose}
      title="Registrar cobro"
      description={
        collecting
          ? collectModalDescription({ patientName: patientName ?? "", serviceName: collecting.serviceName, scheduledFor: collecting.scheduledFor })
          : undefined
      }
      width={460}
    >
      {collecting && (
        <CollectForm
          amountCents={amount}
          imputation={collectImputationLine({ practitionerId: collecting.practitionerId, practitionerName: collecting.practitionerName })}
          method={method}
          onMethod={onMethod}
          error={error}
          saving={saving}
          onCancel={onClose}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  );
}
