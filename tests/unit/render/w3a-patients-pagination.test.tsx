/**
 * [HD-10] W3a (PV §27): UI de la paginación de /pacientes. Markup real por SSR (`renderToStaticMarkup`) de la
 * paginación, de la barra de selección y de la PÁGINA entera (server component async con sus datos mockeados: la
 * lectura de pacientes, catálogos y sesión; el armado de los href es el código real). Lo que se afirma son los `href`:
 * cambiar filtro, orden, `?os=` o archivados NO arrastra `?page=` (la página 3 de un filtro no es la 3 del otro).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
const data = vi.hoisted(() => ({
  listPatients: vi.fn(),
  bulkArchivePatients: vi.fn(),
  setPatientArchived: vi.fn(),
}));
vi.mock("@/lib/patients", () => data);
vi.mock("@/lib/insurers", () => ({
  listInsurers: vi.fn(async () => [
    { id: "os_1", name: "OSDE", isParticular: false },
    { id: "os_p", name: "Particular", isParticular: true },
  ]),
}));
vi.mock("@/lib/exercises", () => ({ loadFilterFacets: vi.fn(async () => ({ conditions: [] })) }));
const authz = vi.hoisted(() => ({ getCapabilities: vi.fn(), getTenantModules: vi.fn() }));
vi.mock("@/lib/authz", () => authz);
vi.mock("@/lib/session", () => ({ getActor: vi.fn(async () => ({ tenantId: "t1", userId: "u1", support: null })) }));
vi.mock("@/lib/bookings", () => ({ listPractitioners: vi.fn(async () => []) }));
vi.mock("@/lib/whatsapp-patient-ui-internal", () => ({ tenantWhatsAppActive: vi.fn(async () => false) }));
// CF2: nombres de la columna de profesionales (lectura cacheada; se mockea como el resto de las lecturas de la página).
vi.mock("@/lib/practitioner-names-internal", () => ({
  listPractitionerNames: vi.fn(async () => [{ id: "pr-ana", name: "Ana López", status: "active" }]),
}));

import PacientesPage from "@/app/(app)/pacientes/page";
import { PatientsPageIndicator, PatientsPagination, pageRangeLabel } from "@/components/patients/patients-pagination";
import {
  BulkActionBar,
  BulkSelectPageCheckbox,
  BulkSelectProvider,
  bulkSelectionLabel,
} from "@/components/patients/bulk-select";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { modulesFor } from "@/lib/tenant-modules";
import type { PatientRow } from "@/lib/patients-types";

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
const wrap = (node: ReactNode) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={Array.from(KINE)}>{node}</TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
const hrefFor = (p: number) => `/pacientes?sort=lastName.asc&page=${p}`;
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

describe("[HD-10] PatientsPagination", () => {
  it("página 1 de 3: «Anterior» deshabilitado sin link, «Siguiente» a la 2, 44 px", () => {
    const html = renderToStaticMarkup(<PatientsPagination page={1} pageCount={3} total={120} hrefFor={hrefFor} />);
    expect(html).toContain('aria-label="Paginación"');
    expect(html).toMatch(/<span aria-disabled="true"[^>]*>← Anterior/);
    // PV ZF2 (B16): «Página N de M» es texto, sin `aria-current` (eso va en un link, no en un span).
    expect(html.replace(/<!-- -->/g, "")).toMatch(/<span style="[^"]*">Página 1 de 3</);
    expect(html).not.toContain("aria-current");
    expect(hrefs(html)).toEqual(["/pacientes?sort=lastName.asc&page=2"]);
    expect(html).toContain("Mostrando 1–50 de 120");
    // `k-btn-md` = min-height 44 px (globals.css).
    expect(html.match(/k-btn-md/g)?.length).toBe(2);
  });

  it("página del medio: los dos links, a la anterior y a la siguiente", () => {
    const html = renderToStaticMarkup(<PatientsPagination page={2} pageCount={3} total={120} hrefFor={hrefFor} />);
    expect(hrefs(html)).toEqual(["/pacientes?sort=lastName.asc&page=1", "/pacientes?sort=lastName.asc&page=3"]);
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain("Mostrando 51–100 de 120");
  });

  it("última página: «Siguiente» deshabilitado y el rango corta en el total", () => {
    const html = renderToStaticMarkup(<PatientsPagination page={3} pageCount={3} total={120} hrefFor={hrefFor} />);
    expect(hrefs(html)).toEqual(["/pacientes?sort=lastName.asc&page=2"]);
    expect(html).toMatch(/<span aria-disabled="true"[^>]*>Siguiente →/);
    expect(html).toContain("Mostrando 101–120 de 120");
  });

  it("página única: no se muestra", () => {
    expect(renderToStaticMarkup(<PatientsPagination page={1} pageCount={1} total={12} hrefFor={hrefFor} />)).toBe("");
  });

  it("[PV ZF2 M6] indicador de arriba: «Página N de M ‹ ›» con los mismos href y bordes sin link", () => {
    const first = renderToStaticMarkup(<PatientsPageIndicator page={1} pageCount={3} hrefFor={hrefFor} />).replace(/<!-- -->/g, "");
    expect(first).toContain('aria-label="Páginas del directorio"');
    expect(first).toContain("Página 1 de 3");
    expect(hrefs(first)).toEqual(["/pacientes?sort=lastName.asc&page=2"]);
    expect(first).toContain('aria-label="Página siguiente"');
    expect(first).toMatch(/<span aria-disabled="true"[^>]*>[\s\S]*?Página anterior/);
    const mid = renderToStaticMarkup(<PatientsPageIndicator page={2} pageCount={3} hrefFor={hrefFor} />);
    expect(hrefs(mid)).toEqual(["/pacientes?sort=lastName.asc&page=1", "/pacientes?sort=lastName.asc&page=3"]);
    // k-btn-sm: 40 px en escritorio, 44 px < 768 (globals.css).
    expect(mid.match(/k-btn-sm/g)?.length).toBe(2);
    expect(renderToStaticMarkup(<PatientsPageIndicator page={1} pageCount={1} hrefFor={hrefFor} />)).toBe("");
  });

  it("rango con separador de miles AR", () => {
    expect(pageRangeLabel(2, 1234)).toBe("Mostrando 51–100 de 1.234");
    expect(pageRangeLabel(25, 1234)).toBe("Mostrando 1.201–1.234 de 1.234");
  });
});

describe("[HD-10] selección masiva «de esta página»", () => {
  it("casilla del encabezado «Seleccionar todos los de esta página»", () => {
    const html = wrap(
      <BulkSelectProvider>
        <BulkSelectPageCheckbox ids={["a", "b"]} />
      </BulkSelectProvider>
    );
    expect(html).toContain('aria-label="Seleccionar todos los de esta página"');
    expect(html).not.toMatch(/checked/);
  });

  it("con todos los de la página elegidos, la casilla queda marcada; sin ids, no se muestra", () => {
    const html = wrap(
      <BulkSelectProvider initialSelected={["a", "b"]}>
        <BulkSelectPageCheckbox ids={["a", "b"]} />
      </BulkSelectProvider>
    );
    expect(html).toMatch(/checked/);
    expect(wrap(<BulkSelectProvider><BulkSelectPageCheckbox ids={[]} /></BulkSelectProvider>)).toBe("");
  });

  it("el contador de la barra dice «de esta página»", () => {
    expect(bulkSelectionLabel(1)).toBe("1 paciente de esta página seleccionado");
    expect(bulkSelectionLabel(3)).toBe("3 pacientes de esta página seleccionados");
    const html = wrap(
      <BulkSelectProvider initialSelected={["a", "b", "c"]}>
        <BulkActionBar />
      </BulkSelectProvider>
    );
    expect(html).toContain("3 pacientes de esta página seleccionados");
  });
});

function row(over: Partial<PatientRow> = {}): PatientRow {
  return {
    id: "p1",
    firstName: "Ana",
    lastName: "García",
    email: null,
    phone: null,
    documentId: "30111222",
    dateOfBirth: null,
    notes: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    activeProgramTitle: null,
    sessionsTotal: 0,
    sessionsDone: 0,
    lastVisit: null,
    upcomingAt: null,
    obraSocial: null,
    access: "full",
    activePlans: [],
    ...over,
  } as PatientRow;
}

async function renderPage(searchParams: Record<string, string>) {
  const el = await PacientesPage({ searchParams });
  return wrap(el);
}

describe("[HD-10] /pacientes: la página no viaja al cambiar filtro u orden", () => {
  beforeEach(() => {
    authz.getTenantModules.mockResolvedValue(KINE);
    authz.getCapabilities.mockResolvedValue(new Set(["clinical.read"]));
    data.listPatients.mockResolvedValue({
      rows: [row({ id: "p51" }), row({ id: "p52", lastName: "Pérez" })],
      total: 1234,
      totals: { all: 1234 },
      page: 2,
      pageCount: 25,
    });
  });

  const SP = { q: "ana", sort: "createdAt.desc", os: "os_1", page: "2", ageMin: "30" };

  it("manda `page` al server y la paginación conserva búsqueda, orden y filtros", async () => {
    const html = await renderPage(SP);
    expect(data.listPatients).toHaveBeenCalledWith(expect.objectContaining({ page: 2, insurerKey: "os_1" }));
    expect(html).toContain("Mostrando 51–100 de 1.234");
    // h1 con separador de miles AR (antes «1234»). CF2 (decisión 3): sin pills «Todos / Con plan / Sin plan».
    expect(html).toMatch(/>1\.234<\/span> pacientes/);
    expect(html).not.toContain("Todos · ");
    const nav = html.slice(html.indexOf('aria-label="Paginación"'));
    const pag = hrefs(nav);
    expect(pag).toHaveLength(2);
    for (const h of pag) {
      const sp = new URL(h, "http://x").searchParams;
      expect(sp.get("q")).toBe("ana");
      expect(sp.get("sort")).toBe("createdAt.desc");
      expect(sp.get("os")).toBe("os_1");
      expect(sp.get("ageMin")).toBe("30");
    }
    // La 1 es la URL sin `page` (canónica).
    expect(pag.map((h) => new URL(h, "http://x").searchParams.get("page"))).toEqual([null, "3"]);
  });

  it("orden, archivados, `?os=` y filtros avanzados no arrastran `page`", async () => {
    const html = await renderPage(SP);
    const nav = html.indexOf('aria-label="Paginación"');
    // PV ZF2 (M6): el indicador de arriba SÍ lleva `page` (es paginación); se saca de lo que «no arrastra page».
    const top = html.match(/<nav aria-label="Páginas del directorio"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(top).not.toBe("");
    expect(hrefs(top).map((h) => new URL(h, "http://x").searchParams.get("page"))).toEqual([null, "3"]);
    const outside = hrefs(html.slice(0, nav).replace(top, "")).filter((h) => h.startsWith("/pacientes?"));
    // 5 órdenes + archivados (CF2: las 3 pills salieron).
    expect(outside.length).toBeGreaterThanOrEqual(6);
    for (const h of outside) expect(new URL(h, "http://x").searchParams.has("page")).toBe(false);
    // Los forms GET (obra social y avanzados) mandan sus hidden: ninguno es `page`.
    expect(html).not.toMatch(/type="hidden" name="page"/);
    expect(html).toMatch(/type="hidden" name="q" value="ana"/);
  });

  it("encabezado con la casilla «de esta página» (solo filas con acceso completo)", async () => {
    const html = await renderPage(SP);
    expect(html).toContain('aria-label="Seleccionar todos los de esta página"');
  });

  it("una sola página: sin paginación", async () => {
    data.listPatients.mockResolvedValue({
      rows: [row()],
      total: 1,
      totals: { all: 1 },
      page: 1,
      pageCount: 1,
    });
    const html = await renderPage({});
    expect(html).not.toContain('aria-label="Paginación"');
  });
});

describe("[CF2-U1] /pacientes: columnas y filtros de CF2 en la página real", () => {
  beforeEach(() => {
    authz.getTenantModules.mockResolvedValue(KINE);
    data.listPatients.mockReset();
    data.listPatients.mockResolvedValue({
      rows: [row({ id: "p1", assignedPractitionerId: "pr-ana", practitionerIds: ["pr-ana"], activity: "active" })],
      total: 1,
      totals: { all: 1 },
      page: 1,
      pageCount: 1,
    });
  });

  it("[CF2-U1-15] encabezado sin «Plan activo» y la celda con el nombre que arma la página", async () => {
    authz.getCapabilities.mockResolvedValue(new Set(["clinical.read"]));
    const html = await renderPage({});
    expect(html).not.toContain("Plan activo");
    expect(html).toContain(">Nombre y apellido<");
    expect(html).toContain(">Kinesiólogo<");
    expect(html).toContain('title="Ana López (a cargo)"');
  });

  it("[CF2-U1-16] sin clinical.read: «Último diagnóstico» no se ofrece y un `?diagnosisSlug=` de URL no llega al server", async () => {
    authz.getCapabilities.mockResolvedValue(new Set(["patients.read"]));
    const html = await renderPage({ diagnosisSlug: "lumbalgia", ageMin: "20" });
    expect(data.listPatients).toHaveBeenCalledWith(expect.objectContaining({ diagnosisSlug: undefined }));
    expect(html).not.toContain("Último diagnóstico");
  });

  it("[CF2-U1-17] `?filter=active` de un link viejo se lee como «todos»", async () => {
    authz.getCapabilities.mockResolvedValue(new Set(["clinical.read"]));
    await renderPage({ filter: "active" });
    expect(data.listPatients).toHaveBeenCalledWith(expect.objectContaining({ filter: "all" }));
  });
});
