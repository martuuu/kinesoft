import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [FC-3i] Configuración de T4 (brief §24.7 «Configuración (FC-3i)», hallazgo 13 de §24.2, FC-D22/D23, FC-UI-D3):
 *   - radio «¿Quién ve la historia clínica de cada paciente?» con el copy corregido (el Titular y los administradores
 *     NO ven todo: solo si atienden) y confirmación al ampliar a «Todos»;
 *   - «Mis fichas» visible a un profesional sin delegaciones (y a nadie que no atienda);
 *   - logo (General, `tenant.sensitive`) y firma propia: PNG/JPEG dentro del tope;
 *   - diagnósticos propios: renombrar/archivar solo con `canManage` (FC-D22, lo calcula el server).
 *
 * Componentes REALES (`ConfiguracionClient` y sus paneles) y la lógica pura real; se mockean `next/dynamic` (resuelto en
 * `beforeAll`), el router y las server actions (red). El repo no tiene DOM en los tests de render: lo que decide un
 * click (confirmar o no) vive en `fichas-settings-logic.ts` y se prueba ahí.
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
// Hasta que no aparezcan cargas nuevas: General pide el logo por su propio `dynamic` al cargar su módulo.
beforeAll(async () => {
  let n = -1;
  while (n !== dynamicLoads.length) {
    n = dynamicLoads.length;
    await Promise.all(dynamicLoads);
  }
});
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
vi.mock("@/lib/tenant-settings", () => ({
  setSharedPatientView: async () => ({ ok: true, data: undefined }),
  updateTenantBasics: async () => ({ ok: true, data: undefined }),
  setBusinessHours: async () => ({ ok: true, data: undefined }),
  setPublicBookingEnabled: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/practice-assets", () => ({
  uploadTenantLogo: async () => ({ ok: true, data: { updatedAt: "2026-10-19T12:00:00.000Z" } }),
  removeTenantLogo: async () => ({ ok: true, data: undefined }),
  uploadOwnSignature: async () => ({ ok: true, data: { updatedAt: "2026-10-19T12:00:00.000Z" } }),
  removeOwnSignature: async () => ({ ok: true, data: undefined }),
  updateOwnSignatureInfo: async () => ({ ok: true, data: undefined }),
  getPracticeAssetPreviewUrl: async () => ({ ok: true, data: { url: null } }),
}));
vi.mock("@/lib/diagnoses", () => ({
  listTenantDiagnoses: async () => [],
  updateTenantDiagnosis: async () => ({ ok: false, error: "x" }),
  archiveTenantDiagnosis: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/support-session-tenant", () => ({ endSupportAccessForTenant: async () => ({ ok: true, data: undefined }) }));

import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import { visibleConfigTabs, initialConfigTab } from "@/components/configuracion/controls";
import {
  HC_VISIBILITY_COPY,
  hcVisibilityChange,
  hcVisibilityOf,
} from "@/components/configuracion/panels/fichas-settings-logic";
import {
  applyDiagnosisChange,
  normalizeLicenseInput,
  precheckPracticeAssetFile,
  splitTenantDiagnoses,
} from "@/components/configuracion/panels/mis-fichas-logic";
import { FICHAS_SETTINGS_COPY } from "@/components/configuracion/panels/fichas-settings-copy";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { checkPracticeAsset, PRACTICE_ASSET_COPY, PRACTICE_ASSET_LIMITS } from "@/lib/file-sniff";
import { modulesFor } from "@/lib/tenant-modules";
import type { Role } from "@prisma/client";
import type { TenantDiagnosisRow } from "@/lib/diagnoses-types";
import type { TenantSettings } from "@/lib/tenant-settings";
import { DiagnosisRowItem, type FichasPanelMe } from "@/components/configuracion/panels/fichas-panel";

const KINE = Array.from(
  modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] })
);
const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const TENANT = {
  id: "t1",
  name: "Centro Movare",
  slug: "movare",
  legalName: null,
  taxId: null,
  sharedPatientView: false,
  businessHoursStart: 8,
  businessHoursEnd: 20,
  agendaSlotMinutes: 60,
  publicBookingEnabled: true,
  vertical: "KINESIOLOGY",
  saasPlan: "CONSULTORIO",
  updatedAt: "2026-10-14T12:00:00.000Z",
} as unknown as TenantSettings;

