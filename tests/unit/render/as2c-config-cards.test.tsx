import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * [AS-2c] Tarjetas del tope por intervalo (C-AS3, plan §23.7) y grilla de duraciones (§23.8): render real
 * (`renderToStaticMarkup`) de General, la ficha del profesional y el paso de servicios del onboarding. Se mockean
 * solo las server actions (red) y `next/navigation`.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/tenant-settings", () => ({
  setSharedPatientView: async () => ({ ok: true, data: undefined }),
  updateTenantBasics: async () => ({ ok: true, data: undefined }),
  setBusinessHours: async () => ({ ok: true, data: undefined }),
  setPublicBookingEnabled: async () => ({ ok: true, data: undefined }),
  setTenantBookingCap: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/practitioner-schedule", () => ({
  setPractitionerBookingCap: async () => ({ ok: true, data: undefined }),
  getPractitionerSchedule: async () => null,
  savePractitionerWeek: async () => ({ ok: true, data: { version: null } }),
  listExceptions: async () => ({ ok: true, data: [] }),
  upsertException: async () => ({ ok: true, data: { id: "x" } }),
  deleteException: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/onboarding", () => ({
  saveOnboardingClinic: vi.fn(),
  completeOnboarding: vi.fn(),
  saveOnboardingLocation: vi.fn(),
  openPendingInvitation: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import { GeneralPanel } from "@/components/configuracion/panels/general-panel";
import { BookingCapEditor, PractitionerPanel } from "@/components/configuracion/panels/practitioners/practitioner-panel";
import { StepServices } from "@/components/onboarding/steps-catalog";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { TenantSettings } from "@/lib/tenant-settings";

/** El tag entero del primer elemento que contiene `marker` (los atributos salen en el orden que elige React). */
const tagWith = (h: string, marker: string) => h.match(new RegExp(`<(?:input|option)[^>]*${marker}[^>]*>`))?.[0] ?? "";
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TweaksProvider>{el}</TweaksProvider>
      </ConfirmProvider>
    </ToastProvider>
  );

const TENANT = {
  slug: "norte",
  vertical: "KINESIOLOGY",
  plan: "PRO",
  saasPlan: "CLINICA",
  publicBookingEnabled: false,
  name: "Norte",
  legalName: null,
  taxId: null,
  timezone: "America/Argentina/Buenos_Aires",
  currency: "ARS",
  sharedPatientView: false,
  businessHoursStart: 8,
  businessHoursEnd: 19,
  agendaSlotMinutes: 60,
  bookingCapCount: null,
  bookingCapIntervalMin: null,
  updatedAt: "2026-10-18T12:00:00.000Z",
} as unknown as TenantSettings;

