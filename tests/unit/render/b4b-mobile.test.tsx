/**
 * [B4b] Mobile pendiente fuera de la agenda (plan §21.4 punto 8; AUDIT «DIR y MB (16-oct)»: mbz-perfil-tabs-tablas-390,
 * mbz-plataforma-tablas-scroll, mbz-diagnostico-wizard-390, mbz-tap-backlog-44 en el perfil).
 *
 *  - Perfil: Turnos, Facturación y Sesiones dejan de ser tablas con scroll horizontal a 390: bajo 768 cada fila es una
 *    card con rótulos (`data-label`); desde 768 la grilla de siempre (columnas en `--pt-cols`, ancho mínimo en
 *    `--pt-min-w`, scroll DENTRO de la card).
 *  - Plataforma: catálogo (prestadoras/prácticas/especialidades), propuestas, importaciones y ejercicios usan la
 *    grilla compartida `responsive-table.module.css` (la de consultorios/usuarios/facturación/auditoría, MB-1f).
 *  - Diagnóstico: el asistente mobile con targets de 44 px y el botón de avanzar pegado arriba de la barra inferior.
 *
 * Vitest en `node` (sin jsdom): markup real por SSR de las vistas reales + el CSS real de los CSS Modules (sin
 * comentarios). Los CSS Modules en vitest devuelven un nombre para cualquier clave, así que cada regla se afirma en
 * el archivo .css y cada uso en el markup comparando contra la misma clave importada.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/plataforma/catalogo/prestadoras",
}));
// TP-3f2: Facturación monta la card «Links de pago» (server actions de cobros online): solo la red, mockeada.
vi.mock("@/lib/online-charges-read", () => ({
  getBookingOnlineCharges: async () => ({ ok: true, data: [] }),
  listPatientOnlineCharges: async () => ({ ok: true, data: [] }),
}));
vi.mock("@/lib/payment-links", () => ({
  cancelPaymentLink: async () => ({ ok: false, error: "mock" }),
  getPaymentLinkShare: async () => ({ ok: false, error: "mock" }),
  sendPaymentLinkEmail: async () => ({ ok: false, error: "mock" }),
}));
vi.mock("@/lib/bookings", () => ({
  setBookingStatus: vi.fn(),
  deleteBooking: vi.fn(),
  setBookingCopagoPaid: vi.fn(),
  setBookingInsurerPaid: vi.fn(),
}));
vi.mock("@/lib/catalog-admin", () => ({
  setCatalogArchived: vi.fn(),
  promotePayerPlan: vi.fn(),
  refreshCatalogCache: vi.fn(),
}));
vi.mock("@/lib/exercises-admin", () => ({ archiveGlobalExercise: vi.fn(), restoreGlobalExercise: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/components/plataforma/catalog/catalog-drawer", () => ({ CatalogDrawer: () => null }));
vi.mock("@/components/plataforma/exercise-drawer", () => ({ ExerciseDrawer: () => null }));
vi.mock("@/components/diagnostico/assign-plan-modal", () => ({
  DIAGNOSIS_DOOR_COPY: { cannotAssign: "x" },
  DiagnosisDoorBanner: () => null,
  DiagnosisPlanDoor: () => null,
  NO_DIAGNOSIS_DOOR: { patient: null, bookingId: null, patientNotFound: false, canAssign: true },
  buildDiagnosisEditorRequest: vi.fn(),
  useDiagnosisPlanDoor: () => ({ request: null, open: false, openEditor: vi.fn(), close: vi.fn() }),
  wizardDiagnosisExerciseIds: vi.fn(() => []),
}));

import { TurnosView } from "@/components/patients/profile/views/turnos-view";
import { FacturacionView } from "@/components/patients/profile/views/facturacion-view";
import { SesionesView } from "@/components/patients/profile/views/sesiones-view";
import { CatalogAdminClient } from "@/components/plataforma/catalog/catalog-admin-client";
import { ProposalsClient } from "@/components/plataforma/catalog/proposals-client";
import { ImportRunsClient } from "@/components/plataforma/catalog/import-runs-client";
import { ExerciseAdminClient } from "@/components/plataforma/exercise-admin-client";
import { DiagnosticoWizard } from "@/components/screens/diagnostico-wizard";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import profileTable from "@/components/patients/profile/views/profile-table.module.css";
import table from "@/components/plataforma/responsive-table.module.css";
import diag from "@/components/diagnostico/diagnostico.module.css";
import hero from "@/components/patients/profile/hero.module.css";
import type { PatientBookingFull } from "@/lib/patients-types";
import type { PlanDTO } from "@/lib/plans-read-types";
import type { CatalogAdminPage } from "@/lib/catalog-admin-types";
import type { GlobalExerciseAdminRow } from "@/lib/exercises-admin";
import { DEFAULT_CATALOG_FILTERS } from "@/lib/preferences-constants";
import type { CatalogDTO } from "@/lib/diagnosis-engine";

const css = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function allMedia(src: string, query: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const start = src.indexOf(`@media (${query})`, from);
    if (start < 0) return out;
    let depth = 0;
    let end = src.length;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    out += src.slice(start, end);
    from = end;
  }
}
const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const cls = (name: string) => new RegExp(`class="[^"]*\\b${name}\\b[^"]*"`);
const count = (html: string, re: RegExp) => (html.match(new RegExp(re.source, "g")) ?? []).length;

let seq = 0;
function booking(over: Omit<Partial<PatientBookingFull>, "scheduledFor"> & { scheduledFor: string }): PatientBookingFull {
  seq += 1;
  return {
    id: `bk_${seq}`,
    tenantId: "t1",
    patientId: "pat_1",
    serviceId: "svc_1",
    practitionerId: "pr_1",
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    insurerPaidAt: null,
    durationMin: 45,
    programId: null,
    sessionId: null,
    serviceName: "Kinesiología",
    obraSocial: "OSDE",
    copagoCents: 1_000_000,
    osAmountCents: 500_000,
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    title: null,
    notes: null,
    ...over,
    scheduledFor: new Date(over.scheduledFor),
  } as unknown as PatientBookingFull;
}

const PROFILE_CSS = css("components/patients/profile/views/profile-table.module.css");
const TABLE_CSS = css("components/plataforma/responsive-table.module.css");

describe("[B4b] perfil: Turnos, Facturación y Sesiones como cards bajo 768", () => {
  const bks = [
    booking({ scheduledFor: "2026-09-10T13:00:00Z", status: "COMPLETED", paymentStatus: "PAID" }),
    booking({ scheduledFor: "2026-09-20T13:00:00Z", serviceName: "Consulta suelta" }),
  ];
  const common = { patientId: "pat_1", loading: false, patchBooking: () => {}, dropBooking: () => {} };

  it("CSS: grilla por variables desde 768; bajo 768 encabezado oculto, fila en 2 columnas, rótulos y 44 px", () => {
    expect(PROFILE_CSS).toMatch(/\.head,\s*\.row\s*\{[^}]*grid-template-columns:\s*var\(--pt-cols\)/);
    expect(PROFILE_CSS).toMatch(/\.inner\s*\{[^}]*min-width:\s*var\(--pt-min-w, 0\)/);
    expect(PROFILE_CSS).toMatch(/\.scroller\s*\{[^}]*overflow-x:\s*auto/);
    const mobile = allMedia(PROFILE_CSS, "max-width: 767px");
    expect(mobile).toMatch(/\.scroller\s*\{[^}]*overflow-x:\s*visible/);
    expect(mobile).toMatch(/\.inner\s*\{[^}]*min-width:\s*0/);
    expect(mobile).toMatch(/\.head\s*\{[^}]*display:\s*none/);
    expect(mobile).toMatch(/\.row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    expect(mobile).toMatch(/\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/);
    // Acción de la fila arriba a la derecha de la card (al lado de la fecha), no al final.
    expect(mobile).toMatch(/\.actions\s*\{[^}]*grid-row:\s*1/);
    expect(mobile).toMatch(/\.wide\s*\{[^}]*grid-column:\s*1 \/ -1/);
    expect(mobile).toMatch(/\.row :is\(button, a\[href\]\)\s*\{[^}]*min-height:\s*44px/);
  });

  it("Turnos (plana y admin): sin scroll inline, columnas en variables y cada celda con su rótulo", () => {
    for (const html of [wrap(<TurnosView {...common} bookings={bks} />), wrap(<TurnosView {...common} bookings={bks} admin />)]) {
      expect(html).not.toContain("overflow-x:auto");
      expect(html).not.toMatch(/grid-template-columns:120px/);
      expect(html).toMatch(/--pt-cols:120px/);
      expect(html).toMatch(/--pt-min-w:(720|780)px/);
      expect(html).toMatch(cls(profileTable.scroller));
      expect(count(html, cls(profileTable.row))).toBe(2);
      for (const l of ["Servicio", "Obra social", "Copago", "Duración", "Estado"]) expect(html).toContain(`data-label="${l}"`);
    }
    const admin = wrap(<TurnosView {...common} bookings={bks} admin />);
    // «Ver en agenda» sigue adentro de la fila (en la card, arriba a la derecha).
    expect(admin).toMatch(new RegExp(`class="${profileTable.actions}"[^>]*>(<[^>]+>)*Ver en agenda`));
  });

  it("Facturación: misma grilla; los toggles de cobro dentro de la fila (44 px bajo 768)", () => {
    const html = wrap(<FacturacionView bookings={bks} loading={false} patchBooking={() => {}} />);
    expect(html).not.toContain("overflow-x:auto");
    expect(html).toMatch(/--pt-cols:92px/);
    expect(count(html, cls(profileTable.row))).toBe(2);
    for (const l of ["Servicio", "Obra social", "OS (prestadora)", "Copago (paciente)"]) expect(html).toContain(`data-label="${l}"`);
    expect(html).toContain("Confirmar");
  });

  it("Sesiones: misma grilla con rótulos; «Abrir →» en la acción de la card", () => {
    const plan = {
      id: "p1",
      patientId: "pat_1",
      level: "full",
      discipline: "KINESIOLOGY",
      status: "ACTIVE",
      archivedAt: null,
      linked: true,
      title: null,
      totalLive: 2,
      done: 1,
      sinTurno: 0,
      updatedAt: new Date("2026-10-01T12:00:00Z"),
      sessions: [
        { id: "s1", index: 0, ordinal: 1, state: "done", sinTurno: false, scheduledFor: new Date("2026-09-10T13:00:00Z"), archivedAt: null, title: null, notes: null, exerciseCount: null },
        { id: "s2", index: 1, ordinal: 2, state: "booked", sinTurno: false, scheduledFor: new Date("2026-10-20T13:00:00Z"), archivedAt: null, title: null, notes: null, exerciseCount: 4 },
      ],
    } as unknown as PlanDTO;
    const html = wrap(
      <SesionesView
        patient={{ id: "pat_1" } as never}
        plans={[plan]}
        permissions={{ manage: true, schedule: true } as never}
        onOpenEditor={() => {}}
      />
    );
    expect(html).not.toContain("overflow-x:auto");
    expect(html).toMatch(/--pt-cols:120px 1fr 130px 1fr 150px/);
    expect(count(html, cls(profileTable.row))).toBe(2);
    for (const l of ["Fecha", "Estado", "Notas"]) expect(html).toContain(`data-label="${l}"`);
    expect(html).toMatch(new RegExp(`class="${profileTable.actions}"[^>]*>(<[^>]+>)*Abrir →`));
  });

  it("hero: los chips de plan llevan el target de 44 px bajo 768", () => {
    const heroCss = allMedia(css("components/patients/profile/hero.module.css"), "max-width: 767px");
    expect(heroCss).toMatch(/\.chip\s*\{[^}]*min-height:\s*44px/);
    const src = readFileSync(join(process.cwd(), "components/patients/profile/hero.tsx"), "utf8");
    expect(src).toMatch(/className=\{heroStyles\.chip\}/);
    expect(hero.chip).toBeTruthy();
  });
});

describe("[B4b] Plataforma: catálogo, propuestas, importaciones y ejercicios en la grilla compartida", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    name: "OSDE",
    slug: "osde",
    aliases: [],
    detail: "Prepaga",
    code: "123",
    source: "SSS",
    sourceDate: "2026-09-01T00:00:00.000Z",
    curatedAt: null,
    archived: false,
    usage: [{ label: "coberturas", count: 3 }],
    ...over,
  });
  const page = (rows: unknown[]): CatalogAdminPage => ({ rows, total: rows.length, page: 1, pageCount: 1 }) as unknown as CatalogAdminPage;

  it("CSS compartido: acción a lo ancho de la card y sólo-mobile (orden de Ejercicios)", () => {
    const mobile = allMedia(TABLE_CSS, "max-width: 767px");
    expect(mobile).toMatch(/\.row > :first-child,\s*\.row > \.wide\s*\{[^}]*grid-column:\s*1 \/ -1/);
    expect(TABLE_CSS).toMatch(/\.mobileOnly\s*\{\s*display:\s*none/);
    expect(mobile).toMatch(/\.mobileOnly\s*\{[^}]*display:\s*flex/);
  });

  it("catálogo: variables en lugar de columnas inline, rótulos y alcance de 44 px", () => {
    for (const entity of ["payer", "specialty"] as const) {
      const html = wrap(
        <CatalogAdminClient entity={entity} state={{ q: "", kind: "", source: "", archived: "active" }} data={page([row()])} />
      );
      expect(html).not.toContain("overflow-x:auto");
      expect(html).not.toMatch(/grid-template-columns:minmax\(220px/);
      expect(html).toContain("--pt-cols:minmax(220px,2.4fr)");
      expect(html).toMatch(cls(table.scroller));
      expect(count(html, cls(table.row))).toBe(1);
      expect(count(html, cls(table.tapScope))).toBeGreaterThanOrEqual(2);
      for (const l of ["Fuente", "Uso"]) expect(html).toContain(`data-label="${l}"`);
      expect(html.includes('data-label="Código"') || html.includes(`data-label="`)).toBe(true);
    }
  });

  it("propuestas e importaciones: misma grilla con rótulos", () => {
    const prop = wrap(
      <ProposalsClient
        proposals={[
          { id: "pp1", name: "Plan 210", slug: "plan-210", createdAt: "2026-09-01T00:00:00.000Z", payerName: "OSDE", payerArchived: false, tenantName: "Movare", coverages: 2, globalMatch: null },
        ] as never}
      />
    );
    expect(prop).not.toContain("overflow-x:auto");
    expect(count(prop, cls(table.row))).toBe(1);
    for (const l of ["Prestadora", "Consultorio", "Coberturas"]) expect(prop).toContain(`data-label="${l}"`);
    const runs = wrap(
      <ImportRunsClient
        runs={[
          { id: "r1", ranAt: "2026-09-01T00:00:00.000Z", file: "sss.csv", sha256: "abcdef0123456789", kind: "payer", created: 3, updated: 1, skipped: 0, conflictCount: 0, ranBy: "Martin" },
        ] as never}
      />
    );
    expect(runs).not.toContain("overflow-x:auto");
    expect(count(runs, cls(table.row))).toBe(1);
    for (const l of ["Archivo", "Tipo", "Nuevas", "Conflictos", "Corrió"]) expect(runs).toContain(`data-label="${l}"`);
  });

  it("ejercicios: grilla compartida, rótulos y orden también en mobile (el encabezado ordenable se oculta)", () => {
    const ex = {
      id: "e1",
      name: "Puente",
      slug: "puente",
      kind: "EXERCISE",
      difficulty: 2,
      tags: [],
      defaultSets: 3,
      defaultReps: 10,
      durationSeconds: null,
      mediaCount: 1,
      hasArticle: false,
      archived: false,
    } as unknown as GlobalExerciseAdminRow;
    const html = wrap(
      <ExerciseAdminClient
        rows={[ex]}
        total={1}
        page={1}
        state={{ filters: DEFAULT_CATALOG_FILTERS, sortCol: "name", sortDir: "asc", pageSize: 25 }}
        tagOptions={[]}
        catalogTags={{ muscle: [], equipment: [], discipline: [] }}
      />
    );
    expect(html).not.toContain("overflow-x:auto");
    expect(html).toMatch(/--pt-cols:minmax\(190px,2.3fr\)/);
    expect(count(html, cls(table.row))).toBe(1);
    for (const l of ["Tipo", "Dificultad", "Clasificación", "Prescripción"]) expect(html).toContain(`data-label="${l}"`);
    expect(html).toMatch(cls(table.mobileOnly));
    expect(html).toMatch(/<select[^>]*aria-label="Ordenar por"/);
  });
});

describe("[B4b] asistente de diagnóstico a 390", () => {
  const catalog = {
    regions: [
      { slug: "knee-l", label: "Rodilla izq.", view: "FRONT" },
      { slug: "hip-l", label: "Cadera izq.", view: "FRONT" },
    ],
    symptoms: [{ slug: "dolor", label: "Dolor" }],
    triggers: [{ slug: "subir", label: "Subir escaleras" }],
    phases: [{ slug: "aguda", label: "Aguda" }],
    conditions: [],
  } as unknown as CatalogDTO;

  it("CSS: alcance de 44 px bajo 768 y pie pegado arriba de la barra inferior", () => {
    const src = css("components/diagnostico/diagnostico.module.css");
    const mobile = allMedia(src, "max-width: 767px");
    expect(mobile).toMatch(/\.wizard :is\(button, input\[type="range"\]\)\s*\{[^}]*min-height:\s*44px/);
    expect(mobile).toMatch(/\.wizard button\s*\{[^}]*min-width:\s*44px/);
    expect(src).toMatch(/\.wizardFooter\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*calc\(var\(--k-bottom-nav-h, 0px\) \+ 8px\)/);
  });

  it("markup: alcance del asistente, pie pegado, botones `type=button` y sin 100dvh (lo dejaba con hueco bajo el PageHeader)", () => {
    const html = renderToStaticMarkup(<DiagnosticoWizard catalog={catalog} />);
    expect(html).toMatch(cls(diag.wizard));
    expect(html).toMatch(cls(diag.wizardFooter));
    expect(html).not.toContain("100dvh");
    // Las opciones de zona son botones reales (no submit) con su estado anunciado.
    expect(html).toMatch(/<button type="button" aria-pressed="false"[^>]*>Rodilla izq\./);
  });
});
