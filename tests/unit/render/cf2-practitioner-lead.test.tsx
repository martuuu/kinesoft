import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * [CF2-TU2] Anticipación del turnero por profesional en Configuración (CF2 §29, T.A; D-CF2-8) y el «Ocultar su
 * contacto del turnero» del titular (T.B; D-CF2-9), más la salida de «Avisarme» de Servicios (T.C).
 *
 * Render real (`renderToStaticMarkup`: no hay jsdom) y la lógica pura del borrador (ida y vuelta horas/días/semanas
 * con `leadToParts`/`leadFromParts`). Se mockean solo las server actions (red) y `next/navigation`/`next/cache`.
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
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
// `react.cache` (de los módulos server que arrastra el import) no existe fuera del runtime de Next.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import {
  PractitionerLeadEditor,
  PractitionerLeadContactHide,
  practitionerLeadDraft,
  practitionerLeadInput,
} from "@/components/configuracion/panels/practitioners/lead-editor";
import { PractitionerPanel } from "@/components/configuracion/panels/practitioners/practitioner-panel";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { AGENDA_RULES_COPY } from "@/lib/agenda-rules-config";
import { draftToInput, rowToDraft } from "@/lib/practitioner-editors-state";
import type { PractitionerServiceRow } from "@/lib/practitioner-config-schemas";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const radio = (h: string, value: string) =>
  h.match(new RegExp(`<input[^>]*type="radio"[^>]*value="${value}"[^>]*>`))?.[0] ?? "";
const leadInput = (h: string) => h.match(/<input[^>]*type="number"[^>]*>/)?.[0] ?? "";
const selectedUnit = (h: string) =>
  h.match(/<select[^>]*>[\s\S]*?<\/select>/)?.[0].match(/<option[^>]*value="([^"]*)"[^>]*selected=""/)?.[1];

const ROW = {
  practitionerId: "p1",
  name: "Ana Pérez",
  summary: "Lun-Vie 08:00-19:00",
  isFallback: false,
  rangeCount: 5,
  locationIds: [],
  agendaRules: {
    allowParallelServices: false,
    agendaSlotStepMin: null,
    publicSlotStepMin: null,
    tenant: { agendaSlotStepMin: null, publicSlotStepMin: null },
  },
  publicLead: { own: 180, tenant: null },
};

describe("[CF2-TU2] borrador de la anticipación del profesional (puro)", () => {
  it("[CF2-TU2-1] NULL = «Usar la del consultorio»; un valor abre en la mayor unidad exacta", () => {
    expect(practitionerLeadDraft(null)).toEqual({ mode: "inherit", value: "", unit: "hours" });
    expect(practitionerLeadDraft(180)).toEqual({ mode: "own", value: "3", unit: "hours" });
    expect(practitionerLeadDraft(2 * 1440)).toEqual({ mode: "own", value: "2", unit: "days" });
    expect(practitionerLeadDraft(0)).toEqual({ mode: "own", value: "0", unit: "hours" });
  });

  it.each([0, 60, 180, 1440, 2 * 1440, 10_080, 80_640])(
    "[CF2-TU2-2] %s min: abrir y guardar sin tocar nada es la identidad",
    (min) => {
      expect(practitionerLeadInput(practitionerLeadDraft(min))).toEqual({ ok: true, minutes: min });
    }
  );

  it("[CF2-TU2-3] «Usar la del consultorio» manda NULL aunque haya un número escrito", () => {
    expect(practitionerLeadInput({ mode: "inherit", value: "5", unit: "days" })).toEqual({ ok: true, minutes: null });
  });

  it("[CF2-TU2-4] propia vacía, con decimales o fuera de rango → error con el copy del server", () => {
    const empty = practitionerLeadInput({ mode: "own", value: " ", unit: "hours" });
    expect(empty.ok).toBe(false);
    const dec = practitionerLeadInput({ mode: "own", value: "1.5", unit: "hours" });
    expect(dec).toEqual({ ok: false, error: AGENDA_RULES_COPY.minLead });
    expect(practitionerLeadInput({ mode: "own", value: "9", unit: "weeks" })).toEqual({
      ok: false,
      error: AGENDA_RULES_COPY.minLead,
    });
  });
});

