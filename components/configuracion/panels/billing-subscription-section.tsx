"use client";

/**
 * Configuración → Facturación → «Suscripción» (MPS-4a, brief §26.6 UI, contrato C-MPS10; MPS-D18/D19/D21/D24).
 *
 * Chunk aparte: `billing-panel.tsx` lo baja con `next/dynamic` solo si el modo no es `off` (techo de /configuracion
 * 141,8 kB con 141,7 medido en TV-I: nada de esto puede entrar al JS inicial, y con `off` no tiene función).
 *
 * Qué muestra (regla de Martin: oculto si no tiene función; la decisión de cada pieza es pura y testeada en
 * `lib/saas-billing-view.ts`):
 *  - «Cómo pagás» SIN preselección (solo `mp`): débito automático / Mercado Pago cada mes / transferencia. Elegir el
 *    débito abre el drawer del email de MP (MPS-D21: lo tipea el usuario) y manda a autorizar; las otras dos se guardan
 *    con `setCollectionMethod`. AUTO_DEBIT nunca se guarda desde acá: llega cuando MP confirma la autorización.
 *  - Estado del débito: pendiente (seguir en MP / cancelar), activo (cambiar tarjeta / dejar de usarlo), rechazado
 *    (pagar el cargo con MP antes del 9), en pausa; y el aviso de plan sin precio (MPS-2b1 `no_price`).
 *  - Bajada de plan programada con «Anular el cambio de plan»; baja a fin de período con `useConfirm`, «Deshacer baja»
 *    y, ya dada de baja, «Reactivar suscripción». Con `manual` esto sí aplica (las actions lo permiten sin MP).
 *  - Desglose del próximo cargo (base + ajustes − saldo) y el proporcional del primer período.
 *  - La vuelta de Mercado Pago (`cargo` + `payment_id` → `confirmCheckoutReturn`; `debito=1` → `refreshAutoDebit`): se
 *    lee una vez al montar y se BORRA de la URL antes de llamar (un refresh no re-confirma ni el link copiado lleva el
 *    id del pago). El server re-pide el pago a MP y valida que sea de este consultorio: la query no es confiable.
 *
 * Step-up (PL-D11): elegir cómo pagar, activar el débito, la baja y reactivar piden la 2FA. Esta sección monta su
 * propio `StepUpProvider` (la pestaña Facturación no lo tenía: hasta MPS-4a nada de acá lo pedía) y los errores —el
 * cancelado del modal incluido— se muestran como el resto del panel, en el `role="alert"` de la tarjeta.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { StepUpProvider, useStepUpAction } from "@/components/account/step-up-modal";
import {
  cancelScheduledPlanChange,
  confirmCheckoutReturn,
  payChargeWithMp,
  reactivateSubscription,
  refreshAutoDebit,
  scheduleCancel,
  setCollectionMethod,
  startAutoDebit,
  undoCancel,
} from "@/lib/saas-billing-mp";
import type { BillingOverview, SaasCollectionMethod } from "@/lib/saas-billing-types";
import {
  SUBSCRIPTION_COPY as C,
  autoDebitBand,
  cancelConfirmMessage,
  cancelEffectiveOnPreview,
  collectionChoices,
  dayMonthKey,
  firstPeriodNotice,
  nextChargeLines,
  noPriceNotice,
  parseBillingReturn,
  stripBillingReturn,
} from "@/lib/saas-billing-view";

const NETWORK_ERROR = "No pudimos conectarnos. Revisá la conexión y probá de nuevo.";

type Props = { overview: BillingOverview; onChanged: () => Promise<void> | void };

export function BillingSubscriptionSection(props: Props) {
  if (props.overview.mode === "off") return null;
  return (
    <StepUpProvider>
      <SubscriptionInner {...props} />
    </StepUpProvider>
  );
}

/** Solo URLs http(s): el `initPoint` lo arma MP (o el simulador en dev); nunca un `javascript:`. */
function goTo(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    window.location.assign(u.toString());
    return true;
  } catch {
    return false;
  }
}

const band: React.CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "12px 14px",
  borderRadius: "var(--r-sm)",
  background: "rgba(15,30,51,0.04)",
  fontSize: 13.5,
  color: "var(--navy-700)",
  lineHeight: 1.5,
};
const warnBand: React.CSSProperties = { ...band, background: "var(--warn-bg)", color: "var(--warn-fg)" };
const actions: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };

