import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [DIR-3c] Configuración → Directorio y Profesionales → Especialidades (C-DIR9).
 *
 *  - La pestaña «Directorio» existe solo si el loader mandó sus datos (`DIRECTORY_MODE` ≠ off y `tenant.admin`); va
 *    en su propio chunk (`next/dynamic` + precarga, como las demás).
 *  - El panel: banda de moderación de Plataforma con el motivo, aviso del turnero apagado, switch, descripción con
 *    contador (≤ 800), estado de cada profesional SIN editar su perfil, link a la vista pública según modo.
 *  - Soporte: todo en solo lectura (switch deshabilitado, sin «Guardar», textarea readonly).
 *  - Especialidades: sub-pestaña solo con el directorio; soporte ve chips, no el combobox.
 * Componentes reales; se mockean solo las server actions (red), `next/navigation` y `next/dynamic`.
 */
const { dynamicLoads } = vi.hoisted(() => ({ dynamicLoads: [] as Promise<unknown>[] }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    let Loaded: React.ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(loader().then((C) => (Loaded = C)));
    return function DynamicMock(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("@/lib/directory-settings", () => ({
  setDirectoryListed: async () => ({ ok: true, data: { listed: true } }),
  setPublicDescription: async () => ({ ok: true, data: { description: null } }),
  setPractitionerSpecialties: async () => ({ ok: true, data: { specialtyIds: [] } }),
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/saas-billing", () => ({
  getBillingOverview: async () => ({ ok: false, error: "x" }),
  getReceiptUrl: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));

import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import {
  DirectoryPanel,
  descriptionLength,
  directoryChecks,
  practitionerDirectoryNote,
} from "@/components/configuracion/panels/directory-panel";
import { PractitionerPanel } from "@/components/configuracion/panels/practitioners/practitioner-panel";
import { SpecialtiesEditor, capSpecialties, sameSpecialtySet } from "@/components/configuracion/panels/practitioners/specialties-editor";
import { TabsBar } from "@/components/configuracion/controls";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import type { ConfiguracionDirectoryData } from "@/lib/configuracion-page-loader";
import type { PractitionerScheduleSummaryRow } from "@/lib/practitioner-schedule-schemas";

beforeAll(async () => {
  await Promise.all(dynamicLoads);
});

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true }));

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={KINE} vertical="KINESIOLOGY">
          <TweaksProvider>{node}</TweaksProvider>
        </TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

const DIR: ConfiguracionDirectoryData = {
  mode: "preview",
  slug: "kine-centro",
  listed: true,
  description: "Kinesiología deportiva.",
  hidden: null,
  turneroOn: true,
  practitioners: [
    { practitionerId: "p1", name: "Ana Pérez", inTurnero: true, status: "published" },
    { practitionerId: "p2", name: "Beto Gómez", inTurnero: true, status: "none" },
    { practitionerId: "p3", name: "Caro Díaz", inTurnero: false, status: "hidden" },
  ],
  specialtyCatalog: [
    { id: "s1", name: "Deportología" },
    { id: "s2", name: "Traumatología" },
  ],
  specialtiesByPractitioner: { p1: ["s1"] },
};

const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);

function page(directory: ConfiguracionDirectoryData | null, extra: { support?: boolean; initialTab?: string } = {}) {
  return wrap(
    <ConfiguracionClient
      role="OWNER"
      access={{ tenantAdmin: true, billing: false, team: true }}
      modules={KINE}
      tenant={null}
      insurers={[]}
      services={[]}
      team={[]}
      pending={[]}
      practitioners={[]}
      customConditions={[]}
      locations={[]}
      rooms={[]}
      scheduleSummary={[]}
      planUsage={null}
      supportSessions={null}
      directory={directory}
      support={extra.support}
      initialTab={extra.initialTab}
    />
  );
}

describe("[DIR-3c] pestaña Directorio", () => {
  it("existe solo con datos del directorio, después de Diagnósticos", () => {
    expect(tabs(page(null))).not.toContain("Directorio");
    const t = tabs(page(DIR));
    expect(t).toContain("Directorio");
    expect(t.indexOf("Directorio")).toBe(t.indexOf("Diagnósticos") + 1);
    // TabsBar con el default por rol (tests viejos, sin `access.directory`): no aparece.
    expect(tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} role="OWNER" modules={KINE} />))).not.toContain(
      "Directorio"
    );
  });

  it("va en su propio chunk (dynamic + loader de precarga), no estático", () => {
    const src = readFileSync("components/configuracion/configuracion-client.tsx", "utf8");
    expect(src).toContain('directorio: () => import("./panels/directory-panel")');
    expect(src).toMatch(/const DirectoryPanel = dynamic\(\(\) => import\("\.\/panels\/directory-panel"\)/);
    const statics = src.split("\n").filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l));
    expect(statics.join("\n")).not.toContain("directory-panel");
  });

  it("`?tab=directorio` la abre pintada: switch, descripción con contador, estados y link de vista previa", () => {
    const html = page(DIR, { initialTab: "directorio" });
    expect(html).toContain('aria-label="Mostrar el consultorio en el directorio"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Kinesiología deportiva.");
    expect(html).toContain("23 / 800");
    expect(html).toContain("Perfil publicado");
    expect(html).toContain("Sin perfil publicado");
    expect(html).toContain("Oculto por Plataforma");
    expect(html).toContain("No está en el turnero");
    expect(html).toContain("Hoy aparece en el directorio.");
    expect(html).toContain('href="/consultorios/kine-centro"');
    expect(html).toContain("Ver la vista previa");
    expect(html).toContain("Guardar descripción");
    // El perfil es personal: ningún control para editarlo desde el consultorio.
    expect(html).not.toMatch(/Editar perfil|Publicar perfil/);
    expect(html).not.toContain("@");
  });
});

