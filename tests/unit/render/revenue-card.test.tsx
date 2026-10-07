/**
 * S14r (ES3) · widget de ingresos del dashboard. Se monta el componente real
 * con `renderToStaticMarkup`; se mockean solo las actions y el toast.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/dashboard", () => ({ getRevenue: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateDashboardPrefs: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { RevenueCard, revenueCardView, revenueRangeAfterFetch, revenueShown } from "@/components/dashboard/revenue-card";
import { summarizeRevenue } from "@/lib/dashboard-revenue";
import { formatARS } from "@/lib/format";

const week = summarizeRevenue(
  "week",
  { mpCents: 1_000_000, manualCents: 500_000, insurerCents: 300_000 },
  { mpCents: 1_000_000, manualCents: 0 }
);
const month = summarizeRevenue(
  "month",
  { mpCents: 4_000_000, manualCents: 2_000_000, insurerCents: 900_000 },
  { mpCents: 0, manualCents: 0 }
);

describe("RevenueCard", () => {
  it("arranca en el período guardado: título, total (MP + copagos) y OS aparte", () => {
    const html = renderToStaticMarkup(<RevenueCard initial={week} month={month} />);
    expect(html).toContain("Ingresos de la semana");
    expect(html).toContain(formatARS(1_500_000));
    expect(html).toContain(`Obras sociales · ${formatARS(300_000)}`);
    // El selector marca el período elegido (a11y: aria-pressed).
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Semana/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>(?:(?!<\/button>).)*Mes/);
  });

  it("mes guardado: 'Ingresos del mes' y sin delta si el anterior fue 0", () => {
    const html = renderToStaticMarkup(<RevenueCard initial={month} month={month} />);
    expect(html).toContain("Ingresos del mes");
    expect(revenueCardView(month).delta).toBeNull();
  });

  it("delta con su período en el label accesible", () => {
    const v = revenueCardView(week);
    expect(v.delta).toEqual({ up: true, text: "+50%", label: "+50% vs. la semana pasada" });
    expect(v.breakdown).toBe(`Copagos ${formatARS(500_000)} · Mercado Pago ${formatARS(1_000_000)}`);
  });

  it("[P3-F3a] mientras carga el período nuevo, el título es el del número que se ve (no el del botón)", () => {
    // Se eligió Semana y todavía solo está el mes: se muestra el mes con SU título.
    const shown = revenueShown({ month }, "week", month);
    expect(shown).toBe(month);
    expect(revenueCardView(shown).title).toBe("Ingresos del mes");
    expect(revenueCardView(revenueShown({ month, week }, "week", month)).title).toBe("Ingresos de la semana");
  });

  it("[P3-F3a] si la lectura falla (error o excepción) el selector vuelve al período anterior", () => {
    expect(revenueRangeAfterFetch("month", "week", { ok: true })).toBe("week");
    expect(revenueRangeAfterFetch("month", "week", { ok: false })).toBe("month");
    expect(revenueRangeAfterFetch("week", "month", null)).toBe("week"); // excepción de red
  });
});
