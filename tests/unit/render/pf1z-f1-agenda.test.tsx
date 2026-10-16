import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";

// PF1-Z-F1 — hallazgos del revisor visual sobre la agenda (footer sticky que tapa avisos y foco, Lista a 390,
// «Reprogramar» fuera de vista, «Cancelar» de un click, combobox que no cierra con Tab). Entorno node (sin jsdom,
// como el resto de `tests/unit/render`): la lógica de foco/scroll/blur vive en helpers puros que se prueban con
// nodos falsos, y el cableado se afirma sobre el markup real.
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());
vi.mock("@/lib/search", () => proxy());

import { BookingModal } from "@/components/agenda/booking-modal";
import { ConflictPrompt, PatientOverlapPrompt, promptFocusTarget } from "@/components/agenda/booking-modal/conflict-prompts";
import { StatusActions, cancelBookingConfirm, statusActionOptions } from "@/components/agenda/booking-drawer/status-actions";
import { DRAWER_FOOTER_ATTR, drawerScrollPaddingBottom, focusFirstField } from "@/components/ui/drawer";
import { pickerBlurCloses } from "@/components/patients/patient-picker";
import { ListView } from "@/components/agenda/views/list-view";
import listStyles from "@/components/agenda/views/views.module.css";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false });
const kine = (n: ReactNode) => renderToStaticMarkup(<TenantModulesProvider modules={KINE}>{n}</TenantModulesProvider>);
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Nodo falso: `querySelector` devuelve el primer elemento cuyo predicado matchea el selector pedido. */
type FakeEl = { tag: string; primary?: boolean; disabled?: boolean; type?: string; focused?: boolean; focus: (o?: unknown) => void };
const el = (tag: string, o: Partial<FakeEl> = {}): FakeEl => {
  const e: FakeEl = { tag, ...o, focus: () => { e.focused = true; } };
  return e;
};

