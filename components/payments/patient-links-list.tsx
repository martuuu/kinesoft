"use client";

/**
 * [TP-3f2] Plata online en Facturación del paciente (§25.10 «Facturación del paciente»):
 *
 * - card **«Links de pago»** con `listPatientOnlineCharges`: estado (en texto, nunca solo color), monto, vencimiento en
 *   hora AR y, en el link que todavía se puede pagar, Copiar / Reenviar / Anular; los pagados tienen su «Comprobante».
 *   «Nuevo link de pago» abre el `PaymentLinkDrawer` compartido SIN turno (`booking: null`, cobro `FREE`).
 * - modal **«Comprobante»** (TP-UI-D11: en Facturación es un Modal, no el plegable del drawer) con `MpReceiptView`
 *   `plain`, para la fila de un turno (`getBookingOnlineCharges`) o para un link pagado de la lista.
 *
 * La lista es de **links** (`origin: LINK`): el cobro del turnero es la seña o el pago de su turno y ya se ve en la fila
 * (seña, «Pagado por Mercado Pago» y su comprobante). Repetirlo acá lo hacía parecer otra plata.
 *
 * Costo (§25.11, `/pacientes/[id]` +0): este módulo entra ESTÁTICO al chunk de la pestaña Facturación, que ya es
 * diferido (`TAB_LOADERS.fact`): no suma un chunk nuevo (TP-2i: cada chunk diferido nuevo engorda el runtime de TODAS
 * las rutas). El `PaymentLinkDrawer` sí baja por `import()`, el MISMO que usa la sección de plata del drawer del turno,
 * así webpack reusa su chunk. La lista se pide una vez al abrir la pestaña y solo si la card se monta
 * (`linksCardWanted`); el comprobante de un turno, recién al tocar «Comprobante».
 */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { canCollectCopago, type Capability } from "@/lib/capabilities";
import { toARDateKey } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import { buildMpReceipt } from "@/lib/mp-receipt";
import { getBookingOnlineCharges, listPatientOnlineCharges } from "@/lib/online-charges-read";
import { BOOKING_MONEY_COPY, CHARGE_KIND_LABEL, RECEIPT_COPY } from "@/lib/online-payments-copy";
import type { OnlineChargeView } from "@/lib/online-payments-types";
import { cancelPaymentLink } from "@/lib/payment-links";
import { MpReceiptView } from "./mp-receipt-view";
import { PaymentLinkShare } from "./payment-link-share";
import type { PaymentLinkPractitionerOption } from "./payments-ui-types";

const PaymentLinkDrawer = dynamic(() => import("./payment-link-drawer").then((m) => m.PaymentLinkDrawer), { ssr: false });

const NETWORK_ERROR = "Revisá la conexión y reintentá.";

export const PATIENT_LINKS_COPY = {
  title: "Links de pago",
  empty: "Sin links de pago para este paciente.",
  loading: "Cargando links de pago…",
  resend: "Reenviar",
  resendTitle: "Reenviar link de pago",
  noReceipts: "Todavía no hay pagos acreditados por Mercado Pago.",
  receiptsLoading: "Cargando comprobante…",
  expires: (dm: string) => `Vence ${dm}`,
  created: (dm: string) => `Del ${dm}`,
} as const;

/** Mismo texto que el drawer del turno (`booking-money-section.tsx`): anular un link se confirma igual en todos lados. */
const LINK_CANCEL_CONFIRM = {
  title: "¿Anular el link de pago?",
  message: "El paciente ya no va a poder pagar con este link.",
  confirmLabel: "Anular link",
  tone: "danger",
} as const;

// ── Lógica pura (exportada para el test) ────────────────────────────────────────────────────────────────────────────

type BillingAccess = { capabilities: readonly Capability[]; practitionerId: string | null };

/**
 * ¿Se monta la card? Hace falta el paciente, que el consultorio tenga los cobros online prendidos (con
 * `MP_CONNECT_MODE=off` lo que no funciona no se muestra, decisión del orquestador en TP-3a) y que el viewer cobre algo
 * (`billing.collect`, o `collectOwn` sobre sus turnos: el mismo criterio que `listPatientOnlineCharges`). Sin
 * `billingAccess` (caller de antes de T3) decide el server.
 */
export function linksCardWanted(o: { patientId: string | null | undefined; onlinePayments: boolean | undefined; billingAccess?: BillingAccess }): boolean {
  if (!o.patientId || !o.onlinePayments) return false;
  if (!o.billingAccess) return true;
  const caps = o.billingAccess.capabilities;
  return caps.includes("billing.collect") || caps.includes("billing.collectOwn");
}