describe("[AS-2c] General › «Turnos por profesional»", () => {
  it("sin tope: el campo vacío con «Sin tope» y el intervalo en 15/30/60", () => {
    const h = wrap(<GeneralPanel tenant={TENANT} admin sensitive={false} />);
    const t = text(h);
    expect(t).toContain("Turnos por profesional");
    expect(t).toContain("Máximo de turnos por profesional");
    expect(t).toContain("Dejalo vacío para no poner tope");
    const input = h.match(/<input[^>]*aria-label="Máximo de turnos por profesional[^"]*"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('placeholder="Sin tope"');
    expect(input).toContain('value=""');
    expect(input).toContain('min="1"');
    expect(input).toContain('max="60"');
    const sel = h.match(/<select[^>]*aria-label="Intervalo del tope"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
    expect([...sel.matchAll(/<option[^>]*value="(\d+)"/g)].map((m) => m[1])).toEqual(["15", "30", "60"]);
  });

  it("con tope «2 cada 30»: muestra lo guardado", () => {
    const h = wrap(
      <GeneralPanel tenant={{ ...TENANT, bookingCapCount: 2, bookingCapIntervalMin: 30 }} admin sensitive={false} />
    );
    expect(tagWith(h, 'aria-label="Máximo de turnos por profesional')).toContain('value="2"');
    expect(h).toMatch(/<option value="30" selected="">30 min<\/option>/);
  });

  it("sin «Configuración» los campos van deshabilitados (como el horario)", () => {
    const h = wrap(<GeneralPanel tenant={TENANT} admin={false} sensitive={false} />);
    expect(tagWith(h, 'aria-label="Máximo de turnos por profesional')).toContain('disabled=""');
  });

  it("la vista de agenda ofrece 15 minutos también", () => {
    const t = text(wrap(<GeneralPanel tenant={TENANT} admin sensitive={false} />));
    expect(t).toContain("Cada 15 minutos");
    expect(t).toContain("Cada 30 minutos");
    expect(t).toContain("Cada 1 hora");
  });
});

const ROW = {
  practitionerId: "p1",
  name: "Ana Pérez",
  summary: "Lun-Vie 08:00-19:00",
  isFallback: false,
  rangeCount: 5,
  locationIds: [],
};

describe("[AS-2c] Profesional › tope de turnos", () => {
  it("INHERIT: «Usar el del consultorio (2 turnos cada 15 min)» tildado", () => {
    const h = wrap(
      <BookingCapEditor
        practitionerId="p1"
        practitionerName="Ana Pérez"
        cap={{ mode: "INHERIT", count: null, intervalMin: null, tenant: { count: 2, intervalMin: 15 } }}
      />
    );
    const t = text(h);
    expect(t).toContain("Tope de turnos de Ana Pérez");
    expect(t).toContain("Usar el del consultorio (2 turnos cada 15 min)");
    expect(t).toContain("Sin tope");
    expect(t).toContain("Propio:");
    const radios = [...h.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(3);
    expect(radios.find((r) => r.includes('value="INHERIT"'))).toContain('checked=""');
    expect(radios.filter((r) => r.includes("checked"))).toHaveLength(1);
  });

  it("INHERIT sin tope del consultorio lo dice", () => {
    const t = text(
      wrap(
        <BookingCapEditor
          practitionerId="p1"
          practitionerName="Ana Pérez"
          cap={{ mode: "INHERIT", count: null, intervalMin: null, tenant: null }}
        />
      )
    );
    expect(t).toContain("Usar el del consultorio (hoy, sin tope)");
  });

  it("CUSTOM «3 cada 60»: tildado y con sus valores", () => {
    const h = wrap(
      <BookingCapEditor
        practitionerId="p1"
        practitionerName="Ana Pérez"
        cap={{ mode: "CUSTOM", count: 3, intervalMin: 60, tenant: null }}
      />
    );
    expect(tagWith(h, 'value="CUSTOM"')).toContain('checked=""');
    expect(tagWith(h, 'aria-label="Máximo de turnos de Ana Pérez"')).toContain('value="3"');
    expect(h).toMatch(/<option value="60" selected="">60 min<\/option>/);
  });

  it("NONE tildado", () => {
    const h = wrap(
      <BookingCapEditor practitionerId="p1" practitionerName="Ana" cap={{ mode: "NONE", count: null, intervalMin: null, tenant: null }} />
    );
    expect(tagWith(h, 'value="NONE"')).toContain('checked=""');
  });

  it("la ficha lo muestra en Horarios solo si la fila trae el tope", () => {
    const withCap = wrap(
      <PractitionerPanel
        summary={[{ ...ROW, bookingCap: { mode: "NONE", count: null, intervalMin: null, tenant: null } }]}
        locations={[]}
      />
    );
    expect(withCap).toContain("data-booking-cap-editor");
    const without = wrap(<PractitionerPanel summary={[ROW]} locations={[]} />);
    expect(without).not.toContain("data-booking-cap-editor");
  });
});

describe("[AS-2c] Onboarding › duración en la grilla de 15", () => {
  it("ofrece 15..240 de a 15, con 45 por default", () => {
    const h = wrap(<StepServices services={[]} vertical="KINESIOLOGY" />);
    const sel = [...h.matchAll(/<select[^>]*>[\s\S]*?<\/select>/g)].map((m) => m[0]).find((s) => s.includes(">240 min<")) ?? "";
    const values = [...sel.matchAll(/<option[^>]*value="(\d+)"/g)].map((m) => Number(m[1]));
    expect(values).toEqual(Array.from({ length: 16 }, (_, i) => 15 * (i + 1)));
    expect(tagWith(sel, 'value="45"')).toContain('selected=""');
    expect(sel).not.toContain(">40 min<");
  });
});
