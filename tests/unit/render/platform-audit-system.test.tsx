import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * BO3-E · render de /plataforma/auditoria y /plataforma/sistema, y de los helpers de la vista del catálogo de
 * ejercicios sin consultorio. Sin jsdom: `renderToStaticMarkup` de las vistas REALES con props; las páginas solo
 * cablean la lectura (`listPlatformAudit` / `getPlatformSystemStatus`, cubiertas por integración y unit).
 *
 * Lo que se fija: los filtros reflejan la URL, «Cargar más» lleva el cursor y los filtros, y ningún valor de payload
 * que no esté en la allowlist llega al HTML (el fixture pasa por `sanitizeAuditPayload`, como en el server). Sistema:
 * presencia sin valores.
 */
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: vi.fn(async () => ({ ok: true })) }));
// El cliente del catálogo arrastra las actions de Plataforma (server): acá solo se prueban sus helpers puros.
vi.mock("@/lib/exercises-admin", () => ({}));
vi.mock("@/components/plataforma/exercise-drawer", () => ({ ExerciseDrawer: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { AuditView } from "@/components/plataforma/audit/audit-view";
import { SystemView } from "@/components/plataforma/system/system-view";
import { sanitizeAuditPayload, type PlatformAuditPage } from "@/lib/platform-audit-logic";
import { buildSystemStatus } from "@/lib/platform-system-logic";
import {
  CATALOG_PREFS_STORAGE_KEY,
  catalogHref,
  readDeviceCatalogPrefs,
  writeDeviceCatalogPrefs,
} from "@/components/plataforma/exercise-admin-client";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";

const page: PlatformAuditPage = {
  rows: [
    {
      id: "ev1",
      createdAt: "2026-10-14T02:30:00.000Z", // 13-oct 23:30 AR
      action: "platform.tenant.status",
      actorEmail: "super@kinesoft.test",
      tenant: { id: "t1", name: "Movare" },
      targetUserId: "u-target",
      payload: sanitizeAuditPayload({
        changed: ["status"],
        before: { status: "ACTIVE" },
        after: { status: "SUSPENDED" },
        reason: "Paciente Juana Pérez con hernia L4-L5",
        email: "juana@paciente.test",
      }),
    },
    {
      id: "ev2",
      createdAt: "2026-10-13T15:00:00.000Z",
      action: "platform.catalog.tag.create",
      actorEmail: null,
      tenant: null,
      targetUserId: null,
      payload: sanitizeAuditPayload({ label: "Dolor de Juana", kind: "GOAL" }),
    },
  ],
  nextCursor: "CURSOR123",
};

describe("[BO3-E] AuditView", () => {
  it("filas, links y payload sin valores sensibles", () => {
    const html = renderToStaticMarkup(<AuditView page={page} filters={{ action: "platform.tenant" }} />);
    expect(html).toContain("platform.tenant.status");
    expect(html).toContain("super@kinesoft.test");
    expect(html).toContain("Script o cron");
    expect(html).toContain('href="/plataforma/consultorios/t1"');
    expect(html).toContain('href="/plataforma/usuarios/u-target"');
    expect(html).toContain("after.status: SUSPENDED");
    expect(html).toContain("kind: GOAL");
    // Claves sin valor.
    expect(html).toMatch(/>reason</);
    expect(html).toMatch(/>email</);
    expect(html).toMatch(/>label</);
    for (const leak of ["Juana", "hernia", "juana@paciente.test"]) expect(html).not.toContain(leak);
    // Fecha en día AR (23:30 AR del 13, no el 14 UTC).
    expect(html).toContain("23:30");
  });

  it("filtros desde la URL y «Cargar más» con cursor + filtros", () => {
    const html = renderToStaticMarkup(
      <AuditView page={page} filters={{ action: "platform.tenant", from: "2026-10-01", tenantId: "t1", cursor: "PREV" }} />
    );
    expect(html).toMatch(/<option value="platform.tenant" selected="">Consultorios<\/option>/);
    expect(html).toContain('value="2026-10-01"');
    expect(html).toContain('type="hidden" name="tenantId" value="t1"');
    expect(html).toContain("Consultorio: Movare");
    expect(html).toContain(
      'href="/plataforma/auditoria?action=platform.tenant&amp;tenantId=t1&amp;from=2026-10-01&amp;cursor=CURSOR123"'
    );
    expect(html).toContain("Volver a los más recientes");
    expect(html).toContain("Limpiar");
  });

  it("vacío con y sin filtros; sin «Cargar más» cuando no hay cursor", () => {
    const empty: PlatformAuditPage = { rows: [], nextCursor: null };
    expect(renderToStaticMarkup(<AuditView page={empty} filters={{}} />)).toContain("Todavía no hay eventos registrados.");
    const filtered = renderToStaticMarkup(<AuditView page={empty} filters={{ actorEmail: "x" }} />);
    expect(filtered).toContain("No hay eventos con estos filtros.");
    expect(filtered).not.toContain("Cargar más");
  });
});

describe("[BO3-E] SystemView", () => {
  it("presencia (OK / Falta) y valores solo de enums; ningún secreto en el HTML", () => {
    const status = buildSystemStatus(
      {
        RESEND_API_KEY: "re_SECRETO-123",
        SENTRY_DSN: "https://SECRETO@sentry.io/1",
        REALTIME_DRIVER: "off",
        TENANT_ACCESS_ENFORCEMENT: "banner",
        NEXT_PUBLIC_APP_URL: "https://app.SECRETO.test",
      },
      { available: true, applied: 87, last: "20261014000000_platform_backoffice" },
      { up: true, ms: 5 }
    );
    const html = renderToStaticMarkup(<SystemView status={status} />);
    expect(html).not.toMatch(/SECRETO/);
    expect(html).toContain("Correo (Resend)");
    expect(html).toContain("Mercado Pago");
    expect(html).toContain(">OK<");
    expect(html).toContain(">Falta<");
    expect(html).toContain(">off<");
    expect(html).toContain(">banner<");
    expect(html).toContain(">87<");
    expect(html).toContain("OK · pública");
  });
});

describe("[BO3-E] vista del catálogo de ejercicios en el navegador (superadmin sin consultorio)", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("guarda y restaura sanitizado; storage bloqueado → null sin tirar", () => {
    const prefs = { ...DEFAULT_PREFERENCES.catalogPrefs, pageSize: 50 };
    writeDeviceCatalogPrefs(prefs);
    expect(JSON.parse(store[CATALOG_PREFS_STORAGE_KEY]).pageSize).toBe(50);
    expect(readDeviceCatalogPrefs()).toEqual(prefs);
    store[CATALOG_PREFS_STORAGE_KEY] = "{roto";
    expect(readDeviceCatalogPrefs()).toBeNull();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("QuotaExceeded");
        },
      },
    });
    expect(readDeviceCatalogPrefs()).toBeNull();
    expect(() => writeDeviceCatalogPrefs(prefs)).not.toThrow();
  });

  it("catalogHref arma la URL de la tabla", () => {
    const href = catalogHref({ ...DEFAULT_PREFERENCES.catalogPrefs, filters: { ...DEFAULT_PREFERENCES.catalogPrefs.filters, q: "sentadilla", muscle: ["gluteo", "cuadriceps"] } }, 2);
    expect(href).toMatch(/^\/plataforma\/ejercicios\?/);
    expect(href).toContain("q=sentadilla");
    expect(href).toContain("muscle=gluteo%2Ccuadriceps");
    expect(href).toContain("page=2");
  });
});
