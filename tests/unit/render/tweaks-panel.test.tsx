import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [RX-1e] Apariencia → sección «Recepción», segmentado «Escritorio de recepción» (Tablero · Lista y panel · Flujo).
 * Sin jsdom: el panel se renderiza con `renderToStaticMarkup` y el click se prueba disparando el `onClick` real de cada
 * botón del `ReceptionLayoutControl` (sin hooks, se llama como función). La persistencia se afirma sobre el
 * `setReceptionLayout` real del `TweaksProvider` con la red mockeada (`updateAgendaViewPrefs`).
 */
const prefs = vi.hoisted(() => ({ calls: [] as unknown[], ok: true }));
vi.mock("@/lib/preferences", () => ({
  updateUserPreferences: async (patch: unknown) => ({ ok: true, data: patch }),
  updateAgendaViewPrefs: async (patch: unknown) => {
    prefs.calls.push(patch);
    return prefs.ok ? { ok: true, data: patch } : { ok: false, error: "x" };
  },
}));

import { TweaksProvider, useTweaks, persistReceptionLayout } from "@/components/layout/tweaks-context";
import {
  TweaksPanel,
  ReceptionLayoutControl,
  RECEPTION_LAYOUT_OPTIONS,
  RECEPTION_SAVE_ERROR,
  receptionRolledBack,
} from "@/components/layout/tweaks-panel";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import { RECEPTION_LAYOUTS, type ReceptionLayout } from "@/lib/preferences-constants";

const CLINICA = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));
const CONSULTORIO = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: false }));

function ForceOpen({ children }: { children: ReactNode }) {
  const { t } = useTweaks();
  // Solo para el render estático (sin effects): abre el panel del provider real.
  (t as { minimised: boolean }).minimised = false;
  return <>{children}</>;
}

function openPanel(opts: { canReception: boolean; modules?: string[]; layout?: ReceptionLayout }) {
  return renderToStaticMarkup(
    <ToastProvider>
      <TenantModulesProvider modules={(opts.modules ?? CLINICA) as typeof CLINICA}>
        <TweaksProvider initialReceptionLayout={opts.layout}>
          <ForceOpen>
            <TweaksPanel canReception={opts.canReception} />
          </ForceOpen>
        </TweaksProvider>
      </TenantModulesProvider>
    </ToastProvider>
  );
}

/** Botones del árbol de elementos (sin DOM): el `onClick` es el real del componente. */
function buttons(node: ReactNode): ReactElement<{ onClick: () => void; "data-layout": string; "aria-pressed": boolean }>[] {
  const out: ReactElement<{ onClick: () => void; "data-layout": string; "aria-pressed": boolean }>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const props = n.props as { children?: ReactNode };
    if (n.type === "button") out.push(n as (typeof out)[number]);
    walk(props.children);
  };
  walk(node);
  return out;
}

const pressed = (html: string, v: ReceptionLayout) =>
  new RegExp(`aria-pressed="true"[^>]*data-layout="${v}"`).test(html);

beforeEach(() => {
  prefs.calls = [];
  prefs.ok = true;
});

describe("[RX-1e] Recepción: visibilidad", () => {
  it("con módulo salaEspera y capacidad agenda.reception: sección «Recepción» con las tres opciones y su línea", () => {
    const html = openPanel({ canReception: true });
    expect(html).toContain(">Recepción<");
    expect(html).toContain('aria-label="Escritorio de recepción"');
    for (const o of RECEPTION_LAYOUT_OPTIONS) {
      expect(html).toContain(`>${o.label}<`);
      expect(html).toContain(`>${o.hint}<`);
    }
    expect(RECEPTION_LAYOUT_OPTIONS.map((o) => o.value)).toEqual([...RECEPTION_LAYOUTS]);
    expect(RECEPTION_LAYOUT_OPTIONS.map((o) => o.label)).toEqual(["Tablero", "Lista y panel", "Flujo"]);
  });

  it("sin la capacidad agenda.reception: oculta", () => {
    const html = openPanel({ canReception: false });
    expect(html).toContain(">Apariencia</h2>");
    expect(html).not.toContain("Recepción");
    expect(html).not.toContain("Escritorio de recepción");
  });

  it("sin el módulo salaEspera (plan Consultorio): oculta aunque tenga la capacidad", () => {
    expect(CONSULTORIO).not.toContain("salaEspera");
    const html = openPanel({ canReception: true, modules: CONSULTORIO });
    expect(html).toContain(">Apariencia</h2>");
    expect(html).not.toContain("Escritorio de recepción");
  });

  it("AppShell le pasa la capacidad desde sus caps", () => {
    const src = readFileSync(join(process.cwd(), "components/layout/app-shell.tsx"), "utf8");
    expect(src).toContain('<TweaksPanel canReception={caps.includes("agenda.reception")} />');
  });
});