/**
 * ¿La fila del turno ofrece «Comprobante»? Solo si Mercado Pago acreditó algo de ESE turno con el flujo nuevo: una
 * seña (`onlineDepositCents`), el pago entero por webhook (medio Mercado Pago sin quién cobró, C-TP10) o un reintegro.
 * AUTHORIZED no: todavía no hay comprobante. Un «Mercado Pago» registrado a mano (con quién cobró) tampoco: no pasó por
 * Mercado Pago de la app. Así un turno sin plata online no dispara ninguna lectura.
 */
export function rowReceiptWanted(b: {
  onlineDepositCents?: number | null;
  paymentStatus?: string | null;
  copagoPaymentMethod?: string | null;
  copagoCollectedById?: string | null;
}): boolean {
  if ((b.onlineDepositCents ?? 0) > 0) return true;
  if (b.paymentStatus === "REFUNDED") return true;
  return b.paymentStatus === "PAID" && b.copagoPaymentMethod === "MERCADO_PAGO" && b.copagoCollectedById === null;
}

/** Los links del paciente (el cobro del turnero vive en su turno). */
export function linkRowsOf(charges: readonly OnlineChargeView[]): OnlineChargeView[] {
  return charges.filter((c) => c.origin === "LINK");
}

/**
 * Profesionales a los que se puede hacer un link sin turno. Sale de la lista del consultorio si el caller la pasa;
 * si no, de los turnos del paciente (los profesionales que lo atienden, que es el caso de todos los días). Quien cobra
 * solo lo suyo (`collectOwn`) ve solo su profesional, el mismo filtro que aplica `createPaymentLink`. El default es el
 * profesional del viewer si está en la lista (el drawer ya elige solo cuando hay uno).
 */
export function linkPractitionerOptions(o: {
  bookings: readonly { practitionerId: string; practitionerName?: string | null }[];
  explicit: readonly PaymentLinkPractitionerOption[] | null | undefined;
  caps: ReadonlySet<Capability> | null;
  viewerPractitionerId: string | null;
}): { options: PaymentLinkPractitionerOption[]; defaultId: string | null } {
  let all: PaymentLinkPractitionerOption[];
  if (o.explicit && o.explicit.length > 0) {
    all = [...o.explicit];
  } else {
    const seen = new Map<string, string>();
    for (const b of o.bookings) if (!seen.has(b.practitionerId)) seen.set(b.practitionerId, b.practitionerName ?? "");
    all = [...seen].map(([id, name]) => ({ id, name }));
  }
  const options = o.caps ? all.filter((p) => canCollectCopago(o.caps!, o.viewerPractitionerId, p.id)) : all;
  const defaultId = o.viewerPractitionerId && options.some((p) => p.id === o.viewerPractitionerId) ? o.viewerPractitionerId : null;
  return { options, defaultId };
}

/** `dd/mm` en hora AR (un link que vence a las 23:30 AR vence ese día, aunque en UTC ya sea el siguiente). */
function arDayMonth(iso: string): string {
  const [, mm, dd] = toARDateKey(iso).split("-");
  return `${dd}/${mm}`;
}

function receiptOf(c: OnlineChargeView) {
  return c.receipt ? buildMpReceipt({ mpPaymentId: c.receipt.operationId, ...c.receipt }) : null;
}

// ── Comprobante ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReceiptsState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; charges: readonly OnlineChargeView[] };

/** Cuerpo del modal «Comprobante»: un comprobante plano por cada pago acreditado (seña, pago, reintegrado). */
export function ChargeReceiptsBody({ state }: { state: ReceiptsState }) {
  if (state.status === "loading") return <p style={mutedP}>{PATIENT_LINKS_COPY.receiptsLoading}</p>;
  if (state.status === "error") {
    return (
      <p role="alert" style={{ ...mutedP, color: "var(--danger-fg)" }}>
        {state.error}
      </p>
    );
  }
  const items = state.charges.flatMap((c) => {
    const r = receiptOf(c);
    return r ? [{ c, r }] : [];
  });
  if (items.length === 0) return <p style={mutedP}>{PATIENT_LINKS_COPY.noReceipts}</p>;
  return (
    <div style={{ display: "grid", gap: 18 }}>
      {items.map(({ c, r }) => (
        <section key={c.id} data-charge={c.id} aria-label={`${CHARGE_KIND_LABEL[c.kind]} · ${formatARS(c.amountCents)}`}>
          {items.length > 1 && (
            <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 700, color: "var(--navy-700)" }}>
              {CHARGE_KIND_LABEL[c.kind]} · {formatARS(c.amountCents)} · {c.statusLabel}
            </p>
          )}
          <MpReceiptView receipt={r} variant="plain" />
        </section>
      ))}
    </div>
  );
}

