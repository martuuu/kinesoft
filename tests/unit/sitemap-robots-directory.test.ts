import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorySnapshot } from "@/lib/directory-types";

/**
 * [DIR-3b] sitemap.xml y robots.txt en los 3 modos del directorio (C-DIR2). Se llaman las funciones REALES de
 * `app/sitemap.ts` / `app/robots.ts`; lo único mockeado es el loader del snapshot (`getDirectorySnapshot`, que en prod
 * pega a la base por el canal service = la "red" de este test). El modo se cambia en caliente por `process.env`, como
 * lo lee `directoryMode()`.
 *
 * Invariantes:
 *   • off / preview → el sitemap es EXACTAMENTE el de antes de DIR (landing + login) y NO se lee el snapshot.
 *   • public → `/profesionales` + cada perfil + cada consultorio del snapshot, con URL absoluta y path canónico.
 *   • robots: `/cuenta` bloqueado siempre; `/profesionales` y `/consultorios/` permitidos explícitos solo en public.
 */
const snapshotMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/directory-internal", () => ({ getDirectorySnapshot: snapshotMock.fn }));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { env } from "@/lib/env";

const BASE = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
const FIXED = [`${BASE}/`, `${BASE}/login`];

const SNAP: DirectorySnapshot = {
  version: 1,
  builtAt: "2026-10-16T12:00:00.000Z",
  professionals: [
    {
      profileId: "cmprofile0001ana",
      path: "/profesionales/ana-perez-cmprofile0001ana",
      publicName: "Ana Pérez",
      honorificLabel: "Lic.",
      initials: "AP",
      license: null,
      bio: null,
      specialties: [],
      coverages: [],
      acceptsParticular: true,
      clinics: [
        {
          slug: "kine-centro",
          name: "Kine Centro",
          path: "/consultorios/kine-centro",
          city: "Rosario",
          provinceCode: "S",
          bookingHref: "/c/kine-centro/booking?pro=prac1",
        },
      ],
    },
  ],
  clinics: [
    {
      slug: "kine-centro",
      path: "/consultorios/kine-centro",
      name: "Kine Centro",
      description: null,
      locations: [],
      phone: null,
      whatsapp: null,
      specialties: [],
      coverages: [],
      acceptsParticular: true,
      professionals: [],
      bookingHref: "/c/kine-centro/booking",
    },
    {
      // DIR-D25: consultorio sin publicados, su página existe → va al sitemap.
      slug: "solo-turnero",
      path: "/consultorios/solo-turnero",
      name: "Solo Turnero",
      description: null,
      locations: [],
      phone: null,
      whatsapp: null,
      specialties: [],
      coverages: [],
      acceptsParticular: false,
      professionals: [],
      bookingHref: "/c/solo-turnero/booking",
    },
  ],
};

const prevMode = process.env.DIRECTORY_MODE;

beforeEach(() => {
  snapshotMock.fn.mockReset();
  snapshotMock.fn.mockResolvedValue(SNAP);
});
afterEach(() => {
  if (prevMode === undefined) delete process.env.DIRECTORY_MODE;
  else process.env.DIRECTORY_MODE = prevMode;
  vi.restoreAllMocks();
});

function setMode(mode: string | undefined) {
  if (mode === undefined) delete process.env.DIRECTORY_MODE;
  else process.env.DIRECTORY_MODE = mode;
}

function robotsRule() {
  const r = robots();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
  const star = rules.find((x) => x.userAgent === "*")!;
  return {
    r,
    allow: ([] as string[]).concat(star.allow ?? []),
    disallow: ([] as string[]).concat(star.disallow ?? []),
  };
}

describe("[DIR-3b] sitemap según DIRECTORY_MODE", () => {
  it.each([undefined, "off", "preview", "PREVIEW ", "cualquiera"])(
    "modo %s → solo landing y login, sin leer el snapshot",
    async (mode) => {
      setMode(mode);
      const urls = (await sitemap()).map((e) => e.url);
      expect(urls).toEqual(FIXED);
      expect(snapshotMock.fn).not.toHaveBeenCalled();
    }
  );

  it("public → /profesionales, cada perfil y cada consultorio del snapshot, absolutos y canónicos", async () => {
    setMode("public");
    const entries = await sitemap();
    expect(entries.map((e) => e.url)).toEqual([
      ...FIXED,
      `${BASE}/profesionales`,
      `${BASE}/profesionales/ana-perez-cmprofile0001ana`,
      `${BASE}/consultorios/kine-centro`,
      `${BASE}/consultorios/solo-turnero`,
    ]);
    expect(snapshotMock.fn).toHaveBeenCalledTimes(1);
    // Nada del turnero ni deep links con practitionerId: el sitemap no publica `/c/<slug>` por fuera del opt-in.
    for (const e of entries) {
      expect(e.url).not.toContain("/c/");
      expect(e.url).not.toContain("?pro=");
    }
  });

  it("public con el snapshot caído → sirve lo fijo y loguea (no tira el build)", async () => {
    setMode("public");
    snapshotMock.fn.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual(FIXED);
    expect(spy).toHaveBeenCalled();
  });

  it("public con snapshot vacío → solo lo fijo + /profesionales", async () => {
    setMode("public");
    snapshotMock.fn.mockResolvedValueOnce({ ...SNAP, professionals: [], clinics: [] });
    expect((await sitemap()).map((e) => e.url)).toEqual([...FIXED, `${BASE}/profesionales`]);
  });
});

describe("[DIR-3b] robots según DIRECTORY_MODE", () => {
  it.each([undefined, "off", "preview", "public"])("modo %s → /cuenta bloqueado, landing y turnero permitidos", (mode) => {
    setMode(mode);
    const { r, allow, disallow } = robotsRule();
    expect(disallow).toContain("/cuenta");
    expect(allow).toEqual(expect.arrayContaining(["/", "/c/"]));
    expect(r.sitemap).toBe(`${BASE}/sitemap.xml`);
    // El directorio nunca queda bloqueado: en preview el noindex va por metadata (un Disallow lo ocultaría).
    for (const p of ["/profesionales", "/consultorios/", "/"]) expect(disallow).not.toContain(p);
  });

  it.each([undefined, "off", "preview"])("modo %s → sin allow explícito del directorio", (mode) => {
    setMode(mode);
    const { allow } = robotsRule();
    expect(allow).toEqual(["/", "/c/"]);
  });

  it("public → allow explícito de /profesionales y /consultorios/", () => {
    setMode("public");
    const { allow } = robotsRule();
    expect(allow).toEqual(["/", "/c/", "/profesionales", "/consultorios/"]);
  });
});
