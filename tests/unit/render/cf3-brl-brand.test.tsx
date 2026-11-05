import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF3-BRL] Logo del consultorio dentro de la app (pedido de Martin del 05-nov: un profesional con el mismo email en
 * varios consultorios tiene que ver de un vistazo en cuál está).
 *
 * Render sin jsdom de los componentes REALES (sidebar, selector y su lista, barra móvil, menú de cuenta,
 * `/elegir-consultorio`) con la marca que publica `TenantBrandProvider` y las opciones de `TenantChoiceProvider`. Se
 * mockea solo lo de afuera: router de Next, server actions (red), `next/dynamic` (corre el mismo loader) y, para la
 * página, la foto de acceso (cookie + base). La URL del logo la arma el helper puro real (`tenantLogoUrl`).
 *
 * Lo observable: el `<img>` con la URL del consultorio, tamaño fijo (sin salto de layout), `alt` vacío donde el nombre
 * ya está escrito y con el nombre donde no; sin logo, lo de hoy (iniciales / nombre / wordmark).
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
const dyn = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    let Loaded: React.ComponentType<Record<string, unknown>> | null = null;
    dyn.pending.push(loader().then((c) => (Loaded = c)));
    return function Dynamic(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  choice: { options: [] as unknown[], activeTenantId: null as string | null, needsChoice: true },
}));
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, getAccessSnapshot: vi.fn(async () => h.snapshot) };
});
vi.mock("@/lib/tenant-choice", () => ({
  getTenantChoiceState: vi.fn(async () => h.choice),
  safeChoiceNext: (raw: string | null) => raw ?? "/dashboard",
}));
vi.mock("@/app/elegir-consultorio/choose-action", () => ({ chooseTenantAction: async () => undefined }));

import { Sidebar } from "@/components/layout/sidebar";
import { MobileBar } from "@/components/layout/mobile-bar";
import { TopbarAccountMenu } from "@/components/layout/topbar-account-menu";
import { TenantChoiceProvider, TenantSwitcher } from "@/components/layout/tenant-switcher";
import { DEFAULT_TENANT_BRAND, TenantBrandProvider, useTenantBrand, type TenantBrand } from "@/components/layout/tenant-brand-context";
import { isTenantIdShape, tenantLogoUrl, tenantLogoVersion } from "@/lib/tenant-logo";
import ElegirConsultorioPage from "@/app/elegir-consultorio/page";
import { BRAND_NAME } from "@/lib/brand";
import type { TenantOption } from "@/lib/tenant-choice";

const AT = new Date("2026-11-05T12:00:00.000Z");
const URL_A = tenantLogoUrl("t-a", AT)!;
const URL_B = tenantLogoUrl("t-b", AT)!;
const A: TenantOption = { tenantId: "t-a", name: "Centro Kinésico Movare", slug: "movare", role: "OWNER", vertical: "KINESIOLOGY", logoUrl: URL_A };
const B: TenantOption = { tenantId: "t-b", name: "Consultorio Sur", slug: "sur", role: "PRACTITIONER", vertical: "GENERAL", logoUrl: null };
const fakeSwitch = async () => ({ ok: true as const, data: undefined });
const brandA: TenantBrand = { name: A.name, logoUrl: URL_A, palette: "sky" };
const noLogoA: TenantBrand = { name: A.name, logoUrl: null, palette: "sky" };

function shell(options: TenantOption[], brand: TenantBrand | null, node: React.ReactNode) {
  const inner = (
    <TenantChoiceProvider options={options} activeTenantId={options[0]?.tenantId ?? null} switchTenant={fakeSwitch}>
      {node}
    </TenantChoiceProvider>
  );
  return renderToStaticMarkup(brand ? <TenantBrandProvider value={brand}>{inner}</TenantBrandProvider> : inner);
}

/** Los `<img>` del logo del consultorio (marcados con `data-tenant-logo`). */
function logos(html: string): string[] {
  return html.match(/<img[^>]*data-tenant-logo[^>]*>/g) ?? [];
}
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
const unescape = (s: string | null) => s?.replace(/&amp;/g, "&") ?? null;

beforeAll(async () => {
  await Promise.all(dyn.pending);
});

describe("[CF3-BRL] helper puro de la URL", () => {
  it("URL relativa con t y v = logoUpdatedAt en ms; sin fecha (o inválida) → null", () => {
    expect(tenantLogoUrl("ck1abc", AT)).toBe(`/api/consultorio/logo?t=ck1abc&v=${AT.getTime()}`);
    expect(tenantLogoUrl("ck1abc", null)).toBeNull();
    expect(tenantLogoUrl("ck1abc", undefined)).toBeNull();
    expect(tenantLogoUrl("ck1abc", new Date("x"))).toBeNull();
    expect(tenantLogoVersion(AT)).toBe(String(AT.getTime()));
    expect(tenantLogoUrl("a&b", AT)).toBe(`/api/consultorio/logo?t=a%26b&v=${AT.getTime()}`);
  });

  it("forma del id: cuid/slug de 1..64 caracteres seguros; nada más", () => {
    expect(isTenantIdShape("cm3x9y0z00001abcd")).toBe(true);
    for (const bad of ["", "a b", "';--", "x".repeat(65), "../etc", "a/b"]) expect(isTenantIdShape(bad), bad).toBe(false);
  });
});