const ME: FichasPanelMe = {
  honorific: "LIC",
  licenseNumber: "MN 1234",
  signature: { has: false, updatedAt: null },
};
const FICHAS = { me: ME, backupScope: { tenantId: "t1", userId: "u1" } };

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

function page(opts: {
  role: Role;
  tenantAdmin: boolean;
  sensitive: boolean;
  initialTab?: string;
  fichas?: typeof FICHAS | null;
  logo?: { has: boolean; updatedAt: string | null } | null;
  tenant?: TenantSettings;
  support?: boolean;
}) {
  return wrap(
    <ConfiguracionClient
      role={opts.role}
      support={opts.support}
      access={{ tenantAdmin: opts.tenantAdmin, billing: false, team: false, sensitive: opts.sensitive }}
      modules={KINE}
      tenant={opts.tenantAdmin ? opts.tenant ?? TENANT : null}
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
      supportSessions={[]}
      initialTab={opts.initialTab}
      fichas={opts.fichas}
      logo={opts.logo}
    />
  );
}

describe("[FC-3i] radio «¿Quién ve la historia clínica de cada paciente?»", () => {
  it("[FC-3i] radio con el copy nuevo: el Titular y los administradores la ven solo si atienden", () => {
    const html = page({ role: "OWNER", tenantAdmin: true, sensitive: true, initialTab: "general" });
    const t = text(html);
    expect(t).toContain(HC_VISIBILITY_COPY.visibilityQuestion);
    expect(t).toContain(HC_VISIBILITY_COPY.visibilityOwn);
    expect(t).toContain(HC_VISIBILITY_COPY.visibilityAll);
    expect(t).toContain(HC_VISIBILITY_COPY.visibilityRoles);
    // Hallazgo 13: el copy falso no vuelve (desde PL-1b el rol solo no abre la HC).
    expect(t).not.toMatch(/Titular y los administradores ven todo/);
    expect(t).not.toContain("con cualquiera de los dos modos");
    // Radio (no switch), con «Cada profesional» marcado cuando `sharedPatientView` es false.
    expect(html).toMatch(/<input type="radio" name="hc-visibility"[^>]*checked=""[^>]*value="own"/);
    expect(html).not.toMatch(/<input type="radio" name="hc-visibility"[^>]*checked=""[^>]*value="all"/);
    expect(html).toContain('role="radiogroup"');
  });

  it("[FC-3i] con «Todos» marcado se ve el aviso; el soporte lo ve deshabilitado", () => {
    const html = page({
      role: "OWNER",
      tenantAdmin: true,
      sensitive: true,
      initialTab: "general",
      tenant: { ...TENANT, sharedPatientView: true },
    });
    expect(html).toMatch(/<input type="radio" name="hc-visibility"[^>]*checked=""[^>]*value="all"/);
    expect(text(html)).toContain(HC_VISIBILITY_COPY.visibilityAllWarning);
    const sup = page({ role: "ADMIN", tenantAdmin: true, sensitive: true, initialTab: "general", support: true });
    expect(sup).toMatch(/<fieldset[^>]*data-hc-visibility[^>]*disabled=""/);
    expect(text(sup)).toContain(HC_VISIBILITY_COPY.supportNote);
  });

  it("[FC-3i] confirmación al ampliar a «Todos»; volver a «Cada profesional» se aplica directo", () => {
    expect(hcVisibilityOf(false)).toBe("own");
    expect(hcVisibilityOf(true)).toBe("all");
    expect(hcVisibilityChange("own", "all")).toBe("confirm");
    expect(hcVisibilityChange("all", "own")).toBe("apply");
    expect(hcVisibilityChange("own", "own")).toBe("noop");
    expect(hcVisibilityChange("all", "all")).toBe("noop");
  });

  it("[FC-3i] sin `tenant.sensitive` (Secretaria con «Configuración») no hay radio ni logo", () => {
    const html = page({ role: "ASSISTANT", tenantAdmin: true, sensitive: false, initialTab: "general", logo: { has: true, updatedAt: null } });
    expect(text(html)).not.toContain(HC_VISIBILITY_COPY.visibilityQuestion);
    expect(html).not.toContain('data-practice-asset="logo"');
  });
});