describe("[PF1-Z-F1 #1/#3] el footer sticky no tapa avisos ni foco", () => {
  it("el panel reserva abajo el alto del footer (+ aire) como scroll-padding; sin footer, nada", () => {
    expect(drawerScrollPaddingBottom(123.4)).toBe("132px");
    expect(drawerScrollPaddingBottom(0)).toBe("");
    expect(drawerScrollPaddingBottom(null)).toBe("");
  });

  it("los dos footers sticky («Nuevo turno» y el drawer del turno) se marcan para que el Drawer los mida", () => {
    const props = {
      services: [{ id: "s1", name: "Consulta", durationMin: 30, priceCents: 0, color: null }],
      practitioners: [{ id: "p1", name: "Ana Pérez" }],
      patients: [],
      insurers: [],
      onClose: () => {},
      onSaved: () => {},
      defaultISO: "2026-10-05T12:00:00.000Z",
      defaultPractitionerId: "p1",
      capabilities: [...capabilitiesFor("OWNER")],
    };
    const html = kine(<BookingModal {...props} />);
    expect(html).toMatch(new RegExp(`<div class="[^"]*" ${DRAWER_FOOTER_ATTR}="">(?:(?!</div>).)*type="submit"`));
    expect(src("components/agenda/booking-drawer/index.tsx")).toMatch(
      new RegExp(`className=\\{styles\\.footer\\}\\s+${DRAWER_FOOTER_ATTR}`)
    );
  });

  it("al aparecer un aviso, el foco va a su botón primario habilitado (si no hay, al primero habilitado)", () => {
    const primary = el("button", { primary: true });
    const ghost = el("button");
    const root = {
      querySelector: (sel: string) =>
        sel.includes("data-prompt-primary") ? primary : sel.startsWith("button") ? ghost : null,
    };
    expect(promptFocusTarget(root)).toBe(primary);
    const noPrimary = { querySelector: (sel: string) => (sel.includes("data-prompt-primary") ? null : ghost) };
    expect(promptFocusTarget(noPrimary)).toBe(ghost);
    expect(promptFocusTarget(null)).toBeNull();
    // Los selectores excluyen los deshabilitados (el aviso puede pintarse con `pending` todavía en true).
    const seen: string[] = [];
    promptFocusTarget({ querySelector: (s: string) => (seen.push(s), null) });
    expect(seen.every((s) => s.includes(":not(:disabled)"))).toBe(true);
  });

  it("los avisos marcan su primaria: «Sí, crear superpuesto» en el cruce del paciente, «Usar próximo libre» en el cupo", () => {
    const payload = {} as never;
    const overlap = kine(
      <PatientOverlapPrompt
        promptRef={{ current: null }}
        patientOverlap={{ payload, existingISO: "2026-10-05T12:00:00.000Z" } as never}
        pending={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(overlap).toMatch(/data-prompt-primary="true"[^>]*>[^<]*Sí, crear/);
    const conflict = kine(
      <ConflictPrompt
        promptRef={{ current: null }}
        conflict={{ payload, nextFreeISO: "2026-10-05T13:00:00.000Z" } as never}
        pending={false}
        onUseSuggestedSlot={() => {}}
        onForceOverbooking={() => {}}
        onBack={() => {}}
      />
    );
    expect(conflict.split("data-prompt-primary").length - 1).toBe(1);
  });
});

describe("[PF1-Z-F1 #4] «Reprogramar» lleva el foco al primer campo", () => {
  it("focusFirstField enfoca el primer campo habilitado sin saltar, y trae el contenedor a la vista", () => {
    const input = el("input");
    let scrolled: unknown = null;
    const container = {
      querySelector: (s: string) => (s.includes("input") ? input : null),
      scrollIntoView: (o: unknown) => { scrolled = o; },
    };
    expect(focusFirstField(container)).toBe(true);
    expect(input.focused).toBe(true);
    expect(scrolled).toMatchObject({ block: "nearest" });
    expect(focusFirstField({ querySelector: () => null, scrollIntoView: () => {} })).toBe(false);
    expect(focusFirstField(null)).toBe(false);
  });
});

describe("[PF1-Z-F1 #6] «Cancelar turno» con confirmación", () => {
  it("el botón dice «Cancelar turno» (no se confunde con cerrar)", () => {
    expect(statusActionOptions("PENDING").map((o) => o.label)).toEqual(["Realizado", "Confirmar", "Ausente", "Cancelar turno"]);
    const html = renderToStaticMarkup(<StatusActions pending={false} onSetStatus={() => {}} current="CONFIRMED" />);
    expect(html).toContain(">Cancelar turno<");
    expect(html).not.toMatch(/>Cancelar</);
  });

  it("la confirmación nombra al paciente y la fecha en hora AR, danger, y su «no» no dice «Cancelar»", () => {
    const c = cancelBookingConfirm({ patientName: "Juana Gómez", scheduledFor: "2026-10-05T12:00:00.000Z" });
    expect(c.title).toMatch(/^¿Cancelar el turno de Juana Gómez del .*5.*09:00\?$/);
    expect(c.confirmLabel).toBe("Cancelar turno");
    expect(c.tone).toBe("danger");
    expect(c.cancelLabel).toBeDefined();
    expect(c.cancelLabel).not.toMatch(/cancelar/i);
  });
});

describe("[PF1-Z-F1 #7] el combobox de pacientes se cierra al salir con Tab", () => {
  const inside = { id: "in" } as unknown as Node;
  const outside = { id: "out" } as unknown as Node;
  const wrap = { contains: (n: Node | null) => n === inside };
  it("cierra si el foco se va fuera del combobox; no si queda adentro o no hay destino (click en la barra de scroll)", () => {
    expect(pickerBlurCloses(wrap, outside)).toBe(true);
    expect(pickerBlurCloses(wrap, inside)).toBe(false);
    expect(pickerBlurCloses(wrap, null)).toBe(false);
  });
});

describe("[PF1-Z-F1 #2] Lista a 390: la fila se apila", () => {
  const dto = (id: string): BookingDTO =>
    ({
      id,
      scheduledFor: "2026-10-05T12:00:00.000Z",
      durationMin: 45,
      status: "CONFIRMED",
      serviceId: "s",
      serviceName: "Kinesiología",
      serviceColor: "#3d74b5",
      practitionerId: "p1",
      patientId: "pat",
      patientName: `Paciente ${id}`,
      patientCondition: null,
      obraSocial: "Particular",
      copagoCents: 150000,
      updatedAt: "2026-10-05T10:00:00.000Z",
      notes: null,
      title: null,
      description: null,
      patientAccess: "full",
      arrivedAt: null,
      attendingAt: null,
      isOverbooked: false,
      programId: null,
      sessionId: null,
      pricedByPlan: false,
      plan: null,
      serviceDiscipline: "KINESIOLOGY",
      patientActiveLinkedPlanDisciplines: [],
    }) as BookingDTO;

  it("las columnas viven en el CSS Module (un inline no se puede pisar desde un @media)", () => {
    const html = renderToStaticMarkup(<ListView bookings={[dto("a")]} onEdit={() => {}} highlight={null} />);
    expect(html).not.toContain("grid-template-columns");
    expect(html).toContain(`class="${listStyles.listRow}"`);
    expect(html).toContain(`class="${listStyles.listHead}"`);
    for (const k of ["cellHour", "cellPatient", "cellService", "cellInsurer", "cellCopago", "cellDuration", "cellStatus"]) {
      expect(listStyles[k], k).toBeTruthy();
      expect(html).toContain(listStyles[k]);
    }
  });

  it("≤ 640 px: sin encabezado y en dos líneas (hora + paciente / servicio · estado · copago); desktop igual", () => {
    const css = src("components/agenda/views/views.module.css");
    expect(css).toContain("grid-template-columns: 70px minmax(0, 1.4fr) minmax(0, 1.1fr) minmax(0, 1fr) 90px 72px 112px");
    const mobile = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(mobile.length).toBeGreaterThan(30);
    expect(mobile).toMatch(/\.listHead\s*\{\s*display: none;/);
    expect(mobile).toMatch(/grid-template-areas:\s*"hour patient patient patient"\s*"\. service copago status"/);
  });
});
