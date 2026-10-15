"use client";

/**
 * /plataforma → Precios (PL-3c; PL-D8 precios ARS con vigencia, PL-D19 nacen en «Consultá»). Un renglón por plan con
 * el precio vigente y el próximo cambio programado; «Cambiar precio» abre un Drawer (dirty-guard) con el monto
 * (`MoneyInput`, centavos), «Consultá» (= sin precio: el plan no se cobra a quien no tenga precio a medida), desde
 * qué día rige y una nota. Hoy o antes = se aplica ya y revalida la landing; una fecha futura la aplica el cron.
 *
 * El aviso «N consultorios reciben mail» usa el mismo criterio que el cron (`countPriceNoticeRecipients`).
 * `updatePlanPrice` es `billing.price` (`high`): va por `usePlatformAction` y con `useConfirm`.
 */
import { useState, type FormEvent } from "react";
import type { SaasPlan } from "@prisma/client";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MoneyInput } from "@/components/ui/money-input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { formatDateAR } from "@/lib/format";
import { updatePlanPrice } from "@/lib/platform-billing";
import type { PlatformPlanPriceRow, PlatformPriceHistoryRow } from "@/lib/platform-billing-types";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { CheckRow, ErrorBox, Section, WarnBox } from "@/components/plataforma/tenants/detail-ui";
import { formatDayKeyAR } from "@/components/plataforma/tenants/labels";
import {
  NOTE_MAX,
  buildPlanPricePayload,
  priceFormFor,
  priceNoticeText,
  priceOrConsulta,
  validatePriceForm,
  type PriceFormState,
} from "@/components/plataforma/billing/billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";

/** Cuerpo controlado y sin efectos (render test con props). */
export function PriceEditorForm({
  plan,
  current,
  state,
  recipients,
  errors,
  serverError,
  pending,
  dirty,
  onChange,
  onSubmit,
  onCancel,
}: {
  plan: SaasPlan;
  current: number | null;
  state: PriceFormState;
  recipients: number;
  errors: Record<string, string>;
  serverError: string | null;
  pending: boolean;
  dirty: boolean;
  onChange: <K extends keyof PriceFormState>(k: K, v: PriceFormState[K]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }} noValidate>
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>
        {SAAS_PLAN_LABEL[plan]} · hoy: <strong style={{ color: "var(--navy-900)" }}>{priceOrConsulta(current)}</strong>
      </p>
      <CheckRow
        checked={state.consulta}
        onChange={(v) => onChange("consulta", v)}
        disabled={pending}
        title="Consultá (sin precio publicado)"
        hint="La landing muestra «Consultá» y el plan no genera cargos a quien no tenga precio a medida."
      />
      {!state.consulta && (
        <MoneyInput
          label="Precio por mes (ARS)"
          required
          value={state.priceCents}
          onChange={(v) => onChange("priceCents", v)}
          error={errors.priceCents}
          disabled={pending}
        />
      )}
      <FormField
        type="date"
        label="Rige desde"
        required
        value={state.effectiveFrom}
        onChange={(v) => onChange("effectiveFrom", v)}
        hint="Hoy o antes: se aplica ya. Una fecha futura la aplica el proceso diario ese día. Sin prorrateo: rige desde el próximo cargo de cada consultorio."
        error={errors.effectiveFrom}
        disabled={pending}
      />
      <FormField
        as="textarea"
        label="Nota (opcional)"
        rows={2}
        value={state.note}
        onChange={(v) => onChange("note", v.slice(0, NOTE_MAX))}
        placeholder="Ej.: actualización por inflación"
        hint="Queda en el historial. No la ven los consultorios."
        error={errors.note}
        disabled={pending}
      />
      <WarnBox>{priceNoticeText(recipients, state.consulta)}</WarnBox>
      {serverError && <ErrorBox>{serverError}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || pending}>
          {pending ? "Guardando…" : "Guardar precio"}
        </Button>
      </div>
    </form>
  );
}

