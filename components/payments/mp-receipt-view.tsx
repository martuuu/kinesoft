"use client";

/**
 * [TP-K4] Comprobante de un pago de Mercado Pago (TP-D20 / TP-UI-D11). Stub funcional de T5c: TP-3d le pone el estilo.
 *
 * Solo pinta las filas que ya armó `buildMpReceipt` (lib/mp-receipt.ts): ninguna superficie formatea fechas ni medios
 * por su cuenta, así el drawer, Facturación, /cobros y /pagar muestran lo mismo en hora AR.
 *
 * Va diferido (§25.11): lo carga por `import()` la sección de plata del drawer del turno; nunca entra al first load de
 * `/agenda` (lo fija `tests/unit/online-payments-first-load-guard.test.ts`).
 */
import { RECEIPT_COPY } from "@/lib/online-payments-copy";
import type { MpReceiptViewProps } from "./payments-ui-types";

export function MpReceiptView({ receipt, variant, defaultOpen = false }: MpReceiptViewProps) {
  const list = (
    <dl className="k-mp-receipt" data-receipt-rows={receipt.rows.length}>
      {receipt.rows.map((r) => (
        <div key={r.key} data-row={r.key}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
  if (variant === "plain") return list;
  return (
    <details open={defaultOpen}>
      <summary>{RECEIPT_COPY.title}</summary>
      {list}
    </details>
  );
}