/**
 * Modal «Comprobante». `source` null = cerrado (el Modal queda montado para la animación de salida). Con `bookingId`
 * lee los cobros del turno al abrir; con `charge` (un link pagado de la lista) ya tiene los datos.
 */
export function ChargeReceiptsModal({
  source,
  onClose,
}: {
  source: { bookingId: string } | { charge: OnlineChargeView } | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<ReceiptsState>({ status: "loading" });
  const bookingId = source && "bookingId" in source ? source.bookingId : null;
  const direct = source && "charge" in source ? source.charge : null;
  useEffect(() => {
    if (!bookingId) return;
    let alive = true;
    setState({ status: "loading" });
    getBookingOnlineCharges({ bookingId })
      .then((r) => alive && setState(r.ok ? { status: "ready", charges: r.data } : { status: "error", error: r.error }))
      .catch(() => alive && setState({ status: "error", error: NETWORK_ERROR }));
    return () => {
      alive = false;
    };
  }, [bookingId]);
  const shown: ReceiptsState = direct ? { status: "ready", charges: [direct] } : state;
  return (
    <Modal open={source != null} onClose={onClose} title={RECEIPT_COPY.title} width={460}>
      {source && <ChargeReceiptsBody state={shown} />}
    </Modal>
  );
}

// ── Card «Links de pago» ────────────────────────────────────────────────────────────────────────────────────────────

export type PatientLinksBodyProps = {
  rows: readonly OnlineChargeView[];
  loading: boolean;
  error: string | null;
  canCreate: boolean;
  /** El link que se está anulando (deshabilita sus botones). */
  busyId: string | null;
  onNew: () => void;
  onCopy: (url: string) => void;
  onResend: (c: OnlineChargeView) => void;
  onCancel: (chargeId: string) => void;
  onReceipt: (c: OnlineChargeView) => void;
};

const mutedP = { margin: 0, fontSize: 12.5, color: "var(--navy-500)" } as const;
const actionsRow = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" } as const;
const LIVE: ReadonlySet<OnlineChargeView["status"]> = new Set(["ACTIVE", "AUTHORIZED"]);

/** Lo que se ve, sin estado ni red (exportado para el render test: los efectos no corren en el render de servidor). */
export function PatientLinksBody({ rows, loading, error, canCreate, busyId, onNew, onCopy, onResend, onCancel, onReceipt }: PatientLinksBodyProps) {
  return (
    <Card data-testid="patient-links" style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 18px",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>{PATIENT_LINKS_COPY.title}</h3>
        {canCreate && (
          <Button type="button" variant="ghost" size="sm" onClick={onNew}>
            {BOOKING_MONEY_COPY.newLink}
          </Button>
        )}
      </div>
      {loading ? (
        <p role="status" style={{ ...mutedP, padding: "14px 18px" }}>
          {PATIENT_LINKS_COPY.loading}
        </p>
      ) : error ? (
        <p role="alert" style={{ ...mutedP, padding: "14px 18px", color: "var(--danger-fg)" }}>
          {error}
        </p>
      ) : rows.length === 0 ? (
        <p style={{ ...mutedP, padding: "14px 18px" }}>{PATIENT_LINKS_COPY.empty}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((c) => {
            const live = c.status === "ACTIVE" && c.link ? c.link : null;
            const busy = busyId === c.id;
            const when = LIVE.has(c.status) ? PATIENT_LINKS_COPY.expires(arDayMonth(c.expiresAt)) : PATIENT_LINKS_COPY.created(arDayMonth(c.createdAt));
            return (
              <li
                key={c.id}
                data-charge={c.id}
                data-status={c.status}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px 14px",
                  padding: "12px 18px",
                  borderBottom: "1px solid rgba(15,30,51,0.04)",
                  fontSize: 13,
                }}
              >
                <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span className="k-mono" style={{ fontWeight: 700, color: "var(--navy-900)" }}>
                      {formatARS(c.amountCents)}
                    </span>
                    {/* El estado va en texto (no solo color): «Pendiente de pago», «Pagado», «Vencido», «Anulado»… */}
                    <span style={{ fontSize: 11, fontWeight: 700, color: c.status === "PAID" ? "var(--success-fg)" : "var(--navy-500)" }}>
                      {c.statusLabel}
                    </span>
                  </span>
                  <span style={{ fontSize: 12, color: "var(--navy-500)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {[c.concept, when, c.practitionerName].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <div style={actionsRow}>
                  {live && (
                    <Button type="button" variant="ghost" size="sm" className="k-tap-m" onClick={() => onCopy(live.url)}>
                      {BOOKING_MONEY_COPY.copy}
                    </Button>
                  )}
                  {live?.canResend && (
                    <Button type="button" variant="ghost" size="sm" className="k-tap-m" onClick={() => onResend(c)}>
                      {PATIENT_LINKS_COPY.resend}
                    </Button>
                  )}
                  {live?.canCancel && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="k-tap-m"
                      disabled={busy}
                      aria-busy={busy || undefined}
                      onClick={() => onCancel(c.id)}
                    >
                      {BOOKING_MONEY_COPY.cancelLink}
                    </Button>
                  )}
                  {c.receipt && (
                    <Button type="button" variant="ghost" size="sm" className="k-tap-m" onClick={() => onReceipt(c)}>
                      {BOOKING_MONEY_COPY.receipt}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export type PatientLinksListProps = {
  patientId: string;
  /** Solo para el aviso «… no tiene email cargado.» del reenvío (nunca viaja al link). */
  patientName: string;
  /** Profesionales para un link sin turno (ya filtrados por `linkPractitionerOptions`). */
  practitioners: PaymentLinkPractitionerOption[];
  defaultPractitionerId: string | null;
  /** Se creó o anuló un link (o cambió la plata): el caller puede refrescar lo suyo. */
  onChanged?: () => void;
};

export function PatientLinksList({ patientId, patientName, practitioners, defaultPractitionerId, onChanged }: PatientLinksListProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [charges, setCharges] = useState<OnlineChargeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Una instancia nueva del drawer por apertura (`key`): la idempotencia de `createPaymentLink` es por instancia (TP-3d).
  const [newLinkKey, setNewLinkKey] = useState<number | null>(null);
  const [resending, setResending] = useState<OnlineChargeView | null>(null);
  const [receipt, setReceipt] = useState<OnlineChargeView | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    listPatientOnlineCharges({ patientId })
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setCharges(r.data);
          setError(null);
        } else setError(r.error);
      })
      .catch(() => alive && setError(NETWORK_ERROR));
    return () => {
      alive = false;
    };
  }, [patientId, reload]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copiado");
    } catch {
      toast.error("No pudimos copiar el link", { description: url });
    }
  }

  async function cancelLink(chargeId: string) {
    if (inFlight.current) return;
    if (!(await confirm(LINK_CANCEL_CONFIRM))) return;
    inFlight.current = true;
    setBusyId(chargeId);
    try {
      const res = await cancelPaymentLink({ chargeId });
      if (!res.ok) {
        toast.error("No pudimos anular el link", { description: res.error });
        return;
      }
      toast.success("Link de pago anulado");
      setReload((n) => n + 1);
      onChanged?.();
    } catch {
      toast.error("No pudimos anular el link", { description: NETWORK_ERROR });
    } finally {
      inFlight.current = false;
      setBusyId(null);
    }
  }

  return (
    <>
      <PatientLinksBody
        rows={linkRowsOf(charges ?? [])}
        loading={charges === null && error === null}
        error={error}
        canCreate={practitioners.length > 0}
        busyId={busyId}
        onNew={() => setNewLinkKey(Date.now())}
        onCopy={(url) => void copy(url)}
        onResend={setResending}
        onCancel={(id) => void cancelLink(id)}
        onReceipt={setReceipt}
      />
      {newLinkKey != null && (
        <PaymentLinkDrawer
          key={newLinkKey}
          open
          onClose={() => setNewLinkKey(null)}
          surface="facturacion"
          patient={{ id: patientId, name: patientName }}
          booking={null}
          practitioners={practitioners}
          defaultPractitionerId={defaultPractitionerId}
          onCreated={() => {
            setReload((n) => n + 1);
            onChanged?.();
          }}
        />
      )}
      <Modal open={resending != null} onClose={() => setResending(null)} title={PATIENT_LINKS_COPY.resendTitle} width={460}>
        {resending?.link && <PaymentLinkShare chargeId={resending.id} url={resending.link.url} patientName={patientName} />}
      </Modal>
      <ChargeReceiptsModal source={receipt ? { charge: receipt } : null} onClose={() => setReceipt(null)} />
    </>
  );
}
