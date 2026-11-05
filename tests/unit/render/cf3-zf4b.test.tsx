import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * [CF3-ZF4b] Cierre de CF3b, fixer ZF4b (hallazgos B de BR-P, PH-U2, PH-U1 y CT-I en wip-20/cf3-handoffs.md):
 *   1. El turnero toma la paleta del consultorio también en los tintes: los `rgba(31, 79, 190, …)` fijos (el celeste de
 *      «sky») dejaban azulados los avisos, la tarjeta del turno encontrado y la sombra del horario elegido sobre la
 *      página turquesa de TMP. Ahora cada uno es `color-mix(var(--sky-700) N%)` con el rgba de respaldo delante.
 *   2. Iniciales de PERSONA unificadas en `lib/person-initials.ts`: el `Avatar` del shell decía «LA» para «Lic. Ana
 *      Pérez» y la foto del profesional «AP»; había 4 copias de la regla (foto, sede, directorio, Avatar). Las del
 *      CONSULTORIO (selector y /elegir-consultorio) eran otra copia doble.
 *   3. «Ajustes» del menú de perfil arranca con la paleta EFECTIVA (`t.palette` del TweaksProvider), no con
 *      `preferences.palette`: con «TMP» guardada en un consultorio que no la tiene no quedaba ninguna marcada.
 *   4. «Configuración → Plan y uso» solo a quien ve esa pestaña (`account.billing`); al resto, «Pedile al titular que
 *      amplíe el plan».
 *
 * Render real con `renderToStaticMarkup` (sin jsdom); se mockean solo las server actions (red) y `next/navigation`. El
 * CSS se lee como texto (la capa unit no tiene layout): el contrato es el archivo que sirve Next.
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
vi.mock("@/lib/preferences", () => ({
  updateUserPreferences: async () => ({ ok: true, data: undefined }),
  updateAgendaViewPrefs: async () => ({ ok: true }),
}));
vi.mock("@/lib/tenant-settings", () => ({
  setSharedPatientView: async () => ({ ok: true, data: undefined }),
  updateTenantBasics: async () => ({ ok: true, data: undefined }),
  setBusinessHours: async () => ({ ok: true, data: undefined }),
  setPublicBookingEnabled: async () => ({ ok: true, data: undefined }),
  setTenantBookingCap: async () => ({ ok: true, data: undefined }),
  setTenantAgendaRules: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/rooms", () => ({
  createRoom: async () => ({ ok: true, data: { id: "x" } }),
  updateRoom: async () => ({ ok: true, data: undefined }),
  archiveRoom: async () => ({ ok: true, data: undefined }),
  restoreRoom: async () => ({ ok: true, data: undefined }),
}));

import { personInitials, tenantInitials } from "@/lib/person-initials";
import { Avatar } from "@/components/ui/avatar";
import { PractitionerPhoto } from "@/components/ui/practitioner-photo";
import { personInitials as siteInitials } from "@/lib/clinic-site-logic";
import { initials as directoryInitials } from "@/lib/directory-logic";
import { tenantInitials as switcherInitials } from "@/components/layout/tenant-switcher";
import { SettingsModal } from "@/components/global/settings-modal";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { TenantBrandProvider } from "@/components/layout/tenant-brand-context";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { RoomsSection, ROOMS_COPY } from "@/components/configuracion/panels/rooms-section";
import { GeneralPanel } from "@/components/configuracion/panels/general-panel";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { DEFAULT_PREFERENCES, type Palette } from "@/lib/preferences-constants";
import { MODULE_DENIED_COPY, moduleDeniedCopy, modulesFor, NO_MODULE_OVERRIDES } from "@/lib/tenant-modules";
import type { TenantSettings } from "@/lib/tenant-settings";
import type { RoomRow } from "@/lib/rooms-types";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const ASK_OWNER = "Pedile al titular que amplíe el plan.";

