/**
 * [TP-3f] Sala (§25.10 «Sala»; Anexo C «3f1 Sala»): el modal «Registrar cobro» cobra lo que falta y dice la seña, el
 * atendido pagado online muestra «Pagado por Mercado Pago» y el menú ⋯ abre `PaymentLinkDrawer` (diferido, una
 * instancia por apertura). Render SSR de los componentes REALES; se mockean la red (server actions), el router, el
 * toast y `next/dynamic` (resuelto en `beforeAll`, como `reception-desk.test.tsx`). Horas AR explícitas: TZ=UTC y AR.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { dynamicLoads } = vi.hoisted(() => ({ dynamicLoads: [] as Promise<unknown>[] }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<import("react").ComponentType<Record<string, unknown>>>) => {
    let Loaded: import("react").ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(loader().then((C) => (Loaded = C)));
    return function DynamicMock(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
beforeAll(async () => {
  let seen = -1;
  while (seen !== dynamicLoads.length) {
    seen = dynamicLoads.length;
    await Promise.all(dynamicLoads);
  }
});

vi.mock("@/lib/bookings", () => ({ markReceptionAction: vi.fn(), setBookingCopagoPaid: vi.fn(), listAgendaBookings: vi.fn() }));
vi.mock("@/lib/payment-links", () => ({ createPaymentLink: vi.fn(), getPaymentLinkSuggestions: vi.fn(), getPaymentLinkShare: vi.fn(), sendPaymentLinkEmail: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sala",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import type { BookingDTO } from "@/components/agenda/agenda-utils";
import {
  DESK_SEND_LINK_LABEL,
  DeskActionsProvider,
  DeskCopagoTag,
  DeskPrimaryAction,
  paymentLinkTargetOf,
  type DeskActionsApi,
} from "@/components/sala/desk/desk-actions";
import { DeskPayModal } from "@/components/sala/desk/desk-pay-modal";
import { formatARS } from "@/lib/format";
import { BOOKING_MONEY_COPY } from "@/lib/online-payments-copy";
import { deskEntries, deskViewer, type DeskViewer } from "@/lib/reception-desk-state";

const DAY = "2026-10-15";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date("2026-10-15T13:42:00Z"); // 10:42 AR

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id, scheduledFor: at(h), durationMin: 45, status: "COMPLETED", serviceId: "s", serviceName: "Kinesiología",
    serviceColor: "#3d74b5", practitionerId: "p1", patientId: `pat-${id}`, patientName: `Paciente ${id}`,
    patientCondition: null, obraSocial: "Particular", copagoCents: 2_000_000, updatedAt: at("08:00"), notes: null,
    title: null, description: null, patientAccess: "full", isOverbooked: false, arrivedAt: null, attendingAt: null,
    calledAt: null, roomId: null, canOperate: true, paymentStatus: "UNPAID", ...over,
  };
}

const SECRETARIA = deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll", "billing.collect"], true);

function api(viewer: DeskViewer): DeskActionsApi {
  return {
    viewer, dayKey: DAY, now: NOW, pendingIds: new Set(), practitionerName: () => "Ana Pérez", run: vi.fn(), collect: vi.fn(),
  };
}
function primary(row: BookingDTO, viewer: DeskViewer = SECRETARIA) {
  const [entry] = deskEntries([row], NOW, viewer);
  return renderToStaticMarkup(
    <DeskActionsProvider value={api(viewer)}>
      {/* [CF2-SD] lo pagado lo dice el tag de cobro (antes, la primaria de un atendido). */}
      <DeskCopagoTag row={entry.row} />
      <DeskPrimaryAction entry={entry} />
    </DeskActionsProvider>
  );
}
const pay = (row: BookingDTO) =>
  renderToStaticMarkup(<DeskPayModal row={row} practitionerName="Ana Pérez" viewer={SECRETARIA} onClose={() => {}} onSaved={() => {}} />);