function SubscriptionInner({ overview: o, onChanged }: Props) {
  const runStepUp = useStepUpAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [debitOpen, setDebitOpen] = useState(false);
  const handledReturn = useRef(false);

  const mp = o.mode === "mp";

  // Vuelta de Mercado Pago: una sola vez por montaje (el StrictMode de dev monta dos veces; el ref lo corta).
  useEffect(() => {
    if (handledReturn.current || !mp) return;
    handledReturn.current = true;
    let ret: ReturnType<typeof parseBillingReturn> = null;
    try {
      ret = parseBillingReturn(window.location.search);
      if (ret) window.history.replaceState(window.history.state, "", stripBillingReturn(window.location.href));
    } catch {
      /* sin history: se procesa igual */
    }
    if (!ret || ret.kind === "none") return;
    const r = ret;
    void (async () => {
      setBusy("return");
      try {
        if (r.kind === "checkout") {
          const res = await confirmCheckoutReturn({ paymentId: r.paymentId, ...(r.chargeId ? { chargeId: r.chargeId } : {}) });
          if (!res.ok) setError(res.error);
          else setNotice(res.data.outcome === "rejected" ? C.paymentRejected : C.paymentReceived);
        } else {
          const res = await refreshAutoDebit();
          if (!res.ok) setError(res.error);
          else setNotice(res.data.status === "active" ? C.debitAuthorized : C.debitNotYet);
        }
        await onChanged();
      } catch {
        setError(NETWORK_ERROR);
      } finally {
        setBusy(null);
      }
    })();
  }, [mp, onChanged]);

  /** Corre una action (con step-up si `stepUp`), muestra su error como el resto del panel y recarga si salió bien. */
  async function run<T>(
    key: string,
    fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
    o2: { stepUp?: boolean; success?: string; after?: (data: T) => boolean | void } = {}
  ) {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const r = o2.stepUp ? await runStepUp(fn) : await fn();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // `after` devuelve true si navegó a Mercado Pago: no hace falta recargar (la página se va).
      if (o2.after?.(r.data) === true) return;
      if (o2.success) toast.success(o2.success);
      await onChanged();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  }

  const cancelled = o.subscriptionStatus === "CANCELLED";
  const cancelPending = !!o.cancel && !cancelled;
  const choices = collectionChoices(o);
  const debitBand = autoDebitBand(o);
  const noPrice = noPriceNotice(o);
  const lines = nextChargeLines(o);
  const firstPeriod = firstPeriodNotice({
    billableFrom: o.billableFrom,
    nextChargeOn: o.nextCharge?.periodStart,
    priceCents: o.nextCharge?.breakdown?.baseCents ?? o.effectivePriceCents,
    hasCharges: o.charges.length > 0,
  });
  const debitLive = debitBand?.kind === "active" || debitBand?.kind === "failed";
  // Con el débito activo o pendiente el selector se esconde: las acciones están en la banda. «Dejar de usar el débito»
  // lo vuelve a mostrar sin el débito.
  const hideSelector = debitBand?.kind === "pending" || (debitBand?.kind === "active" && !choosing);
  const shownChoices = choosing ? choices.filter((m) => m !== "AUTO_DEBIT") : choices;

  function chooseMethod(m: SaasCollectionMethod) {
    if (m === "AUTO_DEBIT") {
      setDebitOpen(true);
      return;
    }
    if (m === o.collectionMethod && !choosing) return;
    void run(`method:${m}`, () => setCollectionMethod({ method: m }), {
      stepUp: true,
      success: m === "TRANSFER" ? "Listo: vas a pagar por transferencia." : "Listo: vas a pagar con Mercado Pago cada mes.",
      after: () => {
        setChoosing(false);
      },
    });
  }

  /** «Cancelar» del débito pendiente: vuelve a la forma de pago que tenía (o transferencia si nunca eligió). */
  function cancelPendingDebit() {
    const back: "TRANSFER" | "MP_CHECKOUT" = o.collectionMethod === "MP_CHECKOUT" ? "MP_CHECKOUT" : "TRANSFER";
    void run("debit:cancel", () => setCollectionMethod({ method: back }), { stepUp: true });
  }

  function continuePendingDebit() {
    const url = o.autoDebit?.initPoint;
    if (url && goTo(url)) return;
    // Sin link guardado (venció o no se pudo leer): se arma uno nuevo con el email.
    setDebitOpen(true);
  }

  function payLastCharge() {
    void run("pay", () => payChargeWithMp({}), {
      after: (d) => {
        if (goTo(d.initPoint)) return true;
        setError(NETWORK_ERROR);
      },
    });
  }

  async function askCancel() {
    const effectiveOn = cancelEffectiveOnPreview(o, new Date());
    const ok = await confirm({
      title: C.cancelTitle,
      message: cancelConfirmMessage(effectiveOn, debitLive),
      tone: "danger",
      confirmLabel: C.cancelButton,
      cancelLabel: "Volver",
    });
    if (!ok) return;
    void run("cancel", () => scheduleCancel(), { stepUp: true, success: "Listo: programamos la baja." });
  }

  return (
    <Card style={{ padding: 20, display: "grid", gap: 14 }} data-subscription={o.subscriptionStatus}>
      <EyebrowLabel>Suscripción</EyebrowLabel>

      {notice && (
        <p role="status" data-billing-notice style={{ ...band, background: "var(--sky-50)", margin: 0 }}>
          {notice}
        </p>
      )}

      {o.pendingPlan && !cancelled && (
        <div data-pending-plan={o.pendingPlan.plan} style={band}>
          <span>
            Tu plan pasa a {o.pendingPlan.planLabel} el {dayMonthKey(o.pendingPlan.effectiveOn)}.
            {o.pendingPlan.disableCount > 0 &&
              (o.pendingPlan.disableCount === 1
                ? " Ese día 1 persona pierde el acceso."
                : ` Ese día ${o.pendingPlan.disableCount} personas pierden el acceso.`)}
          </span>
          <div style={actions}>
            <Button type="button" variant="ghost" disabled={!!busy} onClick={() => void run("plan:cancel", () => cancelScheduledPlanChange(), { success: "Listo: seguís con tu plan." })}>
              {C.cancelPendingPlan}
            </Button>
          </div>
        </div>
      )}

      {cancelPending && o.cancel && (
        <div data-cancel-pending style={warnBand}>
          <span>
            Pediste la baja: tenés acceso completo hasta el {dayMonthKey(o.cancel.effectiveOn)}. Después el consultorio queda en
            solo lectura.
          </span>
          <div style={actions}>
            <Button type="button" variant="ghost" disabled={!!busy} onClick={() => void run("undo", () => undoCancel(), { success: "Listo: deshiciste la baja." })}>
              {C.undoCancel}
            </Button>
          </div>
        </div>
      )}

      {cancelled && (
        <div data-cancelled style={warnBand}>
          <span>{C.cancelledBand}</span>
          <div style={actions}>
            <Button type="button" disabled={!!busy} onClick={() => void run("reactivate", () => reactivateSubscription(), { stepUp: true, success: "Listo: reactivaste la suscripción." })}>
              {C.reactivate}
            </Button>
          </div>
        </div>
      )}

      {debitBand && (
        <div data-auto-debit={debitBand.kind} style={debitBand.kind === "failed" ? warnBand : band}>
          <span>{debitBand.text}</span>
          {debitBand.kind === "pending" && (
            <div style={actions}>
              <Button type="button" disabled={!!busy} onClick={continuePendingDebit}>
                {C.continueMp}
              </Button>
              <Button type="button" variant="ghost" disabled={!!busy} onClick={cancelPendingDebit}>
                {C.cancel}
              </Button>
            </div>
          )}
          {debitBand.kind === "active" && !choosing && (
            <div style={actions}>
              <Button type="button" variant="ghost" disabled={!!busy} onClick={() => setDebitOpen(true)}>
                {C.changeCard}
              </Button>
              <Button type="button" variant="ghost" disabled={!!busy} onClick={() => setChoosing(true)}>
                {C.stopDebit}
              </Button>
            </div>
          )}
          {debitBand.kind === "failed" && (
            <div style={actions}>
              <Button type="button" disabled={!!busy} onClick={payLastCharge}>
                {busy === "pay" ? "Abriendo Mercado Pago…" : C.payMp}
              </Button>
            </div>
          )}
        </div>
      )}

      {noPrice && (
        <p data-no-price style={{ ...band, margin: 0 }}>
          {noPrice}
        </p>
      )}

      {shownChoices.length > 0 && !hideSelector && (
        <section style={{ display: "grid", gap: 8 }} aria-labelledby="billing-method-title">
          <h3 id="billing-method-title" style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>
            {C.methodTitle}
          </h3>
          <div role="radiogroup" aria-labelledby="billing-method-title" style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
            {shownChoices.map((m) => (
              <MethodOption
                key={m}
                method={m}
                checked={!choosing && o.collectionMethod === m}
                disabled={!!busy}
                onChoose={() => chooseMethod(m)}
              />
            ))}
          </div>
          {choosing && (
            <div>
              <Button type="button" variant="ghost" disabled={!!busy} onClick={() => setChoosing(false)}>
                Seguir con el débito
              </Button>
            </div>
          )}
        </section>
      )}

      {(lines || firstPeriod) && (
        <section data-next-charge-breakdown style={{ display: "grid", gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>Próximo cargo</h3>
          {lines && (
            <dl style={{ margin: 0, display: "grid", gap: 4 }}>
              {lines.map((l) => (
                <Line key={l.label} label={l.label} total={l.tone === "total"}>
                  {l.amount}
                </Line>
              ))}
            </dl>
          )}
          {firstPeriod && <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>{firstPeriod}</p>}
        </section>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger-fg)" }}>
          {error}
        </p>
      )}

      {!cancelled && !cancelPending && (
        <div>
          <Button type="button" variant="ghost" disabled={!!busy} onClick={() => void askCancel()} data-cancel-subscription>
            {C.cancelButton}
          </Button>
        </div>
      )}

      {mp && (
        <AutoDebitDrawer
          open={debitOpen}
          onClose={() => setDebitOpen(false)}
          noPrice={o.effectivePriceCents == null}
          onStart={async (payerEmail) => {
            // El drawer muestra su propio error; acá solo se navega si salió bien.
            const r = await runStepUp(() => startAutoDebit({ payerEmail }));
            if (!r.ok) return r.error;
            if (!goTo(r.data.initPoint)) return NETWORK_ERROR;
            return null;
          }}
        />
      )}
    </Card>
  );
}

function Line({ label, total, children }: { label: string; total?: boolean; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13.5, fontWeight: total ? 700 : 400, color: "var(--navy-900)" }}>
      <dt style={{ margin: 0 }}>{label}</dt>
      <dd className="k-mono" style={{ margin: 0 }}>
        {children}
      </dd>
    </div>
  );
}