describe("[RX-1e] Recepción: cada opción aplica y persiste", () => {
  for (const o of RECEPTION_LAYOUT_OPTIONS) {
    it(`${o.label} → marcada cuando es la del server, el click la elige y se guarda en agendaPrefs`, async () => {
      // Aplica: con ese valor en el contexto, solo esa opción queda marcada.
      const html = openPanel({ canReception: true, layout: o.value });
      for (const other of RECEPTION_LAYOUTS) expect(pressed(html, other)).toBe(other === o.value);

      // Click: el botón real llama onChange con su valor.
      const chosen: ReceptionLayout[] = [];
      const tree = ReceptionLayoutControl({ value: "board", onChange: (v) => chosen.push(v) });
      const btn = buttons(tree).find((b) => b.props["data-layout"] === o.value);
      expect(btn).toBeDefined();
      btn!.props.onClick();
      expect(chosen).toEqual([o.value]);

      // Persiste: el setReceptionLayout real del provider va a updateAgendaViewPrefs({ receptionLayout }).
      const from: ReceptionLayout = o.value === "board" ? "flow" : "board";
      let set: ((v: ReceptionLayout) => void) | undefined;
      function Probe() {
        set = useTweaks().setReceptionLayout;
        return null;
      }
      renderToStaticMarkup(
        <TweaksProvider initialReceptionLayout={from}>
          <Probe />
        </TweaksProvider>
      );
      set!(o.value);
      await Promise.resolve();
      expect(prefs.calls).toEqual([{ receptionLayout: o.value }]);
    });
  }

  it("elegir la que ya está no pide nada al server", () => {
    let set: ((v: ReceptionLayout) => void) | undefined;
    function Probe() {
      set = useTweaks().setReceptionLayout;
      return null;
    }
    renderToStaticMarkup(
      <TweaksProvider initialReceptionLayout="list">
        <Probe />
      </TweaksProvider>
    );
    set!("list");
    expect(prefs.calls).toEqual([]);
  });
});

describe("[RX-1e] Recepción: si el server rechaza, aviso", () => {
  it("copy del toast", () => {
    expect(RECEPTION_SAVE_ERROR).toBe("No pudimos guardar la vista. Probá de nuevo.");
  });

  it("rechazo → el contexto vuelve al previo → receptionRolledBack avisa", async () => {
    let current: ReceptionLayout = "list"; // ya aplicado (optimista)
    const pending = { next: "list" as ReceptionLayout, prev: "board" as ReceptionLayout };
    const ok = await persistReceptionLayout("list", "board", {
      save: async () => ({ ok: false }),
      apply: (v) => (current = v),
      isLatest: () => true,
    });
    expect(ok).toBe(false);
    expect(current).toBe("board");
    expect(receptionRolledBack(pending, current)).toBe(true);
  });

  it("guardado → sin aviso; sin pedido pendiente → sin aviso", async () => {
    let current: ReceptionLayout = "flow";
    await persistReceptionLayout("flow", "board", {
      save: async () => ({ ok: true }),
      apply: (v) => (current = v),
      isLatest: () => true,
    });
    expect(receptionRolledBack({ next: "flow", prev: "board" }, current)).toBe(false);
    expect(receptionRolledBack(null, "board")).toBe(false);
  });

  it("dos clics rápidos (Lista → Flujo): el rechazo del viejo no vuelve atrás ni avisa", async () => {
    let current: ReceptionLayout = "flow";
    await persistReceptionLayout("list", "board", {
      save: async () => ({ ok: false }),
      apply: (v) => (current = v),
      isLatest: () => false,
    });
    expect(current).toBe("flow");
    expect(receptionRolledBack({ next: "flow", prev: "list" }, current)).toBe(false);
  });
});
