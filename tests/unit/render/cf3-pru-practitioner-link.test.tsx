import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * [CF3-PRU] Configuración › Profesionales (CF3 §30, D-CF3-12 y D-CF3-5; sesión PR-U): el link directo al turnero de
 * cada profesional, con su estado honesto, y el «Ocultar su WhatsApp para obras sociales» del titular.
 *
 * Render real (`renderToStaticMarkup`: no hay jsdom) + la lógica pura del link. Se mockean solo las server actions
 * (red) y `next/navigation`/`next/cache`, igual que cf2-practitioner-lead.test.tsx.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/practitioner-schedule", () => ({
  setPractitionerBookingCap: async () => ({ ok: true, data: undefined }),
  setPractitionerAgendaRules: async () => ({ ok: true, data: undefined }),
  getPractitionerSchedule: async () => null,
  savePractitionerWeek: async () => ({ ok: true, data: { version: null } }),
  listExceptions: async () => ({ ok: true, data: [] }),
  upsertException: async () => ({ ok: true, data: { id: "x" } }),
  deleteException: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/practitioner-services", () => ({
  listPractitionerServices: async () => ({ ok: true, data: [] }),
  upsertPractitionerService: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/practitioner-self-settings", () => ({
  setPractitionerPublicLead: async () => ({ ok: true, data: { publicMinLeadMinutes: null } }),
  hidePractitionerLeadContact: async () => ({ ok: true, data: { show: false } }),
  hidePractitionerInsuredContact: async () => ({ ok: true, data: { showContactForInsured: false } }),
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import {
  PractitionerPanel,
  PractitionerInsuredContactHide,
  TURNERO_LINK_COPY,
  practitionerTurneroLink,
} from "@/components/configuracion/panels/practitioners/practitioner-panel";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import type { TenantModule } from "@/lib/tenant-modules";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const wrap = (el: ReactElement, modules: TenantModule[] = ["turneroPublico"]) =>
  renderToStaticMarkup(
    <TenantModulesProvider modules={modules}>
      <ToastProvider>
        <ConfirmProvider>{el}</ConfirmProvider>
      </ToastProvider>
    </TenantModulesProvider>
  );

const ROW = {
  practitionerId: "p1",
  name: "Ana Pérez",
  summary: "Lun-Vie 08:00-19:00",
  isFallback: false,
  rangeCount: 5,
  locationIds: [],
};
const BASE = { origin: "https://app.test", slug: "kine-sur", practitionerId: "p1", practitionerName: "Ana Pérez", clinicName: "Kine Sur" };

describe("[CF3-PRU-3] link del turnero del profesional (puro)", () => {
  it("prendido: link absoluto con ?pro= y WhatsApp sin destinatario con la invitación", () => {
    const st = practitionerTurneroLink({ ...BASE, tenantOpen: true, practitionerOn: true });
    expect(st.url).toBe("https://app.test/c/kine-sur/booking?pro=p1");
    expect(st.disabledReason).toBeNull();
    expect(st.whatsappHref).toBe(
      `https://wa.me/?text=${encodeURIComponent("Reservá tu turno con Ana Pérez en Kine Sur: https://app.test/c/kine-sur/booking?pro=p1")}`
    );
  });
  it("turnero del consultorio apagado gana (aunque el profesional esté prendido)", () => {
    const st = practitionerTurneroLink({ ...BASE, tenantOpen: false, practitionerOn: true });
    expect(st.disabledReason).toBe(TURNERO_LINK_COPY.tenantOff);
    expect(st.whatsappHref).toBeNull();
  });
  it("switch del profesional apagado: dice cuál prender", () => {
    const st = practitionerTurneroLink({ ...BASE, tenantOpen: true, practitionerOn: false });
    expect(st.disabledReason).toBe("Prendé «Aparece en el turnero online» de Ana Pérez para que el link funcione.");
    expect(st.whatsappHref).toBeNull();
  });
  it("sin origin todavía (server / primer render): relativo y sin WhatsApp; switch desconocido no se afirma", () => {
    const st = practitionerTurneroLink({ ...BASE, origin: "", tenantOpen: true, practitionerOn: undefined });
    expect(st.url).toBe("/c/kine-sur/booking?pro=p1");
    expect(st.disabledReason).toBeNull();
    expect(st.whatsappHref).toBeNull();
  });
  it("el slug y el id se escapan", () => {
    expect(practitionerTurneroLink({ ...BASE, slug: "a b", practitionerId: "x&y", tenantOpen: true, practitionerOn: true }).url).toBe(
      "https://app.test/c/a%20b/booking?pro=x%26y"
    );
  });
});

