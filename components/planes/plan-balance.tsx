import type { CSSProperties, ReactNode } from "react";
import { formatARS } from "@/lib/format";
import { Tag } from "@/components/ui/tag";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import {
  LOOSE_GROUP_LABEL,
  PLAN_STATUS_LABEL,
  planGroupHeading,
  type PlanGroupMeta,
} from "@/components/planes/plan-booking-groups";
import type { PlanBalanceDTO, ProgramStatusValue } from "@/lib/plans-read-types";

/**
 * Saldo P7 de un plan (S22f, ES3 P3.1). Muestra TAL CUAL lo que calcula el
 * server (`getPatientPlanBalances` / `PlanDTO.balance`, `planBalance` de
 * `lib/plan-pricing.ts`): acá no se resta ni se recorta nada. Enmienda del
 * 08-oct (plan §16.2): el pactado de un plan cancelado es el nuevo (= lo
 * realizado, S14r); este componente lo consume, no lo reimplementa.
 *
 * Copy sin jerga contable: "devengado" se muestra como "Realizado" (lo que
 * corresponde a las sesiones hechas). Pendiente y a favor son las dos caras
 * de la misma resta (el server devuelve una de las dos en 0): se muestra la
 * que no es cero, o "Al día". Lo que pagó la obra social NO es parte del saldo
 * del paciente (decisión S14): se informa aparte como cantidad de turnos.
 *
 * Sin datos clínicos: lo puede ver la Secretaria / Facturación (PD-09: BILLING
 * ve el saldo; PD-13: nada de HC).
 */
export type PlanBalanceProps = {
  balance: PlanBalanceDTO;
  /** Solo para el aviso de "plan cancelado"; el número ya viene resuelto. */
  status?: ProgramStatusValue | null;
  /** `full` = grilla con todos los montos (Facturación); `compact` = una línea (Turnos). */
  variant?: "full" | "compact";
  style?: CSSProperties;
};

export type PlanBalanceItem = {
  key: "agreed" | "accrued" | "collected" | "inProcess" | "pending" | "credit" | "settled";
  label: string;
  value: string;
  tone: "navy" | "lime" | "sky" | "warn";
};

/** Filas visibles del saldo, en orden (puro: lo testea `facturacion-plan.test.tsx`). */
export function planBalanceItems(balance: PlanBalanceDTO): PlanBalanceItem[] {
  const items: PlanBalanceItem[] = [
    {
      key: "agreed",
      label: "Pactado",
      value: balance.agreedCents == null ? "Sin precio" : formatARS(balance.agreedCents),
      tone: "navy",
    },
    { key: "accrued", label: "Realizado", value: formatARS(balance.accruedCents), tone: "navy" },
    { key: "collected", label: "Cobrado", value: formatARS(balance.collectedCents), tone: "lime" },
  ];
  if (balance.inProcessCents > 0) {
    items.push({ key: "inProcess", label: "En proceso", value: formatARS(balance.inProcessCents), tone: "sky" });
  }
  items.push(balanceOutcome(balance));
  return items;
}

/** La cara que no es cero: pendiente, a favor, o al día. */
export function balanceOutcome(balance: PlanBalanceDTO): PlanBalanceItem {
  if (balance.pendingCents > 0) {
    return { key: "pending", label: "Pendiente", value: formatARS(balance.pendingCents), tone: "warn" };
  }
  if (balance.creditCents > 0) {
    return { key: "credit", label: "A favor del paciente", value: formatARS(balance.creditCents), tone: "sky" };
  }
  return { key: "settled", label: "Saldo", value: "Al día", tone: "lime" };
}

/** Notas al pie del saldo (puro). */
export function planBalanceNotes(balance: PlanBalanceDTO, status?: ProgramStatusValue | null): string[] {
  const notes: string[] = [];
  if (status === "CANCELLED") notes.push("Plan cancelado: el pactado es lo realizado.");
  if (balance.inProcessCents > 0) notes.push("«En proceso» es un pago autorizado que todavía no se acreditó.");
  if (balance.creditCents > 0) notes.push("El reintegro de lo que está a favor se hace a mano.");
  if (balance.insurerPaidBookings > 0) {
    const n = balance.insurerPaidBookings;
    notes.push(
      `La obra social ya pagó ${n} ${n === 1 ? "turno" : "turnos"} de este plan (va aparte: no suma al saldo del paciente).`
    );
  }
  return notes;
}

const TONE: Record<PlanBalanceItem["tone"], string> = {
  navy: "var(--navy-900)",
  lime: "var(--lime-500)",
  sky: "var(--sky-700)",
  warn: "#9F4A12",
};

export function PlanBalance({ balance, status, variant = "full", style }: PlanBalanceProps) {
  if (variant === "compact") {
    const out = balanceOutcome(balance);
    return (
      <span
        data-testid="plan-balance"
        data-variant="compact"
        style={{ display: "inline-flex", alignItems: "baseline", gap: 6, fontSize: 12, color: "var(--navy-500)", ...style }}
      >
        <span>{out.label}</span>
        <strong className="k-mono" style={{ color: TONE[out.tone], fontWeight: 700 }}>
          {out.value}
        </strong>
      </span>
    );
  }
  const items = planBalanceItems(balance);
  const notes = planBalanceNotes(balance, status);
  return (
    <div data-testid="plan-balance" data-variant="full" style={{ display: "flex", flexDirection: "column", gap: 8, ...style }}>
      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
          gap: "8px 16px",
        }}
      >
        {items.map((it) => (
          <div key={it.key} data-balance={it.key}>
            <dt
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                color: "var(--navy-300)",
              }}
            >
              {it.label}
            </dt>
            <dd className="k-mono" style={{ margin: 0, fontSize: 14, fontWeight: 700, color: TONE[it.tone] }}>
              {it.value}
            </dd>
          </div>
        ))}
      </dl>
      {notes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: "var(--navy-500)", lineHeight: 1.5 }}>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Encabezado de un grupo de Turnos/Facturación: chip de disciplina (canal no
 * cromático, nunca el título), el título SOLO si `meta.title` vino habilitado
 * (`planGroupMetas` con `showPlanTitles`), estado y, a la derecha, `aside`
 * (el saldo compacto en Turnos). `plan = null` = "Turnos sueltos".
 */
export function PlanGroupHeader({ plan, count, aside }: { plan: PlanGroupMeta | null; count: number; aside?: ReactNode }) {
  const countText = `${count} ${count === 1 ? "turno" : "turnos"}`;
  return (
    <div
      data-testid={plan ? "plan-group-header" : "loose-group-header"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        padding: "12px 18px",
        borderBottom: "1px solid rgba(15,30,51,0.06)",
        background: "rgba(246,249,253,0.6)",
      }}
    >
      {plan ? (
        <>
          <DisciplineChip discipline={plan.discipline} label="long" />
          <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)", minWidth: 0, overflowWrap: "anywhere" }}>
            {planGroupHeading(plan)}
          </h3>
          {plan.status && <Tag tone={plan.status === "ACTIVE" ? "lime" : "soft"}>{PLAN_STATUS_LABEL[plan.status]}</Tag>}
          {plan.archived && <Tag tone="soft">Archivado</Tag>}
        </>
      ) : (
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)" }}>{LOOSE_GROUP_LABEL}</h3>
      )}
      <span style={{ fontSize: 12, color: "var(--navy-500)" }}>· {countText}</span>
      {aside && <span style={{ marginLeft: "auto" }}>{aside}</span>}
    </div>
  );
}