// ── 1. Turnero: tintes con la paleta del consultorio ───────────────────────────────────────────────────────────────
describe("[CF3-ZF4b] turnero: los tintes salen de --sky-700 (paleta del consultorio)", () => {
  const css = noComments(read("components/booking/public-booking.module.css"));
  const lines = css.split("\n").map((l) => l.trim());

  it("[CF3-ZF4b1] cada rgba(31, 79, 190, a) es solo el respaldo: la línea siguiente es color-mix(var(--sky-700) a%)", () => {
    const sinColorMix: string[] = [];
    let fallbacks = 0;
    lines.forEach((l, i) => {
      const m = l.match(/^([a-z-]+):\s*(.*)rgba\(31,\s*79,\s*190,\s*([\d.]+)\)(.*);$/);
      if (!m) return;
      fallbacks++;
      const [, prop, pre, alpha, post] = m;
      // Mismo peso visual: color-mix de --sky-700 con transparente al a·100 % = el mismo rgba en «sky» (#1f4fbe).
      const want = `${prop}: ${pre}color-mix(in srgb, var(--sky-700) ${Math.round(Number(alpha) * 100)}%, transparent)${post};`;
      if (lines[i + 1] !== want) sinColorMix.push(`${l}  →  falta «${want}»`);
    });
    expect(sinColorMix).toEqual([]);
    // Los 9 del hallazgo (avisos, contacto, turno encontrado, ingreso, sombra del horario, cobro) + el de PH-U2.
    expect(fallbacks).toBe(10);
    // Ningún rgba celeste suelto en otra forma (sin espacios, en un gradiente…).
    expect(css.replace(/\s+/g, "").match(/rgba\(31,79,190/g)).toHaveLength(10);
  });

  it("[CF3-ZF4b1] sin hex de ninguna paleta en el módulo (todo color de marca es var(--sky-*))", () => {
    expect(css).not.toMatch(/#1f4fbe|#1a436c|#53a0aa|#1f5a80/i);
  });
});

// ── 2. Iniciales ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("[CF3-ZF4b] personInitials (lib/person-initials.ts)", () => {
  it("[CF3-ZF4b2] nombre y apellido, sin honoríficos («Lic.», «Dr./Dra.», «Klgo./Klga.», «Kgo./Kga.», «Prof.»)", () => {
    const cases: Array<[string, string]> = [
      ["Lic. Ana Pérez", "AP"],
      ["Lic. Ana María Pérez", "AP"],
      ["Dr. Juan Gómez", "JG"],
      ["Dra. Lucía", "L"],
      ["Kgo. Pablo Ruiz", "PR"],
      ["Kga. Sol Díaz", "SD"],
      ["Klgo. Martín Navarro", "MN"],
      ["Klga. Inés", "I"],
      ["Prof. Laura Sosa", "LS"],
      ["lic ana pérez", "AP"],
      ["DRA. LUCÍA FERNÁNDEZ", "LF"],
      ["Dra.Lucía Fernández", "LF"],
      ["Lic. Dra. Ana Pérez", "AP"],
      ["María José Pérez García", "MG"],
      ["Ñandú Ávila", "ÑÁ"],
      ["Álvaro Pérez", "ÁP"],
      ["  Ana   Pérez  ", "AP"],
      // Un nombre que EMPIEZA como un título no se recorta.
      ["Licia Drago", "LD"],
      ["Pedro Prado", "PP"],
      ["Ana (Kine) Pérez", "AP"],
      ["", ""],
      ["   ", ""],
      ["Lic.", ""],
    ];
    for (const [name, want] of cases) expect(personInitials(name), name).toBe(want);
  });

  it("[CF3-ZF4b2] es puro: sin imports (lo bajan el turnero, la sede y el shell)", () => {
    expect(read("lib/person-initials.ts")).not.toMatch(/^\s*import\s/m);
  });

  it("[CF3-ZF4b2] TODOS usan la misma regla: Avatar del shell, foto del profesional, sede y directorio", () => {
    const names = ["Lic. Ana Pérez", "Dra. Lucía", "Klgo. Martín Navarro", "Kga. Sol Díaz", "José Luis Martínez"];
    for (const n of names) {
      const want = personInitials(n);
      expect(want, n).not.toBe("");
      // Avatar (barra superior, menú de perfil, listas de pacientes): antes «LA» para «Lic. Ana Pérez».
      expect(renderToStaticMarkup(<Avatar name={n} />), `Avatar ${n}`).toMatch(new RegExp(`>${want}</span>$`));
      // Foto del profesional sin foto → iniciales en el marco.
      expect(text(renderToStaticMarkup(<PractitionerPhoto src={null} name={n} />)).trim(), `Photo ${n}`).toBe(want);
      expect(siteInitials(n), `sede ${n}`).toBe(want);
      expect(directoryInitials(n), `directorio ${n}`).toBe(want);
    }
    // El directorio conserva su «?» de vacío (el avatar del listado nunca queda en blanco).
    expect(directoryInitials("   ")).toBe("?");
    expect(siteInitials).toBe(personInitials);
  });

  it("[CF3-ZF4b2] sin copias locales de la regla en los archivos que la duplicaban", () => {
    for (const f of [
      "components/ui/avatar.tsx",
      "components/ui/practitioner-photo.tsx",
      "lib/clinic-site-logic.ts",
      "lib/directory-logic.ts",
      "components/layout/tenant-switcher.tsx",
      "app/elegir-consultorio/page.tsx",
    ]) {
      const src = read(f);
      expect(src, f).toContain('from "@/lib/person-initials"');
      // La forma de las copias: partir en palabras y quedarse con letras (`.split(…).map/.slice/.filter`). Un
      // `.split(/\s+/)[0]` (el saludo de /elegir-consultorio) no es una copia.
      expect(noComments(src), f).not.toMatch(/\.split\((?:\/\\s\+\/|" ")\)\s*\.(?:slice|map|filter)/);
    }
  });
});