describe("[DIR-3c] DirectoryPanel", () => {
  it("moderación de Plataforma: banda con el motivo y no aparece", () => {
    const html = wrap(
      <DirectoryPanel directory={{ ...DIR, hidden: { at: "2026-10-16T12:00:00.000Z", reason: "Teléfono que no corresponde" } }} />
    );
    expect(html).toContain("Plataforma ocultó el consultorio: Teléfono que no corresponde");
    expect(html).toContain("Hoy no aparece en el directorio.");
    expect(html).not.toContain("Ver la vista previa");
  });

  it("turnero apagado: «El directorio necesita el turnero prendido»", () => {
    const html = wrap(<DirectoryPanel directory={{ ...DIR, turneroOn: false }} />);
    expect(html).toContain("El directorio necesita el turnero prendido");
    expect(html).toContain("Hoy no aparece en el directorio.");
  });

  it("modo public: link a la página pública, sin aviso de vista previa", () => {
    const html = wrap(<DirectoryPanel directory={{ ...DIR, mode: "public" }} />);
    expect(html).toContain("Ver la página pública");
    expect(html).not.toContain("vista previa");
  });

  it("soporte: solo lectura (switch deshabilitado, textarea readonly, sin Guardar)", () => {
    const html = wrap(<DirectoryPanel directory={DIR} support />);
    expect(html).toContain("Soporte no puede cambiar la publicación en el directorio.");
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*disabled=""|<button[^>]*disabled=""[^>]*role="switch"/);
    expect(html).toMatch(/<textarea[^>]*readOnly=""|<textarea[^>]*readonly=""/i);
    expect(html).not.toContain("Guardar descripción");
  });

  it("lógica pura: condiciones, nota por profesional, largo en code points", () => {
    expect(directoryChecks(DIR).every((c) => c.ok)).toBe(true);
    const off = directoryChecks({ ...DIR, listed: false, practitioners: [{ ...DIR.practitioners[2] }] });
    expect(off.filter((c) => !c.ok).map((c) => c.key)).toEqual(["listed", "pros"]);
    expect(practitionerDirectoryNote({ status: "published", inTurnero: false })).toMatch(/No está en el turnero/);
    expect(practitionerDirectoryNote({ status: "hidden", inTurnero: true })).toMatch(/Plataforma ocultó/);
    expect(descriptionLength("  😀ab ")).toBe(3);
  });
});

describe("[DIR-3c] Profesionales → Especialidades", () => {
  const summary: PractitionerScheduleSummaryRow[] = [
    { practitionerId: "p1", name: "Ana Pérez", summary: "Lun 9–13", isFallback: false, rangeCount: 1, locationIds: [] },
  ];
  const specialties = { catalog: DIR.specialtyCatalog, byPractitioner: DIR.specialtiesByPractitioner };

  it("sin directorio no hay sub-pestaña; con directorio sí", () => {
    expect(tabs(wrap(<PractitionerPanel summary={summary} locations={[]} />))).not.toContain("Especialidades");
    expect(tabs(wrap(<PractitionerPanel summary={summary} locations={[]} specialties={specialties} />))).toContain(
      "Especialidades"
    );
  });

  it("el editor: combobox para el admin; soporte ve chips sin Guardar", () => {
    const admin = wrap(<SpecialtiesEditor practitionerId="p1" practitionerName="Ana Pérez" catalog={DIR.specialtyCatalog} initial={["s1"]} />);
    expect(admin).toContain("Deportología");
    expect(admin).toContain("1 de 5");
    expect(admin).toContain("Guardar especialidades");
    expect(admin).toContain('placeholder=""'); // con una elegida, el input queda sin placeholder (TagCombobox)
    const sup = wrap(
      <SpecialtiesEditor practitionerId="p1" practitionerName="Ana Pérez" catalog={DIR.specialtyCatalog} initial={["s1"]} readOnly />
    );
    expect(sup).toContain("Deportología");
    expect(sup).toContain("Soporte puede ver las especialidades, pero no cambiarlas.");
    expect(sup).not.toContain("Guardar especialidades");
    expect(sup).not.toContain("<input");
  });

  it("lógica pura del editor: tope de 5 sin duplicados; el orden no cuenta como cambio", () => {
    expect(capSpecialties(["a", "b", "a", "c", "d", "e", "f"])).toEqual(["a", "b", "c", "d", "e"]);
    expect(sameSpecialtySet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameSpecialtySet(["a"], ["a", "b"])).toBe(false);
  });
});
