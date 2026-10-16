import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

// MB-1b · «Nuevo turno», drawer del turno y Recepción de la agenda en el celular (C-MB2/C-MB3) y en el escritorio
// chico (C-MB4). Render real (sin jsdom, como el resto de `tests/unit/render`); se mockean solo las server actions y
// los hooks de toast/confirm (mismo set que agenda-pf12.test.tsx). Lo que es CSS (media queries) se afirma sobre el
// archivo: un inline no se puede pisar desde un @media, así que la regla TIENE que vivir en el CSS.
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());
vi.mock("@/lib/search", () => proxy());

import { BookingModal } from "@/components/agenda/booking-modal";
import { BookingDrawer } from "@/components/agenda/booking-drawer";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { ReceptionView } from "@/components/agenda/reception/reception-view";
import {
  RECEPTION_FIT_MIN_PX,
  RECEPTION_FIT_MQ,
  receptionScrollMaxHeight,
} from "@/components/agenda/reception/reception-fit";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import modalStyles from "@/components/agenda/booking-modal/booking-modal.module.css";
import drawerStyles from "@/components/agenda/booking-drawer/booking-drawer.module.css";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
/** El bloque de una media query (hasta la próxima `@media` o el final). */
function mediaBlock(css: string, query: string): string {
  const i = css.indexOf(`@media ${query}`);
  expect(i, `falta @media ${query}`).toBeGreaterThanOrEqual(0);
  const rest = css.slice(i + 7);
  const next = rest.indexOf("@media");
  return next < 0 ? rest : rest.slice(0, next);
}

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false });
const kine = (n: ReactNode) => renderToStaticMarkup(<TenantModulesProvider modules={KINE}>{n}</TenantModulesProvider>);

const modalProps = {
  services: [{ id: "s1", name: "Consulta", durationMin: 30, priceCents: 0, color: null }],
  practitioners: [{ id: "p1", name: "Ana Pérez" }],
  patients: [{ id: "pt1", name: "Juana Gómez" }],
  insurers: [],
  onClose: () => {},
  onSaved: () => {},
  defaultISO: "2026-10-05T12:00:00.000Z",
  defaultPractitionerId: "p1",
  capabilities: [...capabilitiesFor("OWNER")],
};

const drawerBooking: DrawerBooking = {
  id: "b1",
  scheduledFor: "2026-10-05T12:00:00.000Z",
  durationMin: 45,
  status: "CONFIRMED",
  serviceName: "Kinesio",
  serviceColor: "#3b82f6",
  practitionerId: "p1",
  patientId: "pt1",
  patientName: "Juana Gómez",
  patientCondition: null,
  obraSocial: "OSDE",
  copagoCents: 150000,
  updatedAt: "2026-10-05T11:00:00.000Z",
  notes: null,
  title: null,
  description: null,
  patientAccess: "full",
};

describe("[MB-1b] «Nuevo turno» y drawer del turno como hoja en el celular", () => {
  it("los dos contenidos llevan la clase de hoja (targets táctiles scopeados al drawer)", () => {
    expect(modalStyles.sheet).toBeTruthy();
    expect(drawerStyles.sheet).toBeTruthy();
    expect(kine(<BookingModal {...modalProps} />)).toContain(`class="${modalStyles.sheet}"`);
    const drawer = renderToStaticMarkup(
      <BookingDrawer booking={drawerBooking} onClose={() => {}} onSaved={() => {}} capabilities={[...capabilitiesFor("OWNER")]} />
    );
    expect(drawer).toContain(`class="${drawerStyles.sheet}"`);
  });

  it.each([
    ["booking-modal", "components/agenda/booking-modal/booking-modal.module.css"],
    ["booking-drawer", "components/agenda/booking-drawer/booking-drawer.module.css"],
  ])("%s < 768: 44 px mínimos y 16 px en los campos (iOS no hace zoom al enfocar)", (_n, file) => {
    const block = mediaBlock(src(file), "(max-width: 767px)");
    expect(block).toMatch(/\.sheet :where\([^)]*button[^)]*\)[^{]*\{[^}]*min-height: 44px/);
    expect(block).toMatch(/select, textarea\)\s*\{\s*font-size: 16px !important/);
  });

  it.each([
    ["booking-modal", "components/agenda/booking-modal/booking-modal.module.css"],
    ["booking-drawer", "components/agenda/booking-drawer/booking-drawer.module.css"],
  ])("%s < 640: el pie sticky va de borde a borde (sin las esquinas de 22 px de la tarjeta flotante)", (_n, file) => {
    const block = mediaBlock(src(file), "(max-width: 639px)");
    expect(block).toMatch(/\.footer\s*\{[^}]*border-radius: 0/);
  });

  it("C-MB4: a 1024+ con poco alto (625/695) el pie de «Nuevo turno» va en una fila (primaria + Cancelar)", () => {
    const block = mediaBlock(src("components/agenda/booking-modal/booking-modal.module.css"), "(min-width: 1024px) and (max-height: 820px)");
    expect(block).toMatch(/\.footer\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  });

  it("«Nuevo paciente» es un switch de verdad: botón con nombre (antes un span de 36×20 sin nombre)", () => {
    const html = kine(<BookingModal {...modalProps} />);
    expect(html).toMatch(/<button type="button" role="switch" aria-checked="false"[^>]*>Nuevo paciente/);
    expect(html).not.toMatch(/<span[^>]*role="switch"/);
  });
});

