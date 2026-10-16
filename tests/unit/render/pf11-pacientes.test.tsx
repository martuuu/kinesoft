import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * [PF1.1-pacientes] Bundle y pulido del directorio y de la ficha. Se montan los componentes reales; solo se mockean
 * el router de Next y las server actions (no se invocan). Cada caso afirma el HTML que ve el usuario o el import que
 * llega al bundle, no la implementación.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/lib/patients", () => ({
  setPatientArchived: vi.fn(),
  sendPatientPortalInvite: vi.fn(),
  recordEvaScore: vi.fn(),
}));
vi.mock("@/lib/bookings", () => ({ setBookingInsurerPaid: vi.fn(), setBookingCopagoPaid: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
// Los módulos de server actions envuelven resolvers con `React.cache` (solo existe en RSC): identidad en el test.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import { PatientsList, patientRowSubline, rowEnterDelayMs } from "@/components/patients/patients-list";
import { heroPlanSummaryText, HERO_PLAN_SUMMARY_FROM } from "@/components/patients/profile/hero";
import { ResumenView, RESUMEN_COPY } from "@/components/patients/profile/views/resumen-view";
import { EvolucionView } from "@/components/patients/profile/views/evolucion-view";
import { factDateLabel } from "@/components/patients/profile/views/facturacion-view";
import { sessionPastUnclosed } from "@/components/patients/profile/views/sesiones-view";
import { TabsBar } from "@/components/patients/profile/tabs-bar";
import { preloadProfileTab } from "@/components/patients/patient-profile";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import { NO_PLAN_PERMISSIONS, type HeroPlanChip } from "@/components/planes/plan-editor-types";
import type { PatientRow } from "@/lib/patients-types";
import type { PatientWithRelations } from "@/components/patients/profile/types";

const KINE_PRO = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));

function wrap(node: ReactNode) {
  return renderToStaticMarkup(
    <ToastProvider>
      <TenantModulesProvider modules={KINE_PRO}>{node}</TenantModulesProvider>
    </ToastProvider>
  );
}

function row(over: Partial<PatientRow> = {}): PatientRow {
  return {
    id: "p1",
    firstName: "Ana",
    lastName: "García",
    email: "ana@example.test",
    phone: "1155550000",
    documentId: "30111222",
    dateOfBirth: null,
    notes: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    activeProgramTitle: null,
    sessionsTotal: 0,
    sessionsDone: 0,
    lastVisit: null,
    upcomingAt: null,
    obraSocial: "OSDE",
    access: "full",
    activePlans: [],
    ...over,
  } as PatientRow;
}

const ROOT = join(__dirname, "..", "..", "..");
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("[PF1.1] C-PF1: sin `motion.` en pacientes; la entrada es CSS", () => {
  it("patients-list y patient-profile no importan framer; tabs-bar usa `m`", () => {
    expect(src("components/patients/patients-list.tsx")).not.toMatch(/from "framer-motion"/);
    expect(src("components/patients/patient-profile.tsx")).not.toMatch(/from "framer-motion"/);
    const tabs = src("components/patients/profile/tabs-bar.tsx");
    expect(tabs).toMatch(/import \{ m \} from "framer-motion"/);
    expect(tabs).not.toMatch(/<\/?motion\./);
  });

  it("las filas se pintan visibles en el SSR (sin opacity:0 inline) con entrada CSS escalonada y tope", () => {
    const html = wrap(<PatientsList rows={[row(), row({ id: "p2", lastName: "Pérez" })]} archived={false} />);
    expect(html).not.toMatch(/opacity:0/);
    expect(html.match(/k-enter-fade/g)?.length).toBe(2);
    expect(html).toContain("animation-delay:35ms");
    expect(rowEnterDelayMs(0)).toBe(0);
    expect(rowEnterDelayMs(100)).toBe(rowEnterDelayMs(12));
  });
});

describe("[PF1.1] D2/D11: directorio", () => {
  it("la fila no muestra el email (queda en el title); la segunda línea es DNI o teléfono", () => {
    const html = wrap(<PatientsList rows={[row()]} archived={false} />);
    expect(html).toContain("DNI 30111222");
    expect(html).not.toMatch(/>ana@example\.test</);
    expect(html).toContain('title="Ana García · ana@example.test"');
    expect(patientRowSubline({ access: "full", documentId: null, phone: "11" })).toBe("11");
    expect(patientRowSubline({ access: "basic", documentId: null, phone: "11" })).toBe("Sin acceso");
  });

  it("las celdas llevan las clases de la card < 768 y rótulos que solo existen en mobile", () => {
    const html = wrap(<PatientsList rows={[row({ upcomingAt: new Date("2026-10-20T13:00:00Z") })]} archived={false} />);
    expect(html).toContain("Cobertura:");
    expect(html).toContain("Próx. turno:");
    const css = src("components/patients/patients-directory.module.css");
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.head \{\s*display: none;/);
    expect(css).toMatch(/grid-template-areas:/);
  });

  it("C-PF5.4: los inputs del directorio ya no llevan `outline: none` sin reemplazo", () => {
    for (const f of [
      "components/patients/patients-search-bar.tsx",
      "components/patients/advanced-filters.tsx",
      "components/patients/patient-picker.tsx",
    ]) {
      expect(src(f)).not.toMatch(/outline:\s*["']?none/);
    }
    expect(src("components/patients/patients-directory.module.css")).toMatch(/\.pill:focus-within \{\s*box-shadow: var\(--focus-ring\)/);
  });
});

describe("[PF1.1] D7: chip resumen del hero con 3+ planes", () => {
  const chip = (status: "ACTIVE" | "PAUSED", i: number): HeroPlanChip => ({
    programId: `p${i}`,
    discipline: "KINESIOLOGY",
    status,
    done: 0,
    totalLive: 6,
  });
  it("cuenta activos y pausados en voseo, sin títulos", () => {
    expect(HERO_PLAN_SUMMARY_FROM).toBe(3);
    expect(heroPlanSummaryText([chip("ACTIVE", 1), chip("ACTIVE", 2), chip("PAUSED", 3)]).text).toBe(
      "2 planes activos · 1 pausado"
    );
    expect(heroPlanSummaryText([chip("PAUSED", 1), chip("PAUSED", 2), chip("PAUSED", 3)]).text).toBe(
      "3 planes pausados"
    );
    expect(heroPlanSummaryText([chip("ACTIVE", 1), chip("ACTIVE", 2), chip("ACTIVE", 3)]).ariaLabel).toBe(
      "3 planes en curso (3 planes activos)"
    );
  });

  it("D5: el hero ya no usa el PhotoSlot «paciente»", () => {
    const hero = src("components/patients/profile/hero.tsx");
    expect(hero).not.toMatch(/<PhotoSlot|import \{[^}]*PhotoSlot/);
    expect(hero).toContain("<HeroAvatar");
  });
});

describe("[PF1.1] D6/D12: vacíos con acción", () => {
  const patient = {
    id: "pat_1",
    firstName: "Lucía",
    lastName: "Gómez",
    notes: null,
    bookings: [],
    evaScores: [],
  } as unknown as PatientWithRelations;

  it("Resumen sin diagnóstico: «Sin diagnóstico cargado» + «Cargar diagnóstico», nunca otro texto", () => {
    const html = wrap(
      <ResumenView
        patient={patient}
        plan={null}
        diagnosisName={null}
        permissions={NO_PLAN_PERMISSIONS}
        onOpenEditor={() => {}}
        onEditPatient={() => {}}
      />
    );
    expect(html).toContain(RESUMEN_COPY.noDiagnosis);
    expect(html).toContain(RESUMEN_COPY.addDiagnosis);
    expect(html).not.toContain("Aún no asignado");
    // Sin el callback no hay botón que no hace nada.
    const bare = wrap(
      <ResumenView patient={patient} plan={null} diagnosisName={null} permissions={NO_PLAN_PERMISSIONS} onOpenEditor={() => {}} />
    );
    expect(bare).not.toContain(RESUMEN_COPY.addDiagnosis);
  });

  it("el shell ya no usa el título del plan como diagnóstico", () => {
    expect(src("components/patients/patient-profile.tsx")).toMatch(/const diagnosisName = patientCore\.diagnosisTitle \?\? null;/);
  });

  it("pestaña EVA vacía: «Registrar EVA» solo con callback", () => {
    expect(renderToStaticMarkup(<EvolucionView patient={patient} onRegister={() => {}} />)).toContain("Registrar EVA");
    expect(renderToStaticMarkup(<EvolucionView patient={patient} />)).not.toContain("Registrar EVA");
  });
});

describe("[PF1.1] D8/D10: Facturación y Sesiones", () => {
  it("fecha de Facturación `dd/mm/aa` en hora AR (un turno 01:00 UTC es el día anterior)", () => {
    expect(factDateLabel("2026-07-27T15:00:00Z")).toBe("27/07/26");
    expect(factDateLabel("2026-07-28T01:00:00Z")).toBe("27/07/26");
  });

  it("los montos «percibido» usan --success-fg (no lima) y el chip Cobrado no tiene hex sueltos", () => {
    expect(src("components/patients/profile/ui.tsx")).toContain('tone === "lime" ? "var(--success-fg)"');
    const fact = src("components/patients/profile/views/facturacion-view.tsx");
    expect(fact).not.toContain("#1F7A52");
    expect(fact).toContain("{insured ? b.obraSocial : \"Particular\"}");
  });

  it("«Sin cerrar» solo para la legacy Programada con fecha pasada", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    const past = new Date("2026-06-01T12:00:00Z");
    const future = new Date("2026-11-01T12:00:00Z");
    expect(sessionPastUnclosed({ state: "unbooked", sinTurno: false, scheduledFor: past }, now)).toBe(true);
    expect(sessionPastUnclosed({ state: "unbooked", sinTurno: false, scheduledFor: future }, now)).toBe(false);
    expect(sessionPastUnclosed({ state: "unbooked", sinTurno: true, scheduledFor: past }, now)).toBe(false);
    expect(sessionPastUnclosed({ state: "done", sinTurno: false, scheduledFor: past }, now)).toBe(false);
  });
});

describe("[PF1.1] C-PF2: pestañas diferidas con precarga", () => {
  it("las pestañas no activas precargan en pointerenter/focus; la activa no", () => {
    const html = renderToStaticMarkup(
      <TabsBar active="resumen" onChange={() => {}} onPreload={() => {}} counts={{ fact: 12 }} only={["resumen", "fact"]} />
    );
    // React no serializa handlers: se afirma por el código y por que la barra no parte el rótulo.
    expect(html).toContain("white-space:nowrap");
    const tabs = src("components/patients/profile/tabs-bar.tsx");
    expect(tabs).toMatch(/onPointerEnter=\{onPreload && !on \?/);
    expect(tabs).toMatch(/onFocus=\{onPreload && !on \?/);
  });

  it("preloadProfileTab baja el chunk de la pestaña (y no tira con Resumen, que es estática)", async () => {
    expect(() => preloadProfileTab("resumen")).not.toThrow();
    preloadProfileTab("fact");
    const mod = await import("@/components/patients/profile/views/facturacion-view");
    expect(typeof mod.FacturacionView).toBe("function");
  });

  it("los drawers de alta/edición y los diálogos de evoluciones son dinámicos", () => {
    expect(src("components/patients/new-patient-button.tsx")).toMatch(/import\("@\/components\/patients\/new-patient-drawer"\)/);
    expect(src("components/patients/profile/hero.tsx")).toMatch(/import\("\.\/edit-patient-drawer"\)/);
    const card = src("components/clinical-notes/note-card.tsx");
    for (const m of ["note-editor-drawer", "void-note-dialog", "note-history-modal"]) {
      expect(card).not.toMatch(new RegExp(`^import .* from "@/components/clinical-notes/${m}"`, "m"));
    }
  });
});
