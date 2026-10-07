import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/bookings", () => ({ markReceptionAction: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { StatusTag } from "@/components/ui/status-tag";
import { ListView, StatusTag as ListStatusTag } from "@/components/agenda/views/list-view";
import { StatusTag as DrawerStatusTag } from "@/components/agenda/booking-drawer/status-tag";
import { PatientHeader } from "@/components/agenda/booking-drawer/patient-header";
import { BillingRows } from "@/components/agenda/booking-drawer/billing-rows";
import { BookingStatusTag } from "@/components/patients/profile/ui";
import { ReceptionView } from "@/components/agenda/reception/reception-view";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { formatARS } from "@/lib/format";

/**
 * [P0-S04b] StatusTag único: "Ausente" ámbar (--st-noshow-*) en Lista, drawer,
 * perfil y Recepción. Se montan las pantallas reales (ListView, PatientHeader,
 * BookingStatusTag, ReceptionView), no solo el componente compartido.
 */

const DAY = "2026-10-05";
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T13:00:00-03:00`);

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return { id, scheduledFor: iso(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología", serviceColor: "#3d74b5", practitionerId: "p1", patientId: "pat", patientName: `Paciente ${id}`, patientCondition: null, obraSocial: "Particular", copagoCents: 150000, updatedAt: iso("08:00"), notes: null, title: null, description: null, patientAccess: "full", arrivedAt: null, attendingAt: null, ...over };
}

const NOSHOW_BG = "background:var(--st-noshow-bg)";
const NOSHOW_FG = "color:var(--st-noshow-fg)";

function ausentePill(html: string): string {
  const m = html.match(/<span[^>]*data-status="NO_SHOW"[^>]*>[\s\S]*?<\/span>/);
  expect(m, "pill NO_SHOW").not.toBeNull();
  return m![0];
}

describe("[P0-S04b] StatusTag único", () => {
  it("Ausente en ámbar en la Lista", () => {
    const html = renderToStaticMarkup(
      <ListView bookings={[dto("a", "09:00", { status: "NO_SHOW" })]} onEdit={() => {}} highlight={null} now={NOW} />,
    );
    const pill = ausentePill(html);
    expect(pill).toContain("Ausente");
    expect(pill).toContain(NOSHOW_BG);
    expect(pill).toContain(NOSHOW_FG);
  });

  it("Ausente en ámbar en el drawer", () => {
    const booking = { ...dto("a", "09:00", { status: "NO_SHOW" }) } as unknown as DrawerBooking;
    const html = renderToStaticMarkup(<PatientHeader booking={booking} />);
    const pill = ausentePill(html);
    expect(pill).toContain("Ausente");
    expect(pill).toContain(NOSHOW_BG);
    expect(pill).toContain(NOSHOW_FG);
    // Antes el drawer lo pintaba rojo.
    expect(pill).not.toMatch(/9F1F1F|228,\s*70,\s*70/i);
  });

  it("Ausente en ámbar en el perfil (BookingStatusTag conserva su firma)", () => {
    const html = renderToStaticMarkup(<BookingStatusTag status="NO_SHOW" />);
    const pill = ausentePill(html);
    expect(pill).toContain("Ausente");
    expect(pill).toContain(NOSHOW_BG);
    expect(pill).toContain(NOSHOW_FG);
    expect(pill).not.toContain("k-tag");
  });

  it("Ausente en ámbar en Recepción", () => {
    const html = renderToStaticMarkup(
      <ReceptionView dayKey={DAY} bookings={[dto("a", "09:00", { status: "NO_SHOW" })]} practitioners={[{ id: "p1", name: "Ana Pérez", initials: "AP" }]} now={NOW} canOperate onOpenBooking={() => {}} onChanged={() => {}} />,
    );
    const m = html.match(/<span[^>]*class="rcp-tag"[^>]*data-state="ausente"[^>]*>/);
    expect(m, "tag ausente de Recepción").not.toBeNull();
    expect(m![0]).toContain(NOSHOW_BG);
    expect(m![0]).toContain(NOSHOW_FG);
  });

  it("Lista, drawer y semana usan el mismo componente (re-export)", () => {
    expect(ListStatusTag).toBe(StatusTag);
    expect(DrawerStatusTag).toBe(StatusTag);
    const week = readFileSync(join(process.cwd(), "components/agenda/views/week-grid-view.tsx"), "utf8");
    expect(week).toContain('import { StatusTag } from "@/components/ui/status-tag"');
  });

  it("cada estado va con su token --st-* y su texto; Hecho lleva check", () => {
    const cases = [
      ["PENDING", "pending", "Pendiente"],
      ["CONFIRMED", "confirmed", "Confirmado"],
      ["COMPLETED", "completed", "Hecho"],
      ["NO_SHOW", "noshow", "Ausente"],
      ["CANCELLED", "cancelled", "Cancelado"],
    ] as const;
    for (const [s, tone, label] of cases) {
      const html = renderToStaticMarkup(<StatusTag s={s} />);
      expect(html).toContain(`background:var(--st-${tone}-bg)`);
      expect(html).toContain(`color:var(--st-${tone}-fg)`);
      expect(html).toContain(label);
    }
    expect(renderToStaticMarkup(<StatusTag s="COMPLETED" />)).toContain("<svg");
  });

  it("reserva online: vigente en --st-hold, vencida en --st-hold-expired con borde punteado", () => {
    const live = renderToStaticMarkup(<StatusTag s="PENDING" hold="pendiente" />);
    expect(live).toContain("background:var(--st-hold-bg)");
    expect(live).toContain("Pendiente de pago");
    const expired = renderToStaticMarkup(<StatusTag s="PENDING" hold="vencida" />);
    expect(expired).toContain("background:var(--st-hold-expired-bg)");
    expect(expired).toContain("dashed var(--st-hold-expired-border)");
  });

  it("StatusTag no tiene colores literales ni agrega tonos a Tag", () => {
    const src = readFileSync(join(process.cwd(), "components/ui/status-tag.tsx"), "utf8");
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(src).not.toMatch(/from "@\/components\/ui\/tag"/);
    const tag = readFileSync(join(process.cwd(), "components/ui/tag.tsx"), "utf8");
    expect(tag).toMatch(/type Tone = "lime" \| "sky" \| "soft";/);
  });

  it("drawer: el copago sale con formatARS", () => {
    const booking = { ...dto("a", "09:00"), copagoCents: 123456 } as unknown as DrawerBooking;
    const html = renderToStaticMarkup(<BillingRows booking={booking} />);
    expect(html).toContain(formatARS(123456));
  });
});