describe("[CF3-ZF4b] tenantInitials (consultorio: selector y /elegir-consultorio)", () => {
  it("[CF3-ZF4b3] primeras letras de las dos primeras palabras, sin honoríficos ni signos; «?» si no queda nada", () => {
    const cases: Array<[string, string]> = [
      ["Centro Kinésico Movare", "CK"],
      ["Consultorio Norte", "CN"],
      ["kine", "K"],
      ["Lic. Ana Pérez", "AP"],
      ["Ñandú · Salud Integral", "ÑS"],
      ["", "?"],
      ["  —  ", "?"],
    ];
    for (const [name, want] of cases) expect(tenantInitials(name), name).toBe(want);
    expect(switcherInitials).toBe(tenantInitials);
  });
});

// ── 3. «Ajustes»: paleta efectiva ──────────────────────────────────────────────────────────────────────────────────
describe("[CF3-ZF4b] «Ajustes» arranca con la paleta efectiva (t.palette), no con preferences.palette", () => {
  // Solo los botones de paleta (los de KPIs fijados también llevan aria-pressed).
  const PALETTE_LABELS = new Set(["Celeste", "Verde", "Coral", "Violeta", "TMP"]);
  const pressed = (html: string) =>
    [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => text(m[1]).trim())
      .filter((l) => PALETTE_LABELS.has(l));
  const render = (initialPalette: Palette, tenantPalette: string, prefPalette: Palette) =>
    renderToStaticMarkup(
      <TweaksProvider initialPalette={initialPalette} tenantPalette={tenantPalette}>
        <TenantBrandProvider value={{ name: "Consultorio", logoUrl: null, palette: tenantPalette }}>
          <SettingsModal preferences={{ ...DEFAULT_PREFERENCES, palette: prefPalette }} onClose={() => {}} />
        </TenantBrandProvider>
      </TweaksProvider>
    );

  it("[CF3-ZF4b4] «TMP» guardada en un consultorio sin esa paleta: marcada «Celeste» (la que se ve), no ninguna", () => {
    expect(pressed(render("tmp", "sky", "tmp"))).toEqual(["Celeste"]);
  });

  it("[CF3-ZF4b4] preferences viejas (cambió en Apariencia sin recargar): marcada la que se ve", () => {
    expect(pressed(render("mint", "sky", "sky"))).toEqual(["Verde"]);
  });

  it("[CF3-ZF4b4] en TMP con TMP: «TMP»", () => {
    expect(pressed(render("tmp", "tmp", "tmp"))).toEqual(["TMP"]);
  });
});