describe("[TP-3f] modal «Registrar cobro» de la sala: lo que falta", () => {
  it("[TP-3f] con seña: importe y botón = copago − seña, y la línea de la seña", () => {
    const html = pay(dto("seña", "09:00", { onlineDepositCents: 600_000 }));
    expect(html).toContain(`Marcar pagado · ${formatARS(1_400_000)}`);
    expect(html).not.toContain(formatARS(2_000_000));
    expect(html).toContain('data-testid="collect-deposit"');
    expect(html).toContain(`Seña pagada por Mercado Pago · ${formatARS(600_000)}. Se cobra lo que falta.`);
    // Lo de siempre sigue: a quién se imputa y el medio obligatorio sin preselección.
    expect(html).toContain("Se imputa a Ana Pérez");
    expect(html.match(/type="radio"/g)).toHaveLength(6);
    expect(html).not.toMatch(/checked=""/);
  });

  it("[TP-3f] sin seña: el copago entero y sin la línea de la seña", () => {
    const html = pay(dto("nada", "09:00"));
    expect(html).toContain(`Marcar pagado · ${formatARS(2_000_000)}`);
    expect(html).not.toContain('data-testid="collect-deposit"');
  });
});

describe("[TP-3f] fila de la sala", () => {
  it("[TP-3f] pagado entero online → «Pagado por Mercado Pago» (sin «Cobrar»)", () => {
    const html = primary(dto("online", "09:00", { paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true }));
    expect(html).toContain("Pagado por Mercado Pago");
    expect(html).not.toContain("Pagado · Mercado Pago");
    expect(html).not.toContain(">Cobrar<");
  });

  it("[TP-3f] la Secretaría registró a mano el medio «Mercado Pago» → «Pagado · Mercado Pago» (como en T3)", () => {
    const html = primary(dto("manual", "09:00", { paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO" }));
    expect(html).toContain("Pagado · Mercado Pago");
  });

  it("[TP-3f] «Cobrar» nombra lo que falta en su aria-label", () => {
    const html = primary(dto("seña", "09:00", { onlineDepositCents: 600_000 }));
    expect(html).toContain(`aria-label="Cobrar a Paciente seña, ${formatARS(1_400_000)}"`);
  });

  it("[TP-3f] el provider no monta el drawer del link hasta que alguien lo pide", () => {
    const html = primary(dto("seña", "09:00", { onlineDepositCents: 600_000 }));
    expect(html).not.toContain("payment-link-form");
  });
});

describe("[TP-3f] «Enviar link de pago» abre el PaymentLinkDrawer compartido", () => {
  it("[TP-3f] paymentLinkTargetOf: el turno de la fila, la superficie «sala» y sin lista de profesionales", () => {
    const row = dto("seña", "09:00", { onlineDepositCents: 600_000 });
    expect(paymentLinkTargetOf(row, "Ana Pérez")).toEqual({
      surface: "sala",
      patient: { id: "pat-seña", name: "Paciente seña" },
      booking: { id: "seña", startsAt: row.scheduledFor, practitionerId: "p1", practitionerName: "Ana Pérez" },
      practitioners: [],
    });
    expect(paymentLinkTargetOf(dto("x", "09:00", { patientId: null }), "Ana Pérez")).toBeNull();
  });

  it("[TP-3f] diferido y del MISMO módulo que el drawer del turno (un chunk), con una instancia por apertura (key)", () => {
    const src = readFileSync(join(process.cwd(), "components/sala/desk/desk-actions.tsx"), "utf8");
    expect(src).not.toMatch(/^import[^;]*from\s+"@\/components\/payments\/payment-link-drawer"/m);
    expect(src).toContain('import("@/components/payments/payment-link-drawer")');
    expect(src).toMatch(/<PaymentLinkDrawer\s[^>]*key=\{/);
    expect(src).toContain("{DESK_SEND_LINK_LABEL}");
  });

  it("[TP-ZF3] el ítem «Enviar link de pago» va literal (sin importar la copy a /sala) e igual a la copy compartida", () => {
    const src = readFileSync(join(process.cwd(), "components/sala/desk/desk-actions.tsx"), "utf8");
    expect(src).not.toMatch(/from\s+"@\/lib\/online-payments-copy"/);
    expect(DESK_SEND_LINK_LABEL).toBe(BOOKING_MONEY_COPY.sendLink);
  });
});