const DAY = "2026-10-05";
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T10:00:00-03:00`);
function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return { id, scheduledFor: iso(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología deportiva", serviceColor: "#3d74b5", practitionerId: "p1", patientId: "pat", patientName: `Paciente ${id}`, patientCondition: null, obraSocial: "Particular", copagoCents: 0, updatedAt: iso("08:00"), notes: null, title: null, description: null, patientAccess: "full", arrivedAt: null, attendingAt: null, calledAt: null, ...over } as BookingDTO;
}
const pr = [{ id: "p1", name: "Ana Pérez Larralde", initials: "AP" }];
const reception = (bookings: BookingDTO[]) =>
  renderToStaticMarkup(
    <ReceptionView dayKey={DAY} bookings={bookings} practitioners={pr} now={NOW} canOperate onOpenBooking={() => {}} onChanged={() => {}} />
  );

describe("[MB-1b] Recepción de la agenda", () => {
  it("receptionScrollMaxHeight: lo que queda del viewport debajo del tope de la tabla, con piso", () => {
    // 1366×695 (PWA) con la tabla arrancando a 330 px del tope del documento y 14 de padding del main.
    expect(receptionScrollMaxHeight(695, 330, 14)).toBe(351);
    expect(receptionScrollMaxHeight(625, 330.6, 14)).toBe(280);
    // Nunca menos que el piso (la tabla no desaparece si arriba hay mucho).
    expect(receptionScrollMaxHeight(625, 600, 14)).toBe(RECEPTION_FIT_MIN_PX);
    expect(receptionScrollMaxHeight(Number.NaN, 300, 14)).toBeNull();
  });

  it("la media query del ajuste es la del escritorio chico (desde 1024 de ancho y hasta 820 de alto)", () => {
    expect(RECEPTION_FIT_MQ).toBe("(min-width: 1024px) and (max-height: 820px)");
  });

  it("la tabla vive en un scroller propio (scroll adentro, encabezado sticky en el escritorio chico)", () => {
    const html = reception([dto("a", "10:30")]);
    expect(html).toMatch(/<div class="rcp-scroll"[^>]*><table class="rcp-table">/);
  });

  it("nombres largos con title (paciente, servicio, profesional)", () => {
    const html = reception([dto("a", "10:30")]);
    expect(html).toMatch(/class="rcp-link"[^>]*title="Paciente a"|title="Paciente a"[^>]*class="rcp-link"/);
    expect(html).toContain('title="Kinesiología deportiva"');
    expect(html).toContain('title="Ana Pérez Larralde"');
  });

  it("CSS: < 768 todo lo tocable a 44 px; escritorio chico con KPIs en una línea, link en la fila de filtros y filas compactas", () => {
    const css = src("components/agenda/reception/reception-view.tsx");
    const mobile = mediaBlock(css, "(max-width: 767px)");
    for (const sel of [".rcp-btn", ".rcp-chip", ".rcp-desk-link", ".rcp-link"]) expect(mobile).toContain(sel);
    expect(mobile).toMatch(/min-height: 44px/);
    const fit = mediaBlock(css, "(min-width: 1024px) and (max-height: 820px)");
    expect(fit).toMatch(/\.rcp-counter\s*\{[^}]*display: flex/);
    expect(fit).toMatch(/\.rcp-head\s*\{[^}]*grid-row: 2/);
    expect(fit).toMatch(/\.rcp-scroll\s*\{[^}]*overflow: auto/);
    expect(fit).toMatch(/\.rcp-scroll thead th\s*\{[^}]*position: sticky/);
  });
});