// ── 4. «Configuración → Plan y uso» solo a quien la ve ─────────────────────────────────────────────────────────────
const ENT = { vertical: "GENERAL" as const, plan: "CONSULTORIO" as const, publicBookingEnabled: false, ...NO_MODULE_OVERRIDES };

describe("[CF3-ZF4b] copy del upsell según quién lo lee", () => {
  it("[CF3-ZF4b5] moduleDeniedCopy: sin «Plan y uso» → «Pedile al titular…»; por default, el de siempre", () => {
    for (const m of ["salas", "salaEspera"] as const) {
      const ask = moduleDeniedCopy(ENT, m, { seesPlan: false });
      expect(ask, m).toContain(ASK_OWNER);
      expect(ask, m).not.toContain("Plan y uso");
      expect(ask, m).toMatch(/vienen? con los planes Clínica y Libre\./);
      expect(moduleDeniedCopy(ENT, m), m).toBe(MODULE_DENIED_COPY[m]);
      expect(moduleDeniedCopy(ENT, m, { seesPlan: true }), m).toBe(MODULE_DENIED_COPY[m]);
      expect(MODULE_DENIED_COPY[m], m).toContain("Configuración → Plan y uso.");
    }
    // Un módulo revocado por Plataforma sigue diciendo «escribinos desde Soporte», lo vea quien lo vea.
    const revoked = { ...ENT, plan: "CLINICA" as const, moduleRevokes: ["salas" as const] };
    expect(moduleDeniedCopy(revoked, "salas", { seesPlan: false })).toContain("Soporte");
  });

  const ROOMS: RoomRow[] = [
    { id: "c1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, active: true, sortOrder: 0, scheduleCount: 0 },
  ];
  const rooms = (el: ReactElement) =>
    text(
      renderToStaticMarkup(
        <TenantModulesProvider modules={modulesFor(ENT)} vertical="GENERAL">
          <ToastProvider>
            <ConfirmProvider>{el}</ConfirmProvider>
          </ToastProvider>
        </TenantModulesProvider>
      )
    );

  it("[CF3-ZF4b5] Salas sin el módulo: quien no ve «Plan y uso» lee «Pedile al titular…»", () => {
    const ask = rooms(<RoomsSection locationId="L1" locationName="Centro" rooms={ROOMS} seesPlan={false} />);
    expect(ask).toContain(ASK_OWNER);
    expect(ask).not.toContain("Plan y uso");
    expect(rooms(<RoomsSection locationId="L1" locationName="Centro" rooms={ROOMS} seesPlan />)).toContain(ROOMS_COPY.upsell);
    // Sin la prop (montajes viejos), lo de siempre.
    expect(rooms(<RoomsSection locationId="L1" locationName="Centro" rooms={ROOMS} />)).toContain(ROOMS_COPY.upsell);
    expect(ROOMS_COPY.upsell).toBe(MODULE_DENIED_COPY.salas);
  });

  const TENANT = {
    slug: "norte",
    vertical: "GENERAL",
    plan: "PRO",
    saasPlan: "CONSULTORIO",
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
    updatedAt: "2026-10-18T12:00:00.000Z",
  } as unknown as TenantSettings;
  const general = (seesPlan?: boolean) =>
    text(
      renderToStaticMarkup(
        <ToastProvider>
          <ConfirmProvider>
            <TweaksProvider>
              <GeneralPanel tenant={TENANT} admin sensitive seesPlan={seesPlan} />
            </TweaksProvider>
          </ConfirmProvider>
        </ToastProvider>
      )
    );

  it("[CF3-ZF4b5] General › «Plan»: a quien no ve «Plan y uso», «Pedile al titular…»", () => {
    const ask = general(false);
    expect(ask).toContain(ASK_OWNER);
    expect(ask).not.toContain("Plan y uso");
    expect(general(true)).toContain("en la pestaña «Plan y uso»");
    expect(general()).toContain("en la pestaña «Plan y uso»");
  });
});
