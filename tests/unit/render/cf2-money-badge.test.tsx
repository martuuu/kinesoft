/**
 * [CF2-AD] `MoneyBadge` nuevo (`components/agenda/grid/money-badge.tsx`, brief CF2 A.2, D-CF2-3): misma salida que el
 * de TP-3e para la plata online, tag de copago para quien cobra (prop `copago` o `MoneyViewerContext`), precedencia
 * «Pagado MP» → copago → «Seña», borde sin relleno (punteado = «Por cobrar», sólido + check = «Pagado») y variante
 * compacta con el texto en el `aria-label`. Render estático del componente real. Sin reloj: TZ irrelevante.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { MoneyBadge as CardMoneyBadge } from "@/components/agenda/grid/booking-card";
import { MoneyBadge } from "@/components/agenda/grid/money-badge";
import { MoneyViewerContext } from "@/components/agenda/grid/money-viewer-context";
import { formatARS } from "@/lib/format";

const iso = (h: string) => new Date(`2026-10-05T${h}:00-03:00`).toISOString();
const B: BookingDTO = {
  id: "b1",
  scheduledFor: iso("10:00"),
  durationMin: 45,
  status: "CONFIRMED",
  serviceId: "s",
  serviceName: "Kinesiología",
  serviceColor: "#3d74b5",
  practitionerId: "p1",
  patientId: "pat",
  patientName: "Juana Gómez",
  patientCondition: null,
  obraSocial: "Particular",
  copagoCents: 2_000_000,
  updatedAt: iso("07:00"),
  notes: null,
  title: null,
  description: null,
  patientAccess: "full",
  paymentStatus: "UNPAID",
};
const b = (over: Partial<BookingDTO>): BookingDTO => ({ ...B, ...over });
const OWED = b({ status: "COMPLETED" });
const PAID_CASH = b({ status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" });
const DEPOSIT = b({ onlineDepositCents: 600_000 });
const PAID_MP = b({ status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true, onlineDepositCents: 600_000 });

const html = (node: ReactNode, viewer?: (pid: string) => boolean) =>
  renderToStaticMarkup(viewer ? <MoneyViewerContext.Provider value={viewer}>{node}</MoneyViewerContext.Provider> : node);

describe("[CF2-AD] MoneyBadge", () => {
  it("[CF2-AD20] sin `copago` ni contexto = el badge de TP-3e (mismo markup que el de booking-card hoy)", () => {
    for (const x of [B, OWED, PAID_CASH, DEPOSIT, PAID_MP]) {
      expect(html(<MoneyBadge b={x} />)).toBe(renderToStaticMarkup(<CardMoneyBadge b={x} />));
    }
    expect(html(<MoneyBadge b={OWED} />)).toBe("");
    expect(html(<MoneyBadge b={DEPOSIT} />)).toContain(`aria-label="Seña pagada por Mercado Pago: ${formatARS(600_000)}"`);
  });

  it("[CF2-AD21] «Por cobrar»: borde PUNTEADO, sin relleno, monto en el nombre accesible", () => {
    const h = html(<MoneyBadge b={OWED} copago />);
    expect(h).toContain('data-badge="copago-owed"');
    expect(h).toContain(`aria-label="Por cobrar: ${formatARS(2_000_000)}"`);
    expect(h).toContain(">Por cobrar</span>");
    expect(h).toContain("border:1px dashed");
    expect(h).not.toMatch(/background/);
  });

  it("[CF2-AD22] «Pagado · Efectivo»: borde SÓLIDO + check", () => {
    const h = html(<MoneyBadge b={PAID_CASH} copago />);
    expect(h).toContain('data-badge="copago-paid"');
    expect(h).toContain('aria-label="Pagado · Efectivo"');
    expect(h).toContain("border:1px solid");
    expect(h).toContain("<svg");
    expect(h).toContain("Pagado · Efectivo</span>");
    expect(h).not.toMatch(/background/);
  });

  it("[CF2-AD23] precedencia: «Pagado MP» gana; el copago gana sobre la «Seña»", () => {
    expect(html(<MoneyBadge b={PAID_MP} copago />)).toContain('data-badge="mp"');
    const withDeposit = html(<MoneyBadge b={{ ...DEPOSIT, status: "COMPLETED" }} copago />);
    expect(withDeposit).toContain('data-badge="copago-owed"');
    expect(withDeposit).toContain(`aria-label="Por cobrar: ${formatARS(1_400_000)}"`); // lo que falta
    expect(withDeposit).not.toContain('data-badge="sena"');
    // Sin nada que decir del copago (no llegó), la seña sigue.
    expect(html(<MoneyBadge b={DEPOSIT} copago />)).toContain('data-badge="sena"');
  });

  it("[CF2-AD24] compacto (Semana 22 px): glifo visible, el texto entero en el aria-label", () => {
    const owed = html(<MoneyBadge b={OWED} copago compact />);
    expect(owed).toContain(`aria-label="Por cobrar: ${formatARS(2_000_000)}"`);
    expect(owed).toMatch(/>\$<\/span>$/);
    expect(owed).not.toContain(">Por cobrar<");
    const paid = html(<MoneyBadge b={PAID_CASH} copago compact />);
    expect(paid).toContain('aria-label="Pagado · Efectivo"');
    expect(paid).toContain("<svg");
    expect(paid).not.toContain("Pagado · Efectivo<");
  });

  it("[CF2-AD25] contexto de la agenda: la Secretaria (todo) ve el tag; el kine solo en lo suyo; la prop manda", () => {
    const all = () => true;
    const own = (pid: string) => pid === "p1";
    expect(html(<MoneyBadge b={OWED} />, all)).toContain('data-badge="copago-owed"');
    expect(html(<MoneyBadge b={OWED} />, own)).toContain('data-badge="copago-owed"');
    expect(html(<MoneyBadge b={{ ...OWED, practitionerId: "p2" }} />, own)).toBe("");
    // /sala pasa `copago` explícito: gana sobre el contexto.
    expect(html(<MoneyBadge b={OWED} copago={false} />, all)).toBe("");
    expect(html(<MoneyBadge b={{ ...OWED, practitionerId: "p2" }} copago />, own)).toContain('data-badge="copago-owed"');
  });
});
