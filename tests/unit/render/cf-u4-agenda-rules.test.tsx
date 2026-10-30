import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * [CF-U4] Reglas de la agenda en Configuración (CF, §28; decisiones 1, 3 y 6 de Martin del 30-oct; M20): la tarjeta de
 * General (consultorio), el editor de la ficha del profesional y el hint del cupo. Render real
 * (`renderToStaticMarkup`, no hay jsdom) y la lógica pura del form (ida y vuelta horas/días/semanas). Se mockean solo
 * las server actions (red) y `next/navigation`.
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
  setTenantAgendaRules: async () => ({ ok: true, data: undefined }),
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
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import {
  GeneralPanel,
  tenantAgendaRulesDraft,
  tenantAgendaRulesInput,
} from "@/components/configuracion/panels/general-panel";
import { PractitionerPanel } from "@/components/configuracion/panels/practitioners/practitioner-panel";
import {
  PractitionerAgendaRulesEditor,
  practitionerAgendaRulesInput,
} from "@/components/configuracion/panels/practitioners/agenda-rules-editor";
import { ServicesEditor } from "@/components/configuracion/panels/practitioners/services-editor";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { TenantSettings } from "@/lib/tenant-settings";
import { AGENDA_RULES_COPY, PUBLIC_MIN_LEAD_MAX_MINUTES } from "@/lib/agenda-rules-config";
import { PS_MIN_LEAD_MAX, PractitionerServiceInput } from "@/lib/practitioner-config-schemas";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TweaksProvider>{el}</TweaksProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
const selectBy = (h: string, label: string) =>
  h.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?</select>`))?.[0] ?? "";
const optionValues = (sel: string) => [...sel.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
const selectedValue = (sel: string) => sel.match(/<option[^>]*value="([^"]*)"[^>]*selected=""/)?.[1];

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
  agendaSlotStepMin: null,
  publicSlotStepMin: null,
  publicMinLeadMinutes: null,
  updatedAt: "2026-10-30T12:00:00.000Z",
} satisfies TenantSettings;

describe("[CF-U4] General › «Reglas de la agenda»", () => {
  it("sin configurar: agenda cada 15, turnero automático y anticipación vacía con «Por defecto, 1 hora»", () => {
    const h = wrap(<GeneralPanel tenant={TENANT} admin sensitive={false} />);
    const t = text(h);
    expect(t).toContain("Reglas de la agenda");
    expect(h).toContain("data-agenda-rules-card");
    const agenda = selectBy(h, "Horarios de la agenda cada");
    expect(optionValues(agenda)).toEqual(["15", "30", "45", "60"]);
    expect(selectedValue(agenda)).toBe("15");
    const pub = selectBy(h, "Horarios del turnero cada");
    expect(optionValues(pub)).toEqual(["", "15", "30", "45", "60"]);
    expect(pub).toContain("Automático");
    expect(selectedValue(pub)).toBe("");
    const lead = h.match(/<input[^>]*aria-label="Anticipación mínima del turnero"[^>]*>/)?.[0] ?? "";
    expect(lead).toContain('value=""');
    expect(optionValues(selectBy(h, "Unidad de la anticipación mínima"))).toEqual(["hours", "days", "weeks"]);
    expect(t).toContain("Por defecto, 1 hora");
  });

  it("con valores: muestra lo guardado (30 / 45 / 2 días)", () => {
    const h = wrap(
      <GeneralPanel
        tenant={{ ...TENANT, agendaSlotStepMin: 30, publicSlotStepMin: 45, publicMinLeadMinutes: 2 * 1440 }}
        admin
        sensitive={false}
      />
    );
    expect(selectedValue(selectBy(h, "Horarios de la agenda cada"))).toBe("30");
    expect(selectedValue(selectBy(h, "Horarios del turnero cada"))).toBe("45");
    expect(h.match(/<input[^>]*aria-label="Anticipación mínima del turnero"[^>]*>/)?.[0]).toContain('value="2"');
    expect(selectedValue(selectBy(h, "Unidad de la anticipación mínima"))).toBe("days");
  });

  it("sin `tenant.admin` la tarjeta no se ve", () => {
    const h = wrap(<GeneralPanel tenant={TENANT} admin={false} sensitive={false} />);
    expect(h).not.toContain("data-agenda-rules-card");
    expect(text(h)).not.toContain("Reglas de la agenda");
  });

  it("fixture viejo sin los tres campos (cast): no rompe y muestra los defaults", () => {
    const { agendaSlotStepMin: _a, publicSlotStepMin: _p, publicMinLeadMinutes: _l, ...old } = TENANT;
    const h = wrap(<GeneralPanel tenant={old as unknown as TenantSettings} admin sensitive={false} />);
    expect(selectedValue(selectBy(h, "Horarios de la agenda cada"))).toBe("15");
  });
});

describe("[CF-U4] form del consultorio: ida y vuelta", () => {
  const SAVED = { agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: null };

  it.each([null, 0, 60, 120, 36 * 60, 1440, 3 * 1440, 10080, 2 * 10080, PUBLIC_MIN_LEAD_MAX_MINUTES])(
    "anticipación %s min: abrir y guardar sin tocar nada es la identidad",
    (lead) => {
      const saved = { ...SAVED, publicMinLeadMinutes: lead };
      const r = tenantAgendaRulesInput(tenantAgendaRulesDraft(saved), saved);
      expect(r).toEqual({ ok: true, input: saved });
    }
  );

  it("NULL en la agenda se preserva si no se toca (aunque el select muestre 15)", () => {
    const d = tenantAgendaRulesDraft(SAVED);
    expect(d.agendaStep).toBe("15");
    expect(tenantAgendaRulesInput({ ...d, publicStep: "30" }, SAVED)).toEqual({
      ok: true,
      input: { agendaSlotStepMin: null, publicSlotStepMin: 30, publicMinLeadMinutes: null },
    });
    expect(tenantAgendaRulesInput({ ...d, agendaStep: "45" }, SAVED)).toMatchObject({
      ok: true,
      input: { agendaSlotStepMin: 45 },
    });
  });

  it("horas / días / semanas → minutos", () => {
    const d = tenantAgendaRulesDraft(SAVED);
    const lead = (leadValue: string, leadUnit: "hours" | "days" | "weeks") =>
      tenantAgendaRulesInput({ ...d, leadValue, leadUnit }, SAVED);
    expect(lead("3", "hours")).toMatchObject({ ok: true, input: { publicMinLeadMinutes: 180 } });
    expect(lead("2", "days")).toMatchObject({ ok: true, input: { publicMinLeadMinutes: 2880 } });
    expect(lead("8", "weeks")).toMatchObject({ ok: true, input: { publicMinLeadMinutes: 80_640 } });
    expect(lead("", "weeks")).toMatchObject({ ok: true, input: { publicMinLeadMinutes: null } });
  });

  it("más de 8 semanas o un valor no entero: error en el campo con el copy del server", () => {
    const d = tenantAgendaRulesDraft(SAVED);
    for (const [leadValue, leadUnit] of [["9", "weeks"], ["57", "days"], ["1.5", "hours"], ["-1", "hours"]] as const) {
      expect(tenantAgendaRulesInput({ ...d, leadValue, leadUnit }, SAVED)).toEqual({
        ok: false,
        field: "publicMinLeadMinutes",
        error: AGENDA_RULES_COPY.minLead,
      });
    }
  });
});

const RULES = {
  allowParallelServices: false,
  agendaSlotStepMin: null,
  publicSlotStepMin: null,
  tenant: { agendaSlotStepMin: 30, publicSlotStepMin: null },
};

describe("[CF-U4] Profesional › reglas de agenda", () => {
  it("el interruptor «Atiende servicios distintos a la vez» arranca apagado, con su hint", () => {
    const h = wrap(<PractitionerAgendaRulesEditor practitionerId="p1" practitionerName="Ana Pérez" rules={RULES} />);
    const t = text(h);
    expect(t).toContain("Atiende servicios distintos a la vez");
    // CF-ZF4 (B16): el hint es el del copy compartido, con el sobreturno de la agenda y el turnero.
    expect(t).toContain(AGENDA_RULES_COPY.allowParallelHint);
    expect(AGENDA_RULES_COPY.allowParallelHint).toContain("En la agenda se puede forzar como sobreturno; en el turnero no se ofrece.");
    const sw = h.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
    expect(sw).toContain('aria-checked="false"');
    expect(sw).toContain('aria-label="Atiende servicios distintos a la vez"');
  });

  it("los intervalos ofrecen «Como el consultorio» con el valor que hereda", () => {
    const h = wrap(<PractitionerAgendaRulesEditor practitionerId="p1" practitionerName="Ana Pérez" rules={RULES} />);
    const agenda = selectBy(h, "Horarios de la agenda de Ana Pérez cada");
    expect(optionValues(agenda)).toEqual(["", "15", "30", "45", "60"]);
    expect(selectedValue(agenda)).toBe("");
    expect(agenda).toContain("Como el consultorio (cada 30 min)");
    const pub = selectBy(h, "Horarios del turnero de Ana Pérez cada");
    expect(pub).toContain("Como el consultorio (automático)");
    expect(selectedValue(pub)).toBe("");
  });

  it("prendido y con valores propios: los muestra", () => {
    const h = wrap(
      <PractitionerAgendaRulesEditor
        practitionerId="p1"
        practitionerName="Ana Pérez"
        rules={{ ...RULES, allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: 15 }}
      />
    );
    expect(h.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain('aria-checked="true"');
    expect(selectedValue(selectBy(h, "Horarios de la agenda de Ana Pérez cada"))).toBe("60");
    expect(selectedValue(selectBy(h, "Horarios del turnero de Ana Pérez cada"))).toBe("15");
  });

  it("form → input: vacío = NULL (hereda), el booleano tal cual", () => {
    expect(practitionerAgendaRulesInput({ allowParallelServices: true, agendaStep: "", publicStep: "45" })).toEqual({
      allowParallelServices: true,
      agendaSlotStepMin: null,
      publicSlotStepMin: 45,
    });
  });

  it("la ficha del profesional (Horarios) lo monta cuando la fila trae las reglas", () => {
    const row = {
      practitionerId: "p1",
      name: "Ana Pérez",
      summary: "Lun-Vie 08:00-19:00",
      isFallback: false,
      rangeCount: 5,
      locationIds: [],
      agendaRules: RULES,
    };
    const h = wrap(<PractitionerPanel summary={[row]} locations={[]} />);
    expect(h).toContain("data-agenda-rules-editor");
    const { agendaRules: _r, ...bare } = row;
    expect(wrap(<PractitionerPanel summary={[bare]} locations={[]} />)).not.toContain("data-agenda-rules-editor");
  });
});

describe("[CF-ZF4] revisión de UX (B15/B17)", () => {
  it("[B15] los selects del editor del profesional usan la clase de 44 px de Configuración, no 36 px en línea", () => {
    const h = wrap(<PractitionerAgendaRulesEditor practitionerId="p1" practitionerName="Ana Pérez" rules={RULES} />);
    for (const label of ["Horarios de la agenda de Ana Pérez cada", "Horarios del turnero de Ana Pérez cada"]) {
      const open = selectBy(h, label).match(/<select[^>]*>/)?.[0] ?? "";
      expect(open).toMatch(/class="[^"]*select/);
      expect(open).not.toContain("min-height:36px");
    }
  });

  it("[B17] la anticipación del consultorio no sugiere «1» y el error habla de horas, no de minutos", () => {
    const h = wrap(<GeneralPanel tenant={TENANT} admin sensitive={false} />);
    const lead = h.match(/<input[^>]*aria-label="Anticipación mínima del turnero"[^>]*>/)?.[0] ?? "";
    expect(lead).not.toContain("placeholder");
    expect(AGENDA_RULES_COPY.minLead).toBe("La anticipación mínima del turnero va de 0 horas a 8 semanas.");
  });

  it("[M7] General no manda a «la ficha» del profesional", () => {
    const t = text(wrap(<GeneralPanel tenant={TENANT} admin sensitive={false} />));
    expect(t).not.toContain("en su ficha");
    expect(t).toContain("sus propios intervalos en Profesionales");
  });
});

describe("[CF-U4] Servicios › hint del cupo", () => {
  const HINT = "El cupo es por servicio. Un profesional no atiende servicios distintos a la vez salvo que lo actives en Profesionales → Horarios («Atiende servicios distintos a la vez»).";
  it("la sub-pestaña Servicios del profesional lo dice", () => {
    expect(text(wrap(<ServicesEditor practitionerId="p1" practitionerName="Ana Pérez" />))).toContain(HINT);
  });
});

describe("[CF-U4] anticipación del servicio del profesional (CF-D8)", () => {
  it("el tope pasa de 30 días a 8 semanas", () => {
    expect(PS_MIN_LEAD_MAX).toBe(PUBLIC_MIN_LEAD_MAX_MINUTES);
    const base = { enabled: true, visibility: "PUBLIC", concurrencyOverride: false, notifyOnBooking: false };
    expect(PractitionerServiceInput.safeParse({ ...base, minLeadMinutes: 80_640 }).success).toBe(true);
    expect(PractitionerServiceInput.safeParse({ ...base, minLeadMinutes: 80_641 }).success).toBe(false);
  });
});