describe("[FC-3i] «Mis fichas»", () => {
  it("[FC-3i] «Mis fichas» visible a un profesional sin delegaciones (y es su pestaña inicial)", () => {
    const html = page({ role: "PRACTITIONER", tenantAdmin: false, sensitive: false, fichas: FICHAS });
    expect(tabs(html)).toEqual(["Mis fichas", "Soporte"]);
    const t = text(html);
    expect(t).toContain(FICHAS_SETTINGS_COPY.honorific);
    expect(t).toContain(FICHAS_SETTINGS_COPY.license);
    expect(t).toContain(FICHAS_SETTINGS_COPY.signature);
    expect(t).toContain(FICHAS_SETTINGS_COPY.ownDiagnoses);
    expect(t).toContain(PRACTICE_ASSET_COPY.signatureFormat);
    // Lo guardado precarga el form: honorífico y matrícula.
    expect(html).toMatch(/<option value="LIC"[^>]*selected="">Lic\.<\/option>/);
    expect(html).toContain('value="MN 1234"');
    expect(html).toContain('data-practice-asset="signature"');
    // La firma de otro no se carga desde acá: no hay selector de profesional.
    expect(html).not.toContain('name="practitionerId"');
  });

  it("[FC-3i] sin miembro clínico (Secretaria, Facturación, soporte) no hay «Mis fichas»", () => {
    expect(tabs(page({ role: "ASSISTANT", tenantAdmin: true, sensitive: false, fichas: null }))).not.toContain("Mis fichas");
    expect(tabs(page({ role: "BILLING", tenantAdmin: false, sensitive: false }))).toEqual(["Soporte"]);
    // `?tab=mis-fichas` sin la pestaña cae en la primera visible.
    const visible = visibleConfigTabs({ tenantAdmin: true, billing: false, team: false, canExport: false }, KINE);
    expect(initialConfigTab("mis-fichas", visible)).toBe("general");
    expect(initialConfigTab("mis-fichas", [...visible, "mis-fichas"])).toBe("mis-fichas");
  });

  it("[FC-3i] Titular que atiende: General y Mis fichas; el logo va en General", () => {
    const html = page({ role: "OWNER", tenantAdmin: true, sensitive: true, initialTab: "general", fichas: FICHAS, logo: { has: false, updatedAt: null } });
    expect(tabs(html)).toEqual(expect.arrayContaining(["General", "Mis fichas", "Soporte"]));
    expect(html).toContain('data-practice-asset="logo"');
    expect(text(html)).toContain(FICHAS_SETTINGS_COPY.logo);
    expect(text(html)).toContain(PRACTICE_ASSET_COPY.logoFormat);
    expect(text(html)).toContain(FICHAS_SETTINGS_COPY.noImage);
  });
});

