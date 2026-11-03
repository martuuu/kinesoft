"use client";

/**
 * [CF2-AD] Mini-badge de plata del turno (plan §29 D-CF2-3, brief CF2 A.2). Reemplaza al `MoneyBadge` de
 * `booking-card.tsx` (TP-3e), que pasa a re-exportar este: misma salida para la plata online («Seña» / «Pagado MP») y,
 * para quien puede cobrar ese turno, el tag del copago («Pagado · Efectivo» / «Por cobrar» / «Retenido»,
 * `copagoTag` en `lib/copago-tag.ts`).
 *
 * - **Precedencia**: «Pagado MP» → copago → «Seña». Pagado entero online ya lo dice todo; el cobro a mano dice más que
 *   la seña (que es parte de ese cobro: «Por cobrar: $ 4.000» ya descuenta la seña). Un solo badge por turno: la línea
 *   de la Semana (22 px) no entra dos.
 * - **Quién ve el copago**: `copago` explícito (las caras de /sala pasan `canCollectRow(viewer, row)`) o, sin la prop,
 *   el contexto `MoneyViewerContext` de la agenda. Sin ninguno de los dos: solo la plata online, como antes de CF2.
 * - **Estilo**: borde y SIN relleno, porque el fondo de la card es el ESTADO y la barra el servicio (AGENTS §5): un
 *   «Pagado» verde se leería «Atendido». «Por cobrar» con borde PUNTEADO (falta algo, como «Fuera de plan»), «Pagado»
 *   SÓLIDO con check, «Retenido» sólido sin check. Canal no cromático: el color sigue siendo `currentColor`.
 * - **`compact`** (la línea de 22 px de la Semana): el tag de copago queda en un glifo y el texto entero va en el
 *   `aria-label`: «Pagado» = ✓ con borde sólido, «Por cobrar» = `$` con borde punteado, «Retenido» = SIN glifo (solo
 *   el borde sólido). [CF2-ZF1] (ZB-3) Antes «Retenido» también era `$`: en la Semana se leía «Por cobrar» y alguien
 *   podía cobrar a mano lo que Mercado Pago ya retiene. La plata online no cambia (ya era corta: «Seña», «Pagado MP»).
 * - `role="img"` + `aria-label` completo, como `WaitingDot`: cuenta en el nombre del botón de la card.
 *
 * El markup de la plata online es EXACTAMENTE el de TP-3e (`tests/unit/render/tp3e-agenda-money-badge.test.tsx` lo
 * fija); el estilo base `miniBadge` se copia de `booking-card` en vez de importarlo porque `booking-card` re-exporta
 * este módulo (import circular).
 */
import type { CSSProperties } from "react";
import { cardMoneyBadge } from "@/lib/booking-money-badge";
import { copagoTag } from "@/lib/copago-tag";
import type { BookingDTO } from "../agenda-utils";
import { useMoneyViewer } from "./money-viewer-context";

export function MoneyBadge({ b, copago, compact }: { b: BookingDTO; copago?: boolean; compact?: boolean }) {
  const canSee = useMoneyViewer();
  const m = cardMoneyBadge(b);
  const t = m?.[0] != "mp" && (copago ?? canSee?.(b.practitionerId)) ? copagoTag(b) : null;
  if (t) {
    const paid = t[0] == "paid";
    return (
      <span
        role="img"
        data-badge={"copago-" + t[0]}
        aria-label={t[2]}
        style={{ ...miniBadge, border: `1px ${t[0] == "owed" ? "dashed" : "solid"}`, lineHeight: "12px", display: "inline-flex", alignItems: "center", gap: 2 }}
      >
        {paid && <CheckGlyph />}
        {/* Retenido compacto: un espacio duro y no vacío, porque un inline-flex sin contenido mide 0 de alto (2 px de
            borde) y el borde, que es todo lo que dice, no se vería. */}
        {compact ? (t[0] == "owed" ? "$" : !paid && "\u00a0") : t[1]}
      </span>
    );
  }
  return (
    m && (
      <span role="img" data-badge={m[0]} aria-label={m[2]} style={{ ...miniBadge, border: "1px solid", lineHeight: "12px" }}>
        {m[1]}
      </span>
    )
  );
}

function CheckGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M1 4.2 3.1 6.2 7 1.8" />
    </svg>
  );
}

/** Copia de `miniBadge` de `booking-card.tsx` (ver el comentario de arriba: import circular). */
const miniBadge: CSSProperties = {
  flexShrink: 0,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  borderRadius: 999,
  padding: "0 5px",
  lineHeight: "14px",
};