describe("[CF3-BRL] contrato TenantBrandProvider / useTenantBrand", () => {
  function Probe() {
    const b = useTenantBrand();
    return <i>{JSON.stringify(b)}</i>;
  }
  it("fuera del provider vale el default; dentro, el valor del layout", () => {
    expect(DEFAULT_TENANT_BRAND).toEqual({ name: "", logoUrl: null, palette: "sky" });
    expect(renderToStaticMarkup(<Probe />)).toContain(JSON.stringify(DEFAULT_TENANT_BRAND).replace(/"/g, "&quot;"));
    const html = renderToStaticMarkup(
      <TenantBrandProvider value={{ name: "Kine Sur", logoUrl: "/x", palette: "mint" }}>
        <Probe />
      </TenantBrandProvider>
    );
    expect(html).toContain("&quot;palette&quot;:&quot;mint&quot;");
    expect(html).toContain("&quot;name&quot;:&quot;Kine Sur&quot;");
  });
});

describe("[CF3-BRL] sidebar y selector", () => {
  it("un consultorio con logo: img de 28 px al lado del nombre, alt vacío (el nombre ya está escrito)", () => {
    const html = shell([A], brandA, <Sidebar caps={[]} />);
    const [img, ...rest] = logos(html);
    expect(rest).toEqual([]);
    expect(unescape(attr(img, "src"))).toBe(URL_A);
    expect(attr(img, "alt")).toBe("");
    expect(attr(img, "width")).toBe("28");
    expect(attr(img, "height")).toBe("28");
    expect(html).toContain("Centro Kinésico Movare");
  });

  it("sin logo (o sin provider de marca): lo de hoy, sin img", () => {
    expect(logos(shell([A], noLogoA, <Sidebar caps={[]} />))).toEqual([]);
    expect(logos(shell([A], null, <Sidebar caps={[]} />))).toEqual([]);
  });

  it("contraído con un solo consultorio: el logo con el nombre como alt (no hay nombre escrito)", () => {
    const [img] = logos(shell([A], brandA, <Sidebar caps={[]} collapsed />));
    expect(attr(img, "alt")).toBe(A.name);
    expect(attr(img, "width")).toBe("32");
  });

  it("2+ consultorios: el botón del selector lleva el logo del activo (alt vacío: el botón ya se llama con el nombre)", () => {
    const html = shell([A, B], brandA, <TenantSwitcher />);
    expect(html).toContain('aria-label="Consultorio activo: Centro Kinésico Movare. Cambiar de consultorio"');
    const [img] = logos(html);
    expect(unescape(attr(img, "src"))).toBe(URL_A);
    expect(attr(img, "alt")).toBe("");
  });

  it("2+ contraído: el logo reemplaza las iniciales dentro del botón", () => {
    const html = shell([A, B], brandA, <TenantSwitcher collapsed />);
    expect(logos(html)).toHaveLength(1);
    expect(html).not.toMatch(/<span aria-hidden="true">CK<\/span>/);
    // Sin logo, las iniciales de siempre.
    expect(shell([A, B], noLogoA, <TenantSwitcher collapsed />)).toMatch(/<span aria-hidden="true">CK<\/span>/);
  });

  it("lista abierta: cada consultorio con su logo; el que no tiene, con sus iniciales", () => {
    const html = shell([A, B], brandA, <TenantSwitcher defaultOpen />);
    const srcs = logos(html).map((t) => unescape(attr(t, "src")));
    // Botón (activo) + fila de A en la lista; B no tiene logo.
    expect(srcs).toEqual([URL_A, URL_A]);
    expect(html).toContain(">CS</span>");
    expect(srcs).not.toContain(URL_B);
  });
});

describe("[CF3-BRL] barra móvil y menú de cuenta", () => {
  it("barra móvil con logo: baldosa del producto + logo del consultorio con su nombre como alt", () => {
    const html = shell([A], brandA, <MobileBar userName="Ana" />);
    const [img] = logos(html);
    expect(attr(img, "alt")).toBe(A.name);
    expect(attr(img, "width")).toBe("28");
    // Con logo el wordmark se achica a la baldosa (a 320 px no entran los dos).
    expect(html).not.toContain(BRAND_NAME.split(" ").slice(1).join(" "));
  });

  it("barra móvil sin logo: el wordmark de hoy, sin img", () => {
    const html = shell([A], noLogoA, <MobileBar userName="Ana" />);
    expect(logos(html)).toEqual([]);
    expect(html).toContain(BRAND_NAME.split(" ").slice(1).join(" "));
  });

  it("menú de cuenta abierto: el consultorio activo (logo + nombre) debajo del usuario", () => {
    const html = shell([A, B], brandA, <TopbarAccountMenu name="Ana Pérez" defaultOpen />);
    expect(html).toContain("Centro Kinésico Movare");
    const [img] = logos(html);
    expect(attr(img, "alt")).toBe("");
    expect(html).toContain("Cambiar de consultorio");
    // Sin marca (render suelto) no aparece la fila.
    expect(shell([A, B], null, <TopbarAccountMenu name="Ana Pérez" defaultOpen />)).not.toContain("Centro Kinésico Movare");
  });
});

describe("[CF3-BRL] /elegir-consultorio", () => {
  it("cada consultorio con su logo (40 px, alt vacío: el nombre va al lado); sin logo, las iniciales", async () => {
    h.snapshot = { userId: "u1", profile: { fullName: "Ana Pérez", email: "ana@x.test" }, state: { kind: "needs_choice" } };
    h.choice = { options: [A, B], activeTenantId: null, needsChoice: true };
    const html = renderToStaticMarkup(await ElegirConsultorioPage({ searchParams: {} }));
    const imgs = logos(html);
    expect(imgs.map((t) => unescape(attr(t, "src")))).toEqual([URL_A]);
    expect(attr(imgs[0], "alt")).toBe("");
    expect(attr(imgs[0], "width")).toBe("40");
    expect(html).toContain('aria-label="Entrar a Consultorio Sur"');
    expect(html).toContain(">CS</span>");
  });
});
