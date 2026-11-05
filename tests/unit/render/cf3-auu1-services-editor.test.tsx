import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * [CF3-AUU1] Servicios del profesional con precio y alcance «self» (CF3 §30, D-CF3-1/6/7/13; sesión AU-U1).
 *
 * Render real con `renderToStaticMarkup` (no hay jsdom: el efecto que carga la lista no corre, por eso las filas se
 * prueban con `ServiceRowEditor` y el formulario con `OwnServiceFields`, los mismos componentes que monta el editor).
 * Se mockean solo las server actions (red) y `next/navigation`/`next/cache`.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/practitioner-services", () => ({
  listPractitionerServices: async () => ({ ok: true, data: [] }),
  upsertPractitionerService: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/services", () => ({
  createService: async () => ({ ok: true, data: { id: "new" } }),
  updateService: async () => ({ ok: true, data: undefined }),
  deleteService: async () => ({ ok: true, data: undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import {
  CUPO_SCOPE_HINT,
  ServiceRowEditor,
  ServicesEditor,
  type RowState,
} from "@/components/configuracion/panels/practitioners/services-editor";
import { OwnServiceFields } from "@/components/configuracion/panels/practitioners/own-service-form";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { ownServiceDraftFrom, rowToDraft } from "@/lib/practitioner-editors-state";
import type { PractitionerServiceRow } from "@/lib/practitioner-config-schemas";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );

const ROW: PractitionerServiceRow = {
  serviceId: "s1",
  serviceName: "Kinesiología",
  serviceColor: null,
  serviceDurationMin: 45,
  serviceMaxConcurrent: 3,
  serviceOwnerPractitionerId: null,
  hasRow: true,
  enabled: true,
  durationMin: null,
  visibility: "PUBLIC",
  minLeadMinutes: null,
  maxLeadDays: null,
  concurrencyOverride: false,
  maxConcurrent: null,
  notifyOnBooking: false,
  priceCents: null,
  servicePriceCents: 2_000_000,
};
const state = (row: PractitionerServiceRow): RowState => {
  const d = rowToDraft(row);
  return { row, baseline: d, draft: d, errors: {}, status: { kind: "idle" } };
};
const noop = () => {};
const rowHtml = (row: PractitionerServiceRow, scope?: "config" | "self", onEditOwn?: () => void) =>
  renderToStaticMarkup(
    <ul>
      <ServiceRowEditor
        state={state(row)}
        practitionerId="p1"
        scope={scope}
        onPatch={noop}
        onSave={noop}
        onDiscard={noop}
        onEditOwn={onEditOwn}
      />
    </ul>
  );

describe("[CF3-AUU1] editor de servicios del profesional", () => {
  it("[CF3-AUU1-10] Configuración: columna «Precio» vacía con el precio del consultorio, y siguen anticipación y cupo", () => {
    const h = rowHtml(ROW);
    const t = text(h);
    expect(t).toContain("Vacío: usa el precio del consultorio ($ 20.000)");
    expect(h).toMatch(/aria-label="Precio de Kinesiología para este profesional \(vacío: el del consultorio\)"/);
    expect(h).toMatch(/inputMode="decimal"/i); // MoneyInput, no un type=number
    expect(t).toContain("Anticipación mínima");
    expect(t).toContain("Cupo por horario");
    expect(t).not.toContain("Tuyo");
  });

  it("[CF3-AUU1-11] precio cargado: el input lo muestra y el hint dice a quién se le cobra", () => {
    const h = rowHtml({ ...ROW, priceCents: 1_500_000 }, "self");
    expect(h).toMatch(/value="15\.000"/);
    expect(text(h)).toContain("Lo pagan tus particulares; con obra social, el copago");
  });

  it("[CF3-AUU1-12] «Mi agenda» (self): «Tu precio», sin anticipación ni cupo; el del consultorio no se edita ni borra", () => {
    const t = text(rowHtml(ROW, "self", noop));
    expect(t).toContain("Tu precio");
    expect(t).toContain("Del consultorio");
    expect(t).not.toContain("Anticipación mínima");
    expect(t).not.toContain("Cupo por horario");
    expect(t).not.toContain("Editar");
  });

  // CF3 ZF3: lo propio tenía dos precios editables (la fila y el Drawer). Ahora la fila solo muestra el valor.
  it("[CF3-AUU1-13] servicio propio en «self»: «Tuyo», «Editar» y el precio se ve pero se edita en el Drawer", () => {
    const h = rowHtml({ ...ROW, serviceOwnerPractitionerId: "p1" }, "self", noop);
    const t = text(h);
    expect(t).toContain("Tuyo");
    expect(h).toMatch(/aria-label="Editar o borrar Kinesiología"/);
    expect(t).toContain("$ 20.000");
    expect(t).toContain("Lo cambiás desde «Editar»");
    expect(t).not.toContain("Tu precio");
    expect(h).not.toMatch(/inputMode="decimal"/i);
  });

  it("[CF3-ZF3-3] el mismo servicio propio en «config» sigue con el MoneyInput de la fila", () => {
    const h = rowHtml({ ...ROW, serviceOwnerPractitionerId: "p1" });
    expect(h).toMatch(/inputMode="decimal"/i);
    expect(text(h)).toContain("Vacío: usa el precio del servicio ($ 20.000)");
  });

  it("[CF3-AUU1-14] cabecera: «self» dice «Servicios y precios» sin el hint del cupo; «config» queda como antes", () => {
    const self = text(wrap(<ServicesEditor practitionerId="p1" practitionerName="Ana Pérez" scope="self" />));
    expect(self).toContain("Servicios y precios");
    expect(self).toContain("Si dejás el precio vacío, se usa el del consultorio");
    expect(self).not.toContain(CUPO_SCOPE_HINT);
    const cfg = text(wrap(<ServicesEditor practitionerId="p1" practitionerName="Ana Pérez" />));
    expect(cfg).toContain("Servicios que atiende");
    expect(cfg).toContain(CUPO_SCOPE_HINT);
  });

  it("[CF3-AUU1-15] formulario del servicio propio: nombre, duración de 15 en 15, precio, cupo y color de 44 px", () => {
    const h = renderToStaticMarkup(<OwnServiceFields draft={ownServiceDraftFrom()} errors={{}} onChange={noop} />);
    const t = text(h);
    for (const l of ["Nombre", "Duración", "Precio", "Pacientes por horario", "Color en la agenda"]) expect(t).toContain(l);
    expect(h).toContain('value="15"');
    expect(h).toContain('value="240"');
    expect(h).not.toContain('value="40"');
    expect(h).toMatch(/class="osf-color"/);
    expect(h).toContain(".osf-color {\n  width: 44px; height: 44px;");
  });

  it("[CF3-AUU1-16] al editar un servicio viejo de 40 min, la duración se muestra «(actual)» y no se cambia sola", () => {
    const old = ownServiceDraftFrom({ ...ROW, serviceDurationMin: 40 });
    const h = renderToStaticMarkup(<OwnServiceFields draft={old} original={old} errors={{}} onChange={noop} />);
    expect(h).toMatch(/<option value="40"[^>]*selected=""[^>]*>40 min \(actual\)/);
  });
});

describe("[CF3-AUU1] fuente: contratos que no se ven en el render", () => {
  const editor = readFileSync("components/configuracion/panels/practitioners/services-editor.tsx", "utf8");
  const form = readFileSync("components/configuracion/panels/practitioners/own-service-form.tsx", "utf8");

  it("[CF3-AUU1-17] al guardar la fila se pasa el baseline (un precio sin cambios no viaja)", () => {
    expect(editor).toContain("draftToInput(current.draft, current.baseline)");
    expect(editor).toMatch(/disabled=\{!dirty \|\| saving \|\| priceInvalid\}/);
  });

  it("[CF3-AUU1-18] el alta propia no manda practitionerId; drawer con dirty-guard y borrar con useConfirm", () => {
    // CF3b (SV): el alta suma el checkbox «Para todo el consultorio», siempre explícito; el dueño lo sigue poniendo el server.
    expect(form).toContain("await createService({ ...parsed.payload, forClinic })");
    expect(form).not.toMatch(/createService\([^)]*practitionerId/);
    expect(form).toMatch(/<Drawer[\s\S]*?dirty=\{dirty && !pending\}/);
    expect(form).toContain("useConfirm");
    expect(form).not.toMatch(/window\.(confirm|alert)/);
  });

  it("[CF3-AUU1-19] mobile: controles de 44 px y 16 px de fuente (sin zoom de iOS)", () => {
    const css = editor.slice(editor.indexOf("const PSE_CSS = `"));
    expect(css).toMatch(/@media \(max-width: 767px\) \{[\s\S]*\.pse \.pse-input \{ min-height: 44px; font-size: 16px; \}/);
    expect(css).toMatch(/\.pse \.pse-price input \{ min-height: 44px; font-size: 16px !important; \}/);
    expect(css).toMatch(/\.pse \.pse-actions button, \.pse \.pse-new \{ min-height: 44px; \}/);
  });
});
