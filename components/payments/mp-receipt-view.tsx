"use client";

/**
 * [TP-3d] Comprobante de un pago de Mercado Pago (TP-D20 / TP-UI-D11): plegable en el drawer del turno, lista sola
 * (`plain`) adentro de un Modal en Facturación y /cobros.
 *
 * Solo pinta las filas que ya armó `buildMpReceipt` (lib/mp-receipt.ts): ninguna superficie formatea fechas ni medios
 * por su cuenta, así el drawer, Facturación, /cobros y /pagar muestran lo mismo en hora AR. Con `account` en la entrada
 * son 7 filas (N° de operación, fecha, monto, medio, cuotas, estado, acreditado en); sin `account`, 6 (handoff TP-P5).
 *
 * Plegable con `<details>` nativo: teclado, foco y anuncio del lector de pantalla sin código propio, y sin animación
 * (reduced motion no tiene nada que apagar). Los valores van en cifras tabulares para que el monto y el N° de
 * operación se puedan comparar con la app de Mercado Pago a ojo.
 *
 * Va diferido (§25.11): lo carga por `import()` la sección de plata del drawer del turno; nunca entra al first load de
 * `/agenda` (lo fija `tests/unit/online-payments-first-load-guard.test.ts`).
 */
import { RECEIPT_COPY } from "@/lib/online-payments-copy";
import type { MpReceiptViewProps } from "./payments-ui-types";

export function MpReceiptView({ receipt, variant, defaultOpen = false }: MpReceiptViewProps) {
  const list = (
    <dl
      className="k-mp-receipt"
      data-receipt-rows={receipt.rows.length}
      style={{ margin: 0, display: "grid", gap: 0, fontSize: 14 }}
    >
      {receipt.rows.map((r, i) => (
        <div
          key={r.key}
          data-row={r.key}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
            padding: "8px 0",
            borderTop: i === 0 ? undefined : "1px solid rgba(15, 30, 51, 0.08)",
          }}
        >
          <dt style={{ color: "var(--navy-500)", flexShrink: 0 }}>{r.label}</dt>
          <dd
            style={{
              margin: 0,
              color: "var(--navy-900)",
              fontWeight: r.key === "amount" ? 650 : 500,
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              overflowWrap: "anywhere",
            }}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
  if (variant === "plain") return list;
  return (
    <details
      open={defaultOpen}
      data-testid="mp-receipt"
      style={{ borderRadius: 12, border: "1px solid rgba(15, 30, 51, 0.1)", background: "var(--card-bg)" }}
    >
      <summary
        style={{
          // Sin `display: flex`: en Safari/Chrome eso borra el triángulo nativo y el plegable deja de parecerlo.
          minHeight: 44,
          boxSizing: "border-box",
          padding: "12px 14px",
          fontSize: 14,
          fontWeight: 600,
          color: "var(--sky-700)",
          cursor: "pointer",
        }}
      >
        {RECEIPT_COPY.title}
      </summary>
      <div style={{ padding: "0 14px 6px" }}>{list}</div>
    </details>
  );
}