/** PNG mínimo: firma + IHDR con ancho/alto (lo que mira `readImageInfo`). */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
/** JPEG mínimo: SOI + SOF0 con alto/ancho. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

describe("[FC-3i] logo y firma PNG/JPEG", () => {
  it("[FC-3i] logo y firma PNG/JPEG: el chequeo previo frena tipo y tamaño antes de leer el archivo", () => {
    expect(precheckPracticeAssetFile("logo", { size: 200_000, type: "image/png" })).toBeNull();
    expect(precheckPracticeAssetFile("logo", { size: 200_000, type: "image/jpeg" })).toBeNull();
    expect(precheckPracticeAssetFile("logo", { size: PRACTICE_ASSET_LIMITS.logo.maxBytes + 1, type: "image/png" })).toBe(
      PRACTICE_ASSET_COPY.logoFormat
    );
    expect(precheckPracticeAssetFile("signature", { size: PRACTICE_ASSET_LIMITS.signature.maxBytes + 1, type: "image/png" })).toBe(
      PRACTICE_ASSET_COPY.signatureFormat
    );
    // 600 KB: entra como logo, no como firma (≤512 KB).
    expect(precheckPracticeAssetFile("logo", { size: 600_000, type: "image/png" })).toBeNull();
    expect(precheckPracticeAssetFile("signature", { size: 600_000, type: "image/png" })).toBe(PRACTICE_ASSET_COPY.signatureFormat);
    for (const type of ["image/svg+xml", "image/webp", "image/gif", "image/heic", "application/pdf"]) {
      expect(precheckPracticeAssetFile("logo", { size: 1000, type })).toBe(PRACTICE_ASSET_COPY.logoFormat);
    }
    expect(precheckPracticeAssetFile("signature", { size: 0, type: "image/png" })).toBe(PRACTICE_ASSET_COPY.signatureFormat);
    // Tipo vacío: decide el chequeo de bytes.
    expect(precheckPracticeAssetFile("logo", { size: 1000, type: "" })).toBeNull();
  });

  it("[FC-3i] logo y firma PNG/JPEG: el chequeo de bytes del cliente es el de la action (magic bytes y px)", () => {
    expect(checkPracticeAsset("logo", png(600, 200), "image/png")).toMatchObject({ ok: true, mime: "image/png" });
    expect(checkPracticeAsset("signature", jpeg(800, 300), "image/jpeg")).toMatchObject({ ok: true, mime: "image/jpeg" });
    // Un PNG que dice ser JPEG: «no es lo que dice ser».
    expect(checkPracticeAsset("logo", png(10, 10), "image/jpeg")).toEqual({ ok: false, error: PRACTICE_ASSET_COPY.fake });
    // Un SVG renombrado a .png.
    expect(checkPracticeAsset("logo", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png")).toEqual({
      ok: false,
      error: PRACTICE_ASSET_COPY.fake,
    });
    // Dimensiones: firma ≤2000 px.
    expect(checkPracticeAsset("signature", png(2001, 100), "image/png")).toEqual({
      ok: false,
      error: PRACTICE_ASSET_COPY.tooBig(PRACTICE_ASSET_LIMITS.signature.maxPx),
    });
  });

  it("[FC-3i] matrícula: se recorta y vacía es null", () => {
    expect(normalizeLicenseInput("  MN   1234 ")).toBe("MN 1234");
    expect(normalizeLicenseInput("   ")).toBeNull();
  });
});

describe("[FC-3i] diagnósticos propios (FC-D22)", () => {
  const row = (id: string, title: string, extra: Partial<TenantDiagnosisRow> = {}): TenantDiagnosisRow => ({
    id,
    title,
    code: null,
    archived: false,
    createdByMe: false,
    canManage: false,
    updatedAt: "2026-10-19T12:00:00.000Z",
    ...extra,
  });

  it("[FC-3i] vivos y archivados por separado; renombrar reordena A-Z y archivar lo pasa al final", () => {
    const rows = [row("a", "Cervicalgia"), row("b", "Lumbalgia mecánica"), row("c", "Hombro congelado", { archived: true })];
    expect(splitTenantDiagnoses(rows).live.map((r) => r.id)).toEqual(["a", "b"]);
    expect(splitTenantDiagnoses(rows).archived.map((r) => r.id)).toEqual(["c"]);
    const renamed = applyDiagnosisChange(rows, { kind: "renamed", row: row("b", "Acromialgia") });
    expect(renamed.map((r) => r.title)).toEqual(["Acromialgia", "Cervicalgia", "Hombro congelado"]);
    const archived = applyDiagnosisChange(rows, { kind: "archived", id: "a" });
    expect(archived.map((r) => [r.id, r.archived])).toEqual([
      ["b", false],
      ["a", true],
      ["c", true],
    ]);
  });

  it("[FC-3i] renombrar y archivar solo con `canManage` (quien lo creó o `tenant.sensitive`); archivados y modo lectura sin botones", () => {
    const buttons = (r: TenantDiagnosisRow, readOnly = false) =>
      text(renderToStaticMarkup(<DiagnosisRowItem row={r} busy={false} readOnly={readOnly} />));
    const mine = buttons(row("a", "Cervicalgia", { canManage: true, createdByMe: true, code: "X1" }));
    expect(mine).toContain(FICHAS_SETTINGS_COPY.rename);
    expect(mine).toContain(FICHAS_SETTINGS_COPY.archive);
    expect(mine).toContain(FICHAS_SETTINGS_COPY.createdByMe);
    expect(mine).toContain("X1");
    const other = buttons(row("b", "Lumbalgia"));
    expect(other).not.toContain(FICHAS_SETTINGS_COPY.rename);
    expect(other).not.toContain(FICHAS_SETTINGS_COPY.archive);
    expect(buttons(row("c", "Hombro", { canManage: true, archived: true }))).not.toContain(FICHAS_SETTINGS_COPY.rename);
    expect(buttons(row("d", "Rodilla", { canManage: true }), true)).not.toContain(FICHAS_SETTINGS_COPY.archive);
  });
});
