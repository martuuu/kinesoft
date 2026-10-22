/**
 * [TP-3g] Una fila de /cobros: `<tr>` de la tabla desde 768 px y card bajo 768 px (mismo markup, lo cambia el CSS;
 * `data-label` le pone el rótulo a cada dato en la card).
 *
 * Sin estado ni red: lo que se ve sale de `cobroRowView` (lib/cobros-view.ts) y las acciones las resuelve
 * `CobrosClient`. El estado va SIEMPRE en texto (Anexo C 3g): el tono del Tag acompaña, no informa solo (AGENTS §5).
 * Las acciones sobre el link (copiar, reenviar, anular) aparecen solo si el server mandó `link` para este viewer
 * (C-TP9: la URL es la llave de pago, solo para quien puede cobrar ese turno).
 */
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { COBROS_COPY as C, type CobroRowView, type CobroStatusTone } from "@/lib/cobros-view";
import styles from "./cobros.module.css";

export type CobrosRowHandlers = {
  onReceipt: (id: string) => void;
  onCopy: (url: string) => void;
  onResend: (id: string) => void;
  onCancel: (id: string) => void;
};

const TONE: Record<CobroStatusTone, { tone: "lime" | "sky" | "soft"; variant: "fill" | "outline" }> = {
  live: { tone: "sky", variant: "fill" },
  paid: { tone: "lime", variant: "fill" },
  refunded: { tone: "soft", variant: "outline" },
  closed: { tone: "soft", variant: "outline" },
};

export function CobrosRow({ row, busy, handlers }: { row: CobroRowView; busy: boolean; handlers: CobrosRowHandlers }) {
  const t = TONE[row.statusTone];
  const a = row.actions;
  const any = a.receipt || a.copyUrl || a.resend || a.cancel;
  return (
    <tr data-charge={row.id} data-status-tone={row.statusTone}>
      <td className={styles.cellConcept} data-label={C.colConcept}>
        <span className={styles.title}>{row.title}</span>
        <span className={styles.meta}>
          {row.originLabel} · {row.accountLabel}
        </span>
        {row.noticeLabels.length > 0 && (
          <span className={styles.notices}>
            {row.noticeLabels.map((n) => (
              <span key={n} className={styles.notice}>
                {n}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className={styles.cellPractitioner} data-label={C.colPractitioner}>
        {row.practitionerLabel}
      </td>
      <td className={styles.cellAmount} data-label={C.colAmount}>
        <span className={styles.amount}>{row.amountLabel}</span>
        <span className={styles.meta}>{row.kindLabel}</span>
      </td>
      <td className={styles.cellStatus} data-label={C.colStatus}>
        <Tag tone={t.tone} variant={t.variant}>
          {row.statusLabel}
        </Tag>
        {row.expiresLabel && <span className={styles.meta}>{row.expiresLabel}</span>}
      </td>
      <td className={styles.cellDate} data-label={C.colDate}>
        {row.createdLabel}
      </td>
      <td className={styles.cellActions} data-label={C.colActions}>
        {any ? (
          <span className={styles.actions}>
            {a.receipt && (
              <Button type="button" variant="ghost" size="sm" onClick={() => handlers.onReceipt(row.id)}>
                {C.receipt}
              </Button>
            )}
            {a.copyUrl && (
              <Button type="button" variant="ghost" size="sm" onClick={() => handlers.onCopy(a.copyUrl as string)}>
                {C.copy}
              </Button>
            )}
            {a.resend && (
              <Button type="button" variant="ghost" size="sm" onClick={() => handlers.onResend(row.id)}>
                {C.resend}
              </Button>
            )}
            {a.cancel && (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => handlers.onCancel(row.id)}>
                {C.cancel}
              </Button>
            )}
          </span>
        ) : null}
      </td>
    </tr>
  );
}