describe("[CF2-TU2] PractitionerLeadEditor", () => {
  it("[CF2-TU2-5] sin valor propio: «Usar la del consultorio (1 hora)» marcada y el hint del servicio", () => {
    const h = wrap(<PractitionerLeadEditor practitionerId="p1" practitionerName="Ana Pérez" own={null} tenant={null} />);
    const t = text(h);
    expect(h).toContain("data-lead-editor");
    expect(t).toContain("Anticipación del turnero de Ana Pérez");
    expect(t).toContain("Usar la del consultorio (1 hora)");
    expect(radio(h, "inherit")).toContain('checked=""');
    expect(radio(h, "own")).not.toContain('checked=""');
    expect(t).toContain("Si un servicio tiene la suya, manda esa");
  });

  it("[CF2-TU2-6] el label de heredar dice la del consultorio guardada (2 días)", () => {
    const t = text(wrap(<PractitionerLeadEditor practitionerId="p1" practitionerName="Ana" own={null} tenant={2880} />));
    expect(t).toContain("Usar la del consultorio (2 días)");
  });

  it("[CF2-TU2-7] con valor propio: «Propia» marcada con 3 horas", () => {
    const h = wrap(<PractitionerLeadEditor practitionerId="p1" practitionerName="Ana" own={180} tenant={60} />);
    expect(radio(h, "own")).toContain('checked=""');
    expect(leadInput(h)).toContain('value="3"');
    expect(selectedUnit(h)).toBe("hours");
  });

  it("[CF2-TU2-8] `self`: el copy habla en segunda persona («Tu anticipación»)", () => {
    const t = text(wrap(<PractitionerLeadEditor practitionerId="p1" practitionerName="Ana" own={null} tenant={null} self />));
    expect(t).toContain("Tu anticipación del turnero");
    expect(t).not.toContain("Anticipación del turnero de Ana");
  });
});

describe("[CF2-TU2] Profesionales › Horarios", () => {
  it("[CF2-TU2-9] monta el editor de anticipación debajo de las reglas (y no sin `publicLead`)", () => {
    const h = wrap(<PractitionerPanel summary={[ROW]} locations={[]} />);
    const rules = h.indexOf("data-agenda-rules-editor");
    const lead = h.indexOf("data-lead-editor");
    expect(rules).toBeGreaterThan(-1);
    expect(lead).toBeGreaterThan(rules);
    const { publicLead: _l, ...bare } = ROW;
    expect(wrap(<PractitionerPanel summary={[bare]} locations={[]} />)).not.toContain("data-lead-editor");
  });

  it("[CF2-TU2-10] «Ocultar su contacto del turnero» solo para `tenant.sensitive` y con el contacto prendido", () => {
    const on = { ...ROW, leadContactShown: true };
    expect(text(wrap(<PractitionerPanel summary={[on]} locations={[]} sensitive />))).toContain(
      "Ocultar su contacto del turnero"
    );
    expect(text(wrap(<PractitionerPanel summary={[on]} locations={[]} />))).not.toContain("Ocultar su contacto");
    expect(
      text(wrap(<PractitionerPanel summary={[{ ...ROW, leadContactShown: false }]} locations={[]} sensitive />))
    ).not.toContain("Ocultar su contacto");
    expect(text(wrap(<PractitionerPanel summary={[ROW]} locations={[]} sensitive />))).not.toContain("Ocultar su contacto");
  });

  it("[CF2-TU2-11] el botón de ocultar explica qué pasa y usa el confirm del design system", () => {
    const h = wrap(<PractitionerLeadContactHide practitionerId="p1" practitionerName="Ana Pérez" />);
    expect(h).toContain("data-lead-contact-hide");
    expect(text(h)).toContain("Ana Pérez muestra su WhatsApp");
    const src = readFileSync("components/configuracion/panels/practitioners/lead-editor.tsx", "utf8");
    expect(src).toContain("useConfirm");
    expect(src).not.toMatch(/window\.confirm|[^.]confirm\(\s*"/);
  });
});

describe("[CF2-TU2] Servicios del profesional: sin «Avisarme» (T.C)", () => {
  const src = readFileSync("components/configuracion/panels/practitioners/services-editor.tsx", "utf8");
  it("[CF2-TU2-12] no hay header ni celda «Avisarme»; el hint de anticipación nombra al profesional", () => {
    expect(src).not.toContain("Avisarme");
    expect(src).toContain("Vacío: la del profesional o la del consultorio");
    expect(src).not.toContain(">Vacío: la del consultorio<");
  });

  it("[CF2-TU2-13] el borrador sigue mandando el aviso guardado (no se apaga solo al guardar otra cosa)", () => {
    const row: PractitionerServiceRow = {
      serviceId: "s1",
      serviceName: "Kine",
      serviceColor: null,
      serviceDurationMin: 45,
      serviceMaxConcurrent: 1,
      serviceOwnerPractitionerId: null,
      hasRow: true,
      enabled: true,
      durationMin: null,
      visibility: "PUBLIC",
      minLeadMinutes: null,
      maxLeadDays: null,
      concurrencyOverride: false,
      maxConcurrent: null,
      notifyOnBooking: true,
      priceCents: null,
      servicePriceCents: 0,
    };
    const r = draftToInput(rowToDraft(row));
    expect(r.ok && r.input.notifyOnBooking).toBe(true);
  });
});

describe("[CF2-TU2] General › hint de «Reglas de la agenda»", () => {
  it("[CF2-TU2-14] dice que cada profesional puede tener su anticipación", () => {
    const src = readFileSync("components/configuracion/panels/general-panel.tsx", "utf8");
    const t = src.replace(/\s+/g, " ");
    // [M7] de CF-ZF4 sigue: «sus propios intervalos en Profesionales».
    expect(t).toContain("sus propios intervalos en Profesionales y su propia anticipación");
    expect(t).toContain("si un servicio del profesional tiene la suya, manda esa");
  });
});
