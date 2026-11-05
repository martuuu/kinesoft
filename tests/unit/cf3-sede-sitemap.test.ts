import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [CF3-SDU] sitemap con las sedes digitales (D-CF3-10: prendida = indexable y en el sitemap). Función REAL de
 * `app/sitemap.ts`; mockeados solo los dos loaders que pegan a la base (canal service = la «red» de este test).
 *
 *   • las sedes van en todos los modos del directorio (es opt-in propio del consultorio, no del directorio);
 *   • URL absoluta y canónica `/<slug>` (la misma de `alternates.canonical`), sin query;
 *   • snapshot de sedes caído → el resto del sitemap igual (no tira el build ni da 500).
 */
const sites = vi.hoisted(() => ({ fn: vi.fn() }));
const dir = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/clinic-site-internal", () => ({ listEnabledSiteSlugs: sites.fn }));
vi.mock("@/lib/directory-internal", () => ({ getDirectorySnapshot: dir.fn }));

import sitemap from "@/app/sitemap";
import { env } from "@/lib/env";

const BASE = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
const prevMode = process.env.DIRECTORY_MODE;

beforeEach(() => {
  sites.fn.mockReset().mockResolvedValue(["kine-centro", "tmp"]);
  dir.fn.mockReset().mockResolvedValue({ version: 1, builtAt: "", professionals: [], clinics: [] });
});
afterEach(() => {
  if (prevMode === undefined) delete process.env.DIRECTORY_MODE;
  else process.env.DIRECTORY_MODE = prevMode;
  vi.restoreAllMocks();
});

describe("[CF3-SDU] sitemap de las sedes", () => {
  it.each([undefined, "off", "preview", "public"])("[CF3-SDU8] modo %s → cada sede prendida en /<slug>", async (mode) => {
    if (mode === undefined) delete process.env.DIRECTORY_MODE;
    else process.env.DIRECTORY_MODE = mode;
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual(expect.arrayContaining([`${BASE}/kine-centro`, `${BASE}/tmp`]));
    expect(urls.filter((u) => u === `${BASE}/tmp`)).toHaveLength(1);
    expect(urls.some((u) => u.includes("?"))).toBe(false);
    expect(sites.fn).toHaveBeenCalledTimes(1);
  });

  it("[CF3-SDU9] snapshot de sedes caído → el resto igual y se loguea", async () => {
    delete process.env.DIRECTORY_MODE;
    sites.fn.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual([`${BASE}/`, `${BASE}/login`, `${BASE}/terminos`, `${BASE}/privacidad`, `${BASE}/contacto`]);
    expect(spy).toHaveBeenCalled();
  });
});

describe("[CF3-SDU] sitemap: sede y ficha del directorio", () => {
  it("[CF3-SDU10] con sede prendida, la ficha /consultorios/<slug> no se lista (su canonical es /<slug>)", async () => {
    process.env.DIRECTORY_MODE = "public";
    dir.fn.mockResolvedValueOnce({
      version: 1,
      builtAt: "",
      professionals: [],
      clinics: [
        { slug: "tmp", path: "/consultorios/tmp" },
        { slug: "otro", path: "/consultorios/otro" },
      ],
    });
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain(`${BASE}/tmp`);
    expect(urls).not.toContain(`${BASE}/consultorios/tmp`);
    expect(urls).toContain(`${BASE}/consultorios/otro`);
  });
});