function PlanPriceRow({ row, recipients }: { row: PlatformPlanPriceRow; recipients: number }) {
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<PriceFormState>(() => priceFormFor(row.priceCents, new Date()));
  const [state, setState] = useState<PriceFormState>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const dirty =
    state.consulta !== baseline.consulta ||
    state.priceCents !== baseline.priceCents ||
    state.effectiveFrom !== baseline.effectiveFrom ||
    state.note.trim() !== "";

  const openDrawer = () => {
    const b = priceFormFor(row.priceCents, new Date());
    setBaseline(b);
    setState(b);
    setErrors({});
    setServerError(null);
    setOpen(true);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const v = validatePriceForm(state);
    setErrors(v);
    if (Object.keys(v).length > 0) return;
    const payload = buildPlanPricePayload(row.plan, state);
    const now = payload.effectiveFrom <= toARDateKey(new Date());
    const yes = await confirm({
      title: `¿Cambiar el precio de ${SAAS_PLAN_LABEL[row.plan]}?`,
      message: `${priceOrConsulta(row.priceCents)} → ${priceOrConsulta(payload.priceCents)}, ${
        now ? "desde hoy" : `desde el ${formatDayKeyAR(payload.effectiveFrom)}`
      }. ${priceNoticeText(recipients, state.consulta)}`,
      confirmLabel: "Cambiar precio",
      cancelLabel: "Volver",
    });
    if (!yes) return;
    setPending(true);
    setServerError(null);
    try {
      const res = await runPlatform(() => updatePlanPrice(payload));
      if (!res.ok) {
        setServerError(res.error);
        setErrors(Object.fromEntries(Object.entries(res.fieldErrors ?? {}).map(([k, m]) => [k, m[0]])));
        return;
      }
      setOpen(false);
      // Sin refresh extra del router: `updatePlanPrice` revalida /plataforma/precios (PF-0d).
      toast.success(res.data.appliedNow ? "Precio actualizado" : "Cambio de precio programado");
    } catch {
      setServerError("No se pudo guardar el precio. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <li
      data-plan={row.plan}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 16px",
        padding: "14px 0",
        borderTop: "1px solid rgba(15,30,51,0.06)",
      }}
    >
      <span style={{ fontWeight: 700, color: "var(--navy-900)", minWidth: 110 }}>{row.label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 14, color: "var(--navy-900)" }}>
        {row.priceCents == null ? "Consultá" : `${priceOrConsulta(row.priceCents)}/mes`}
      </span>
      {row.pending && (
        <span data-pending-price style={{ fontSize: 12.5, color: "var(--sky-700)", fontWeight: 600 }}>
          Programado: {priceOrConsulta(row.pending.priceCents)} desde el {formatDayKeyAR(row.pending.effectiveFrom)}
        </span>
      )}
      <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
        {recipients === 1 ? "1 consultorio activo con precio de lista" : `${recipients} consultorios activos con precio de lista`}
      </span>
      <span style={{ marginLeft: "auto" }}>
        <Button type="button" variant="ghost" onClick={openDrawer}>
          Cambiar precio
        </Button>
      </span>
      <Drawer open={open} onClose={() => setOpen(false)} title={`Precio de ${row.label}`} dirty={dirty} width={440}>
        <PriceEditorForm
          plan={row.plan}
          current={row.priceCents}
          state={state}
          recipients={recipients}
          errors={errors}
          serverError={serverError}
          pending={pending}
          dirty={dirty}
          onChange={(k, v) => setState((s) => ({ ...s, [k]: v }))}
          onSubmit={(e) => void onSubmit(e)}
          onCancel={() => setOpen(false)}
        />
      </Drawer>
    </li>
  );
}

export function PriceHistoryList({ rows }: { rows: readonly PlatformPriceHistoryRow[] }) {
  return (
    <Section title="Historial" description="Cada cambio queda registrado, también los programados. El más nuevo primero.">
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>Todavía no se cambió ningún precio.</p>
      ) : (
        <ul aria-label="Historial de precios" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li
              key={r.id}
              data-history={r.id}
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "4px 14px",
                padding: "10px 0",
                borderTop: "1px solid rgba(15,30,51,0.06)",
                fontSize: 13,
                color: "var(--navy-700)",
              }}
            >
              <span style={{ fontWeight: 700, color: "var(--navy-900)" }}>{SAAS_PLAN_LABEL[r.plan]}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {priceOrConsulta(r.previousPriceCents)} → {priceOrConsulta(r.priceCents)}
              </span>
              <span>Desde el {formatDayKeyAR(r.effectiveFrom)}</span>
              <span style={{ color: r.appliedAt ? "var(--navy-500)" : "var(--sky-700)", fontWeight: r.appliedAt ? 400 : 600 }}>
                {r.appliedAt ? `Aplicado el ${formatDateAR(r.appliedAt, "short")}` : "Pendiente"}
              </span>
              {r.note && <span style={{ color: "var(--navy-500)", overflowWrap: "anywhere", minWidth: 0 }}>«{r.note}»</span>}
              {/* Decisión 19: el email va rotulado, nunca como nombre. */}
              {r.createdByEmail && (
                <span style={{ fontSize: 12, color: "var(--navy-300)", overflowWrap: "anywhere", minWidth: 0 }}>
                  Email de quien lo cargó: {r.createdByEmail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function PlanPricesEditor({
  rows,
  recipients,
}: {
  rows: readonly PlatformPlanPriceRow[];
  recipients: Record<SaasPlan, number>;
}) {
  return (
    <Section
      title="Precios de lista"
      description="Precio mensual en pesos de cada plan. Lo lee la landing y es lo que se cobra a quien no tiene precio a medida."
    >
      <ul aria-label="Precios por plan" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {rows.map((r) => (
          <PlanPriceRow key={r.plan} row={r} recipients={recipients[r.plan] ?? 0} />
        ))}
      </ul>
    </Section>
  );
}