function MethodOption({ method, checked, disabled, onChoose }: { method: SaasCollectionMethod; checked: boolean; disabled: boolean; onChoose: () => void }) {
  const c = C.method[method];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-collection-method={method}
      disabled={disabled}
      onClick={onChoose}
      style={{
        textAlign: "left",
        display: "grid",
        gap: 4,
        padding: "12px 14px",
        borderRadius: 14,
        border: checked ? "2px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.1)",
        background: "var(--card-bg)",
        cursor: disabled ? "default" : "pointer",
        font: "inherit",
        color: "var(--navy-900)",
        minWidth: 0,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 14 }}>{c.label}</span>
      <span style={{ fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.4 }}>{c.hint}</span>
    </button>
  );
}

/**
 * Activar el débito (o cambiar la tarjeta): el email de la cuenta de MP (MPS-D21) y a autorizar. Drawer con
 * dirty-guard (AGENTS §5): con el email tipeado, cerrar pide confirmación. El monto y la tarjeta se ven en MP.
 */
function AutoDebitDrawer({
  open,
  onClose,
  noPrice,
  onStart,
}: {
  open: boolean;
  onClose: () => void;
  noPrice: boolean;
  onStart: (payerEmail: string) => Promise<string | null>;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) {
      setEmail("");
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (pending) return;
    const v = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      setError("Revisá el email: tiene que ser el de tu cuenta de Mercado Pago.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const e = await onStart(v);
      if (e) setError(e);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={C.debitDrawerTitle}
      dirty={email.trim().length > 0}
      dirtyMessage="Tipeaste un email. Si cerrás, el débito no se activa."
    >
      <form
        style={{ display: "grid", gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>{C.method.AUTO_DEBIT.hint}</p>
        {noPrice && <p style={{ ...band, margin: 0 }}>{C.noPrice}</p>}
        <FormField label={C.emailLabel} name="payerEmail" type="email" autoComplete="email" value={email} onChange={setEmail} hint={C.emailHint} error={error ?? undefined} required />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Abriendo Mercado Pago…" : C.continueMp}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