describe("[CF3-PRU-4] ficha del profesional en Configuración", () => {
  it("con `turnero`: muestra el link, Copiar y Compartir por WhatsApp", () => {
    const h = wrap(<PractitionerPanel summary={[{ ...ROW, publicBookingEnabled: true }]} locations={[]} turnero={{ slug: "kine-sur", clinicName: "Kine Sur" }} />);
    const t = text(h);
    expect(h).toContain("data-turnero-link");
    expect(t).toContain(TURNERO_LINK_COPY.title);
    expect(h).toContain('value="/c/kine-sur/booking?pro=p1"');
    expect(t).toContain(TURNERO_LINK_COPY.copy);
    expect(t).toContain(TURNERO_LINK_COPY.whatsapp);
    expect(t).toContain(TURNERO_LINK_COPY.hint);
  });
  it("turnero del consultorio apagado: link deshabilitado con el motivo", () => {
    const h = wrap(
      <PractitionerPanel summary={[{ ...ROW, publicBookingEnabled: true }]} locations={[]} turnero={{ slug: "kine-sur", clinicName: "Kine Sur" }} />,
      []
    );
    expect(text(h)).toContain(TURNERO_LINK_COPY.tenantOff);
    expect(h).toContain('aria-disabled="true"');
  });
  it("profesional apagado: dice qué prender", () => {
    const h = wrap(<PractitionerPanel summary={[{ ...ROW, publicBookingEnabled: false }]} locations={[]} turnero={{ slug: "kine-sur", clinicName: "Kine Sur" }} />);
    expect(text(h)).toContain(TURNERO_LINK_COPY.practitionerOff("Ana Pérez"));
  });
  it("sin `turnero` (loader sin slug): no hay link", () => {
    const h = wrap(<PractitionerPanel summary={[ROW]} locations={[]} />);
    expect(h).not.toContain("data-turnero-link");
  });
});

describe("[CF3-PRU-5] «Ocultar su WhatsApp para obras sociales»", () => {
  it("el bloque dice qué muestra y ofrece solo ocultar", () => {
    const t = text(wrap(<PractitionerInsuredContactHide practitionerId="p1" practitionerName="Ana Pérez" />));
    expect(t).toContain("Ana Pérez muestra su WhatsApp en el turnero a los pacientes con obra social");
    expect(t).toContain("Ocultar su WhatsApp para obras sociales");
    expect(t).not.toMatch(/Mostrar/);
  });
});

// CF3 ZF3 (revisor de UI): el motivo del link deshabilitado no es un error (navy, como en «Mi agenda») y el input
// deshabilitado tiene contraste AA (`--navy-500`, no `--navy-300` sobre gris). El motivo describe al input.
describe("[CF3-ZF3-7] link deshabilitado en Profesionales", () => {
  it("[CF3-ZF3-7a] motivo en navy con aria-describedby; sin --danger-fg ni --navy-300", () => {
    const h = wrap(
      <PractitionerPanel summary={[{ ...ROW, publicBookingEnabled: true }]} locations={[]} turnero={{ slug: "kine-sur", clinicName: "Kine Sur" }} />,
      []
    );
    const link = h.slice(h.indexOf("data-turnero-link"));
    const reason = link.match(/<div id="([^"]+)" role="note" data-turnero-link-reason="" style="([^"]*)"/);
    expect(reason, "motivo con id y role=note").not.toBeNull();
    expect(reason![2]).toContain("var(--navy-700)");
    expect(reason![2]).not.toContain("danger");
    expect(link).toMatch(new RegExp(`aria-describedby="${reason![1].replace(/[:]/g, "\\$&")}"`));
    const input = link.match(/<input[^>]*>/)![0];
    expect(input).toContain("var(--navy-500)");
    expect(input).not.toContain("navy-300");
  });
});
