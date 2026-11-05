import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [BR-P] Paleta de marca «TMP» (pedido de Martin del 05-nov): colores del logo de TMP (marino #1A436C, turquesa
 * #53A0AA), opcional para los miembros de ese consultorio, y la sede/turnero de TMP con sus colores.
 *
 * Se lee el CSS real que sirve Next (sin DOM en la capa unit, como design-tokens.test.ts) y se montan los componentes
 * reales con `renderToStaticMarkup`. Se mockean solo la red (server actions), el router, el toast y el confirm.
 * La marca del consultorio entra por el `TenantBrandProvider` REAL de BR-L (el que monta el AppShell).
 */
const prefs = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/lib/preferences", () => ({
  updateUserPreferences: async (patch: unknown) => {
    prefs.calls.push(patch);
    return { ok: true, data: patch };
  },
  updateAgendaViewPrefs: async () => ({ ok: true }),
}));
vi.mock("@/lib/clinic-site-settings", () => ({
  getSiteSettings: vi.fn(async () => ({ ok: false, error: "x" })),
  updateSiteSettings: vi.fn(async () => ({ ok: false, error: "no se debería llamar" })),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/platform-tenants", () => ({ updatePlatformTenant: vi.fn(), setPlatformTenantSite: vi.fn() }));
vi.mock("@/lib/platform-tenant-lifecycle", () => ({
  suspendPlatformTenant: vi.fn(),
  closePlatformTenant: vi.fn(),
  reactivatePlatformTenant: vi.fn(),
  changePlatformTenantSlug: vi.fn(),
  forcePlatformTenantOnboardingComplete: vi.fn(),
}));
vi.mock("@/lib/platform-export-request", () => ({ requestTenantExport: vi.fn() }));
vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  listPublicSlotWindow: vi.fn(async () => ({ days: [], nextFrom: null, reachedEnd: true, skippedFrom: null })),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { TweaksProvider, hydrateTweaks, useTweaks, type TweaksState } from "@/components/layout/tweaks-context";
import { TweaksPanel } from "@/components/layout/tweaks-panel";
import { TenantBrandProvider } from "@/components/layout/tenant-brand-context";
import { BRAND_PALETTE_OPTIONS, PALETTE_OPTIONS, paletteOptionsFor } from "@/components/layout/appearance-options";
import { SettingsModal } from "@/components/global/settings-modal";
import {
  SiteForm,
  SITE_PANEL_COPY,
  brandPaletteLeaveDialog,
  confirmBrandPaletteLeave,
  saveSiteForm,
  formFromSettings,
} from "@/components/configuracion/panels/site-panel";
import { TenantLifecyclePanel, PLATFORM_PALETTE_OPTIONS } from "@/components/plataforma/tenants/tenant-lifecycle";
import { PublicBookingWizard } from "@/components/booking/public-booking-wizard";
import {
  ALL_PALETTES,
  BRAND_PALETTES,
  GENERAL_PALETTES,
  effectivePalette,
  isAppPalette,
  isBrandPalette,
  paletteAllowedForTenant,
  paletteAttr,
  paletteLabel,
  palettesForTenant,
} from "@/lib/brand-palettes";
import { SITE_PALETTES, clinicSiteSchema } from "@/lib/clinic-site-types";
import { SiteSettingsInput, SITE_SETTINGS_COPY, type SiteSettings } from "@/lib/clinic-site-settings-schemas";
import { SetPlatformTenantSite } from "@/lib/platform-tenants-schemas";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import type { PublicClinic } from "@/lib/public-booking-types";

const CSS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

// ── contraste WCAG 2.x (misma cuenta que design-tokens.test.ts) ──────────
type RGB = [number, number, number];
const hex = (v: string): RGB => {
  const m = v.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`color no literal: ${v}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as RGB;
};
const lum = ([r, g, b]: RGB) => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const WHITE: RGB = [255, 255, 255];
const NAVY_900: RGB = hex("#0f1e33");

function paletteBlock(key: string): string {
  const m = CSS.match(new RegExp(`\\[data-palette="${key}"\\]\\s*\\{([^}]*)\\}`));
  expect(m, `falta [data-palette="${key}"] en globals.css`).not.toBeNull();
  return m![1];
}
function tok(block: string, name: string): RGB {
  const m = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  expect(m, `${name} en el bloque`).not.toBeNull();
  return hex(m![1]);
}
/** Distancia euclídea en RGB (0..441): «cerca de» un color medido del logo. */
const dist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

beforeEach(() => {
  prefs.calls = [];
});

describe("[BR-P-1] [data-palette=\"tmp\"] en globals.css: escala del logo y AA", () => {
  const b = paletteBlock("tmp");

  it("reasigna la escala sky completa, lime-300/400 y los fondos (y nada de lo que las paletas no tocan)", () => {
    for (const n of [50, 100, 200, 300, 400, 500, 600, 700, 800]) expect(b).toMatch(new RegExp(`--sky-${n}:\\s*#`));
    for (const t of ["--lime-300", "--lime-400", "--bg-app", "--bg-panel"]) expect(b).toMatch(new RegExp(`${t}:`));
    expect(b).not.toMatch(/--disc-|--st-|--rc-|--lime-700|--navy-|--danger-|--warn-|--success-|--now-line|--bg-public|--focus-ring/);
  });

  it("los colores del logo: --sky-800 ≈ #1A436C (marino) y --sky-500 ≈ #53A0AA (turquesa)", () => {
    expect(dist(tok(b, "--sky-800"), hex("#1A436C"))).toBeLessThan(12);
    expect(dist(tok(b, "--sky-500"), hex("#53A0AA"))).toBeLessThan(12);
  });

  it("la escala va de claro a oscuro (50 → 800)", () => {
    const l = [50, 100, 200, 300, 400, 500, 600, 700, 800].map((n) => lum(tok(b, `--sky-${n}`)));
    for (let i = 1; i < l.length; i++) expect(l[i]).toBeLessThan(l[i - 1]);
  });

  it("AA: --sky-700 (links, botón primario con texto blanco, foco) y --sky-600 sobre blanco y sobre su --bg-panel", () => {
    const panel = tok(b, "--bg-panel");
    for (const t of ["--sky-700", "--sky-600"]) {
      expect(contrast(tok(b, t), WHITE), `${t} / blanco`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tok(b, t), panel), `${t} / panel`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(WHITE, tok(b, "--sky-700"))).toBeGreaterThanOrEqual(4.5);
    // Chips: texto 700/800 sobre los tintes 50/100.
    for (const fg of ["--sky-700", "--sky-800"]) {
      for (const bg of ["--sky-50", "--sky-100"]) {
        expect(contrast(tok(b, fg), tok(b, bg)), `${fg} / ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("componentes no textuales (WCAG 1.4.11): --sky-500 (bordes y anillos del turnero) ≥ 3 sobre blanco", () => {
    expect(contrast(tok(b, "--sky-500"), WHITE)).toBeGreaterThanOrEqual(3);
  });

  it("el «lime» (aqua) lleva texto --navy-900 con AA (botón lime, resaltados)", () => {
    for (const t of ["--lime-300", "--lime-400"]) expect(contrast(NAVY_900, tok(b, t))).toBeGreaterThanOrEqual(4.5);
  });

  it("cada paleta que no es sky tiene su bloque (generales y de marca)", () => {
    for (const p of ALL_PALETTES.filter((x) => x !== "sky")) paletteBlock(p);
  });
});

describe("[BR-P-2] lib/brand-palettes.ts (puro)", () => {
  it("ALL_PALETTES = generales + de marca, y la sede pinta todas (SITE_PALETTES)", () => {
    expect([...ALL_PALETTES]).toEqual([...GENERAL_PALETTES, ...BRAND_PALETTES.map((p) => p.key)]);
    expect([...SITE_PALETTES]).toEqual([...ALL_PALETTES]);
    expect(BRAND_PALETTES).toEqual([{ key: "tmp", label: "TMP" }]);
  });

  it("la de marca solo se ofrece al consultorio que la tiene", () => {
    expect(palettesForTenant("tmp")).toEqual(["sky", "mint", "coral", "violet", "tmp"]);
    for (const t of ["sky", "mint", null, undefined, "neon"]) expect(palettesForTenant(t)).toEqual([...GENERAL_PALETTES]);
    expect(paletteAllowedForTenant("tmp", "tmp")).toBe(true);
    expect(paletteAllowedForTenant("tmp", "mint")).toBe(false);
    expect(paletteAllowedForTenant("coral", "tmp")).toBe(true);
    expect(paletteAllowedForTenant("neon", "tmp")).toBe(false);
  });

  it("effectivePalette: la de marca de OTRO consultorio (o basura) se pinta sky; no cambia el default de nadie", () => {
    expect(effectivePalette("tmp", "tmp")).toBe("tmp");
    expect(effectivePalette("tmp", "sky")).toBe("sky");
    expect(effectivePalette("violet", "tmp")).toBe("violet");
    expect(effectivePalette("neon", "tmp")).toBe("sky");
    expect(effectivePalette(undefined, "tmp")).toBe("sky");
    expect(DEFAULT_PREFERENCES.palette).toBe("sky");
  });

  it("paletteAttr: atributo para superficies públicas (sky y desconocidas sin atributo)", () => {
    expect(paletteAttr("tmp")).toBe("tmp");
    expect(paletteAttr("mint")).toBe("mint");
    expect(paletteAttr("sky")).toBeUndefined();
    expect(paletteAttr("neon")).toBeUndefined();
    expect(paletteAttr(null)).toBeUndefined();
  });

  it("isAppPalette / isBrandPalette / paletteLabel", () => {
    expect(isAppPalette("tmp")).toBe(true);
    expect(isAppPalette("TMP")).toBe(false);
    expect(isBrandPalette("tmp")).toBe(true);
    expect(isBrandPalette("mint")).toBe(false);
    expect(paletteLabel("tmp")).toBe("TMP");
    expect(paletteLabel("mint")).toBe("Verde");
    expect(paletteLabel("neon")).toBe("neon");
  });
});

describe("[BR-P-3] valor inválido rechazado por los zod de los escritores", () => {
  const form = { siteEnabled: false, siteTagline: null, publicDescription: null, phone: null, whatsapp: null, publicEmail: null };

  it("«Sitio web»: palette fuera de la lista → error en el campo; ausente = no tocar", () => {
    const bad = SiteSettingsInput.safeParse({ ...form, palette: "neon" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.flatten().fieldErrors.palette).toEqual([SITE_SETTINGS_COPY.palette]);
    expect(SiteSettingsInput.safeParse({ ...form, palette: "tmp" }).success).toBe(true);
    const absent = SiteSettingsInput.safeParse(form);
    expect(absent.success && absent.data.palette).toBeUndefined();
  });

  it("Plataforma: cualquiera de la lista (incluida la de marca), nada fuera de ella, y al menos un campo", () => {
    const base = { tenantId: "t1", expectedUpdatedAt: "2026-11-05T12:00:00.000Z" };
    expect(SetPlatformTenantSite.safeParse({ ...base, palette: "tmp" }).success).toBe(true);
    expect(SetPlatformTenantSite.safeParse({ ...base, siteEnabled: true }).success).toBe(true);
    expect(SetPlatformTenantSite.safeParse({ ...base, palette: "neon" }).success).toBe(false);
    expect(SetPlatformTenantSite.safeParse(base).success).toBe(false);
    expect(SetPlatformTenantSite.safeParse({ ...base, palette: "tmp", siteTagline: "x" }).success).toBe(false);
  });

  it("el DTO de la sede acepta tmp (la sede de TMP se pinta con su paleta)", () => {
    expect(clinicSiteSchema.shape.palette.safeParse("tmp").success).toBe(true);
    expect(clinicSiteSchema.shape.palette.safeParse("neon").success).toBe(false);
  });
});

// ── Apariencia ───────────────────────────────────────────────────────────

function ForceOpen({ children }: { children: React.ReactNode }) {
  const { t } = useTweaks();
  // Mutación local SOLO para el render estático (sin effects en SSR), como pl-f1c-tweaks.test.tsx.
  (t as { minimised: boolean }).minimised = false;
  return <>{children}</>;
}
const brand = (palette: string) => ({ name: "Consultorio", logoUrl: null, palette });
const panel = (tenantPalette: string | null, opts: { initialPalette?: "tmp" | "sky" } = {}) =>
  renderToStaticMarkup(
    <TweaksProvider initialPalette={opts.initialPalette ?? null} tenantPalette={tenantPalette}>
      <TenantBrandProvider value={brand(tenantPalette ?? "sky")}>
        <ForceOpen>
          <TweaksPanel />
        </ForceOpen>
      </TenantBrandProvider>
    </TweaksProvider>
  );

describe("[BR-P-4] Apariencia: «TMP» solo para los miembros del consultorio con esa paleta", () => {
  it("opciones: las 4 generales siempre; TMP solo si Tenant.palette = tmp", () => {
    expect(paletteOptionsFor("sky")).toBe(PALETTE_OPTIONS);
    expect(paletteOptionsFor("mint").map((o) => o.value)).toEqual(["sky", "mint", "coral", "violet"]);
    expect(paletteOptionsFor("tmp").map((o) => o.value)).toEqual(["sky", "mint", "coral", "violet", "tmp"]);
    expect(BRAND_PALETTE_OPTIONS.tmp.swatch).toEqual(["#1A436C", "#53A0AA", "#E2F0F2"]);
  });

  it("panel real: con la marca TMP aparece «Paleta TMP» (con su swatch); en otro consultorio, no", () => {
    const tmp = panel("tmp");
    expect(tmp).toContain('aria-label="Paleta TMP"');
    expect(tmp).toContain("background:#1A436C");
    for (const t of ["sky", "mint", null]) {
      const html = panel(t);
      expect(html).toContain('aria-label="Paleta Celeste"');
      expect(html).not.toContain('aria-label="Paleta TMP"');
      expect(html).not.toContain("#1A436C");
    }
  });

  it("fuera del provider de marca (render suelto) no aparece: default sky de BR-L", () => {
    const html = renderToStaticMarkup(
      <TweaksProvider>
        <ForceOpen>
          <TweaksPanel />
        </ForceOpen>
      </TweaksProvider>
    );
    expect(html).not.toContain("Paleta TMP");
  });

  it("«Ajustes» del menú de perfil: misma regla", () => {
    const render = (p: string) =>
      renderToStaticMarkup(
        <TweaksProvider tenantPalette={p}>
          <TenantBrandProvider value={brand(p)}>
            <SettingsModal preferences={DEFAULT_PREFERENCES} onClose={() => {}} />
          </TenantBrandProvider>
        </TweaksProvider>
      );
    expect(render("tmp")).toContain(">TMP<");
    expect(render("coral")).not.toContain(">TMP<");
  });
});

describe("[BR-P-5] TweaksProvider: la paleta de marca se pinta solo en su consultorio", () => {
  function probe(initialPalette: "tmp" | "mint" | null, tenantPalette?: string | null) {
    const out: { t?: TweaksState; set?: ReturnType<typeof useTweaks>["set"] } = {};
    function Probe() {
      const ctx = useTweaks();
      out.t = ctx.t;
      out.set = ctx.set;
      return null;
    }
    renderToStaticMarkup(
      <TweaksProvider initialPalette={initialPalette} tenantPalette={tenantPalette}>
        <Probe />
      </TweaksProvider>
    );
    return out;
  }

  it("server «tmp»: en TMP se pinta tmp; en otro consultorio (o sin dato del consultorio), sky", () => {
    expect(probe("tmp", "tmp").t?.palette).toBe("tmp");
    expect(probe("tmp", "mint").t?.palette).toBe("sky");
    expect(probe("tmp").t?.palette).toBe("sky");
    expect(probe("mint", "tmp").t?.palette).toBe("mint");
  });

  it("hydrateTweaks: la de marca del server o del navegador solo pasa si este consultorio la ofrece", () => {
    const stored = JSON.stringify({ palette: "tmp" });
    expect(hydrateTweaks(stored, null, palettesForTenant("tmp")).palette).toBe("tmp");
    expect(hydrateTweaks(stored, null).palette).toBe("sky");
    expect(hydrateTweaks(null, "tmp", palettesForTenant("tmp")).palette).toBe("tmp");
    // Server con la de marca de otro consultorio: NO cae a lo del navegador (que podría ser la misma de marca).
    expect(hydrateTweaks(stored, "tmp", palettesForTenant("sky")).palette).toBe("sky");
    expect(hydrateTweaks(JSON.stringify({ palette: "coral" }), null).palette).toBe("coral");
  });

  it("set('palette', 'tmp') en un consultorio sin la marca: no se aplica ni se guarda; en TMP sí", () => {
    const other = probe(null, "sky");
    other.set?.("palette", "tmp");
    expect(prefs.calls).toEqual([]);
    const own = probe(null, "tmp");
    own.set?.("palette", "tmp");
    expect(prefs.calls).toEqual([{ palette: "tmp" }]);
  });
});

// ── Configuración → «Sitio web» ─────────────────────────────────────────

const settings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  slug: "tmp",
  sitePath: "/tmp",
  siteEnabled: true,
  siteEnabledAt: null,
  siteTagline: null,
  publicDescription: null,
  phone: null,
  whatsapp: null,
  publicEmail: null,
  hasLogo: true,
  slugReserved: false,
  updatedAt: "2026-11-05T12:00:00.000Z",
  palette: "sky",
  paletteOptions: ["sky", "mint", "coral", "violet"],
  ...over,
});
const siteHtml = (s: SiteSettings) => renderToStaticMarkup(<SiteForm settings={s} onReload={() => {}} />);

describe("[BR-P-6] «Sitio web»: colores del sitio y del turnero", () => {
  it("las 4 generales con su nombre; la de marca solo si es la asignada", () => {
    const plain = siteHtml(settings());
    expect(plain).toContain(SITE_PANEL_COPY.paletteLegend);
    for (const l of ["Celeste", "Verde", "Coral", "Violeta"]) expect(plain).toContain(`<span>${l}</span>`);
    expect(plain).not.toContain('data-palette-option="tmp"');
    expect(plain).toMatch(/aria-pressed="true"[^>]*data-palette-option="sky"/);

    const tmp = siteHtml(settings({ palette: "tmp", paletteOptions: ["sky", "mint", "coral", "violet", "tmp"] }));
    expect(tmp).toMatch(/aria-pressed="true"[^>]*data-palette-option="tmp"/);
    expect(tmp).toContain("<span>TMP</span>");
  });

  it("sin `palette` del server (lectura vieja) el campo no se muestra ni viaja", async () => {
    const html = siteHtml(settings({ palette: undefined, paletteOptions: undefined }));
    expect(html).not.toContain(SITE_PANEL_COPY.paletteLegend);
    const update = vi.fn(async (_input: unknown, _v: string) => ({
      ok: true as const,
      data: { updatedAt: "2026-11-05T12:01:00.000Z", changed: [] as string[] },
    }));
    await saveSiteForm(formFromSettings(settings()), true, "2026-11-05T12:00:00.000Z", update);
    expect(update.mock.calls[0][0]).not.toHaveProperty("palette");
  });

  it("guardar manda la paleta elegida y la devuelve como base; una inválida no viaja", async () => {
    const update = vi.fn(async (_input: unknown, _v: string) => ({
      ok: true as const,
      data: { updatedAt: "2026-11-05T12:01:00.000Z", changed: ["palette"] },
    }));
    const o = await saveSiteForm(formFromSettings(settings()), true, "2026-11-05T12:00:00.000Z", update, "mint");
    expect(update.mock.calls[0][0]).toMatchObject({ palette: "mint" });
    expect(o).toMatchObject({ ok: true, palette: "mint" });

    const none = vi.fn();
    const bad = await saveSiteForm(formFromSettings(settings()), true, "x", none, "neon" as never);
    expect(none).not.toHaveBeenCalled();
    expect(bad).toMatchObject({ ok: false, fieldErrors: { palette: SITE_SETTINGS_COPY.palette } });
  });

  // CF3 ZF5 (B, default de Martin pendiente): dejar la paleta de marca la borra para siempre (el server ya no la ofrece
  // y solo Plataforma la vuelve a asignar). La nota al lado del campo se puede no leer: «Guardar» pregunta antes.
  it("[CF3-ZF5-3] dejar la paleta de marca pide confirmación antes de guardar; cancelar no guarda", async () => {
    expect(brandPaletteLeaveDialog("tmp", "mint")).toEqual({
      title: "¿Dejar los colores de tu marca?",
      message: "Si cambiás a Verde, la paleta TMP solo la puede volver a asignar el equipo de Consultorio Online.",
      confirmLabel: "Cambiar a Verde",
      cancelLabel: "Seguir con TMP",
      tone: "danger",
    });
    // Sin cambio, entre generales, o volviendo a la de marca: no pregunta.
    for (const [saved, next] of [["tmp", "tmp"], ["sky", "mint"], ["mint", "tmp"], [undefined, "sky"], ["tmp", undefined]] as const) {
      expect(brandPaletteLeaveDialog(saved, next), `${saved}→${next}`).toBeNull();
    }
    const no = vi.fn(async () => false);
    expect(await confirmBrandPaletteLeave(no, "tmp", "coral")).toBe(false);
    expect(no).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Si cambiás a Coral, la paleta TMP") }));
    const yes = vi.fn(async () => true);
    expect(await confirmBrandPaletteLeave(yes, "tmp", "coral")).toBe(true);
    const untouched = vi.fn(async () => false);
    expect(await confirmBrandPaletteLeave(untouched, "sky", "coral")).toBe(true);
    expect(untouched).not.toHaveBeenCalled();
    // Sin jsdom no se hace clic: se fija sobre el fuente que «Guardar» pregunta ANTES de mandar (y el switch, que manda
    // la paleta guardada, no pregunta).
    const src = readFileSync(join(process.cwd(), "components/configuracion/panels/site-panel.tsx"), "utf8");
    const save = src.slice(src.indexOf("const save = async"), src.indexOf("const toggle = async"));
    expect(save).toMatch(/if \(!\(await confirmBrandPaletteLeave\(confirm, basePalette, palette\)\)\) return;[\s\S]*saveSiteForm\(/);
    expect(src.slice(src.indexOf("const toggle = async"), src.indexOf("const discard = async"))).not.toContain("confirmBrandPaletteLeave");
  });
});

// ── Plataforma ──────────────────────────────────────────────────────────

describe("[BR-P-7] Plataforma → Ciclo de vida: colores (cualquiera, incluida la de marca)", () => {
  const detail = (over: Partial<PlatformTenantDetail> = {}) =>
    ({
      id: "t1",
      name: "TMP",
      slug: "tmp",
      status: "ACTIVE",
      statusReason: null,
      statusChangedAt: null,
      slugAliases: [],
      onboardingCompleted: true,
      siteEnabled: true,
      palette: "sky",
      updatedAt: "2026-11-05T12:00:00.000Z",
      ...over,
    }) as unknown as PlatformTenantDetail;

  it("el select ofrece todas, con la de marca marcada como tal", () => {
    expect(PLATFORM_PALETTE_OPTIONS.map((o) => o.value)).toEqual([...ALL_PALETTES]);
    const html = renderToStaticMarkup(<TenantLifecyclePanel detail={detail()} />);
    expect(html).toContain("Colores del sitio y del turnero");
    expect(html).toContain(">TMP (de marca)<");
    expect(html).toContain(">Guardar colores<");
    expect(renderToStaticMarkup(<TenantLifecyclePanel detail={detail({ palette: "tmp" })} />)).toContain("Guardados: TMP.");
  });

  it("un valor guardado desconocido se muestra crudo (no se esconde)", () => {
    expect(renderToStaticMarkup(<TenantLifecyclePanel detail={detail({ palette: "neon" })} />)).toContain("(neon)");
  });
});

// ── Turnero ─────────────────────────────────────────────────────────────

describe("[BR-P-8] el turnero pinta la paleta del consultorio", () => {
  const clinic = (palette: string): PublicClinic => ({
    slug: "tmp",
    name: "TMP",
    legalName: null,
    palette,
    practitioners: [{ id: "A", name: "Lic. A", specialty: null, licenseNumber: null, yearsExp: null, locationIds: ["L1"], acceptedInsurerIds: ["P"] }],
    services: [{ id: "S", name: "Sesión", description: null, durationMin: 45, priceCents: 1500000, practitionerId: null, practitionerIds: ["A"] }],
    locations: [{ id: "L1", name: "Centro", address: null, addressLine2: null, city: null, province: null, isPrimary: true }],
    insurers: [{ id: "P", name: "Particular", isParticular: true }],
  });

  it("tmp → data-palette=\"tmp\" en la raíz; sky o basura → sin atributo (antes no se usaba nunca)", () => {
    expect(renderToStaticMarkup(<PublicBookingWizard clinic={clinic("tmp")} session={null} prefill={null} />)).toMatch(
      /^<div class="k-app [^"]*" data-palette="tmp">/
    );
    for (const p of ["sky", "neon"]) {
      expect(renderToStaticMarkup(<PublicBookingWizard clinic={clinic(p)} session={null} prefill={null} />)).not.toContain(
        "data-palette"
      );
    }
  });
});

describe("[BR-P-9] layout (app): la paleta del consultorio llega a TweaksProvider y al script sin flash", () => {
  // El layout es server (Prisma, cookies): no se monta en la capa unit. Se afirma el cableado en el archivo real; la
  // regla (`palettesForTenant` / `effectivePalette`) la prueban [BR-P-2] y [BR-P-5] con los símbolos reales.
  const src = readFileSync(join(process.cwd(), "app/(app)/layout.tsx"), "utf8");
  it("TweaksProvider recibe tenantPalette={brand.palette} y el script usa la lista de ESTE consultorio", () => {
    expect(src).toContain("tenantPalette={brand.palette}");
    expect(src).toContain("paletteScript(prefs.palette, brand.palette)");
    expect(src).toMatch(/const allowed = palettesForTenant\(tenantPalette\);/);
    expect(src).toMatch(/effectivePalette\(serverPalette, tenantPalette\)/);
    expect(src).not.toMatch(/\["sky", "mint", "coral", "violet"\]/);
  });
});
