import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF3-SV8..11] CF3b · sesión SV (decisión de Martin del 05-nov): el checkbox «Para todo el consultorio» del alta, en
 * «Mi agenda» (`ForClinicCheckbox`, desmarcado por defecto) y en Configuración › Servicios (`ServiceOwnerFields`,
 * marcado por defecto, solo para quien atiende). Render real con `renderToStaticMarkup` (el Drawer no pinta antes de
 * hidratar: se prueban los campos que monta). Se mockean solo las server actions (red) y next/*.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("@/lib/services", () => ({
  createService: async () => ({ ok: true, data: { id: "new" } }),
  updateService: async () => ({ ok: true, data: undefined }),
  deleteService: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/practitioner-services", () => ({
  listPractitionerServices: async () => ({ ok: true, data: [] }),
  upsertPractitionerService: async () => ({ ok: true, data: undefined }),
}));

import { ForClinicCheckbox } from "@/components/configuracion/panels/practitioners/own-service-form";
import { ServiceOwnerFields } from "@/components/configuracion/panels/services-panel";
import { SERVICES_COPY } from "@/lib/services-types";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const noop = () => {};
const checkbox = (h: string) => h.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
const PRACS = [
  { id: "p-owner", name: "Laura Pérez" },
  { id: "p2", name: "Juan Gómez" },
];

describe("[CF3-SV] «Para todo el consultorio» en «Mi agenda»", () => {
  it("[CF3-SV8] desmarcado: «Queda como tuyo»; marcado: el aviso de privado en el turnero de los colegas", () => {
    const off = renderToStaticMarkup(<ForClinicCheckbox checked={false} onChange={noop} />);
    expect(text(off)).toContain(SERVICES_COPY.forClinicLabel);
    expect(text(off)).toContain(SERVICES_COPY.forClinicSelfOff);
    expect(checkbox(off)).not.toContain("checked");
    expect(checkbox(off)).toContain('aria-describedby="osf-scope-hint"');

    const on = renderToStaticMarkup(<ForClinicCheckbox checked onChange={noop} />);
    expect(text(on)).toContain(SERVICES_COPY.forClinicSelfOn);
    expect(checkbox(on)).toContain('checked=""');
    expect(checkbox(on)).not.toContain("disabled");
  });

  it("[CF3-SV9] con el tope de propios lleno: marcado y fijo, con el motivo", () => {
    const h = renderToStaticMarkup(<ForClinicCheckbox checked={false} locked onChange={noop} />);
    expect(checkbox(h)).toContain('checked=""');
    expect(checkbox(h)).toContain('disabled=""');
    expect(text(h)).toContain(SERVICES_COPY.ownLimit);
    expect(SERVICES_COPY.ownLimit).toContain("para todo el consultorio");
  });
});

describe("[CF3-SV] «Para todo el consultorio» en Configuración › Servicios", () => {
  it("[CF3-SV10] quien atiende: marcado sin selector; desmarcado, el selector sin «Todos» con él elegido", () => {
    const on = renderToStaticMarkup(
      <ServiceOwnerFields practitioners={PRACS} ownPractitionerId="p-owner" forClinic onForClinicChange={noop} />
    );
    expect(checkbox(on)).toContain('checked=""');
    expect(text(on)).toContain(SERVICES_COPY.forClinicConfigOn);
    // Marcado, el profesional no viaja: el select no está en el form.
    expect(on).not.toContain('name="practitionerId"');

    const off = renderToStaticMarkup(
      <ServiceOwnerFields practitioners={PRACS} ownPractitionerId="p-owner" forClinic={false} onForClinicChange={noop} />
    );
    expect(text(off)).toContain(SERVICES_COPY.forClinicConfigOff);
    expect(off).toContain('name="practitionerId"');
    expect(off).not.toContain("Todos los profesionales");
    expect(off).toMatch(/<option value="p-owner"[^>]*selected=""[^>]*>Laura Pérez \(vos\)<\/option>/);
    expect(off).toMatch(/<option value="p2"[^>]*>Juan Gómez<\/option>/);
  });

  it("[CF3-SV11] sin agenda propia (o en la edición): sin checkbox, el selector de siempre con «Todos los profesionales»", () => {
    const h = renderToStaticMarkup(
      <ServiceOwnerFields practitioners={PRACS} ownPractitionerId={null} defaultPractitionerId="p2" forClinic onForClinicChange={noop} />
    );
    expect(checkbox(h)).toBe("");
    expect(h).toContain("Todos los profesionales");
    expect(h).toMatch(/<option value="p2"[^>]*selected=""/);
  });
});

describe("[CF3-SV] fuente: contratos del alta que no se ven en el render", () => {
  const panel = readFileSync("components/configuracion/panels/services-panel.tsx", "utf8");
  const editor = readFileSync("components/configuracion/panels/practitioners/services-editor.tsx", "utf8");

  it("[CF3-SV12] Servicios: el checkbox solo viaja en el alta de quien atiende; la edición manda lo de siempre", () => {
    expect(panel).toContain("const scopeChoice = !service && !!ownPractitionerId;");
    expect(panel).toContain("await createService(scopeChoice ? { ...payload, forClinic } : payload)");
    expect(panel).toContain("await updateService(service.id, payload)");
    // Default marcado en esta pestaña (el alta de antes nacía en «Todos los profesionales»).
    expect(panel).toContain("const [forClinic, setForClinic] = useState(true);");
    // Auditoría de paso: el Drawer de Servicios suma el dirty-guard (AGENTS §5).
    expect(panel).toMatch(/<Drawer[^>]*dirty=\{dirty && !pending\}/);
    expect(panel).toContain("onInput={onFormInput} onChange={onFormInput}");
  });

  it("[CF3-SV13] «Mi agenda»: el botón no se apaga con el tope; el alta abre con el checkbox fijo", () => {
    expect(editor).not.toContain("disabled={!own.canCreate}");
    expect(editor).toContain("ownLimitReached={!ownDrawer.row && !own.canCreate}");
  });
});
