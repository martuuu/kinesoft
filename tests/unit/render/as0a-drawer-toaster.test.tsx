/**
 * [AS-0a] Bug del modal «Nuevo turno»: «el select de Servicio solo funciona después de elegir Sala».
 *
 * Causa reproducida (Playwright ad hoc contra `next dev`, 18-oct): con un Drawer abierto a ≥ 768 px la pila de toasts
 * se corría arriba a la izquierda con 360 px fijos, asumiendo drawers ≤ 480. «Nuevo turno» mide 580: a 800 y 900 px
 * de ancho `elementFromPoint` sobre el borde izquierdo de Profesional y Servicio devolvía el toast, no el select. El
 * aviso de llegada dura 12 s y se PAUSA con el mouse encima: la Secretaria intentaba abrir Servicio, el toast no se
 * iba, bajaba a elegir Sala (el mouse sale, el toast vence) y al volver el select ya andaba.
 *
 * Fix: el Drawer publica su ancho (`--k-drawer-w`) y dónde va la pila (`data-k-toaster`): al lado del panel si entra
 * (angostada hasta 260), si no abajo a la izquierda, sobre el pie del drawer. Y el select sin servicios dice por qué.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyDrawerToasterMark,
  drawerToasterPlacement,
  TOASTER_BESIDE_MIN_W,
} from "@/components/ui/drawer";
import { ServiceSection, noServicesCopy } from "@/components/agenda/booking-modal/service-section";

const GLOBALS = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Cuerpo de `selector { … }` dentro de `@media (min-width: 768px)`. */
function ruleIn768(selector: string): string {
  const out: string[] = [];
  for (const b of GLOBALS.matchAll(/@media \(min-width: 768px\)\s*\{/g)) {
    let depth = 0;
    const start = b.index! + b[0].length - 1;
    for (let i = start; i < GLOBALS.length; i++) {
      if (GLOBALS[i] === "{") depth++;
      else if (GLOBALS[i] === "}" && --depth === 0) {
        out.push(GLOBALS.slice(start + 1, i));
        break;
      }
    }
  }
  const scope = out.join("\n");
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = scope.match(new RegExp(`(?:^|[}\\s,])${esc}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`falta la regla ${selector}`);
  return m[1].replace(/\s+/g, " ");
}

describe("[AS-0a] drawerToasterPlacement", () => {
  it("sin drawer o < 768: la posición de siempre (el CSS de < 768 ya la sube sobre el pie)", () => {
    expect(drawerToasterPlacement({ viewportWidth: 1366, drawerWidth: null })).toEqual({ placement: "default", toastWidth: null });
    expect(drawerToasterPlacement({ viewportWidth: 700, drawerWidth: 580 })).toEqual({ placement: "default", toastWidth: null });
    expect(drawerToasterPlacement({ viewportWidth: 390, drawerWidth: 580 })).toEqual({ placement: "default", toastWidth: null });
  });

  it("«Nuevo turno» (580) a 1024 y 1366: al lado del panel con el ancho completo", () => {
    expect(drawerToasterPlacement({ viewportWidth: 1024, drawerWidth: 580 })).toEqual({ placement: "beside", toastWidth: 360 });
    expect(drawerToasterPlacement({ viewportWidth: 1366, drawerWidth: 580 })).toEqual({ placement: "beside", toastWidth: 360 });
  });

  it("a 900: al lado pero angostado, sin pisar el panel (el caso del bug)", () => {
    const p = drawerToasterPlacement({ viewportWidth: 900, drawerWidth: 580 });
    expect(p.placement).toBe("beside");
    // Panel desde 900 − 12 − 580 = 308; la pila arranca en 16 y deja 12 de aire.
    expect(16 + p.toastWidth! + 12).toBeLessThanOrEqual(308);
    expect(p.toastWidth!).toBeGreaterThanOrEqual(TOASTER_BESIDE_MIN_W);
  });

  it("a 800 y 768 no entra al lado: abajo a la izquierda", () => {
    expect(drawerToasterPlacement({ viewportWidth: 800, drawerWidth: 580 }).placement).toBe("bottom");
    expect(drawerToasterPlacement({ viewportWidth: 768, drawerWidth: 580 }).placement).toBe("bottom");
    // Un drawer de 480 a 768 tampoco entraba (16 + 360 > 768 − 492): la suposición vieja ya era justa.
    expect(drawerToasterPlacement({ viewportWidth: 768, drawerWidth: 480 }).placement).toBe("bottom");
  });

  it("nunca se superpone con el panel cuando dice «beside» (barrido 768..1600 × anchos reales)", () => {
    for (const drawerWidth of [420, 480, 560, 580, 640, 720]) {
      for (let viewportWidth = 768; viewportWidth <= 1600; viewportWidth += 8) {
        const p = drawerToasterPlacement({ viewportWidth, drawerWidth });
        if (p.placement !== "beside") continue;
        const panelLeft = viewportWidth - 12 - Math.min(drawerWidth, viewportWidth - 24);
        expect(16 + p.toastWidth! + 12).toBeLessThanOrEqual(panelLeft);
      }
    }
  });
});

describe("[AS-0a] applyDrawerToasterMark publica ancho y lugar en el <html>", () => {
  const mkRoot = () => {
    const props = new Map<string, string>();
    return {
      props,
      root: {
        dataset: {} as Record<string, string | undefined>,
        style: {
          setProperty: (k: string, v: string) => void props.set(k, v),
          removeProperty: (k: string) => void props.delete(k),
        },
      },
    };
  };

  it("con drawers abiertos usa el más ancho; al cerrar todos limpia", () => {
    const { root, props } = mkRoot();
    applyDrawerToasterMark(root, [480, 580], 900);
    expect(props.get("--k-drawer-w")).toBe("580px");
    expect(root.dataset.kToaster).toBe("beside");
    expect(props.get("--k-toaster-w")).toBe("280px");
    applyDrawerToasterMark(root, [580], 800);
    expect(root.dataset.kToaster).toBe("bottom");
    expect(props.has("--k-toaster-w")).toBe(false);
    applyDrawerToasterMark(root, [], 800);
    expect(root.dataset.kToaster).toBeUndefined();
    expect(props.has("--k-drawer-w")).toBe(false);
  });

  it("< 768: sin marca de lugar (manda el CSS móvil) pero con el ancho publicado", () => {
    const { root, props } = mkRoot();
    applyDrawerToasterMark(root, [580], 390);
    expect(root.dataset.kToaster).toBeUndefined();
    expect(props.get("--k-drawer-w")).toBe("580px");
  });
});

describe("[AS-0a] CSS de la pila con drawer (globals.css)", () => {
  it("«beside» toma el ancho calculado y «bottom» baja sobre el pie del drawer", () => {
    expect(ruleIn768('html[data-k-drawer-open][data-k-toaster="beside"] .k-toaster')).toContain(
      "width: var(--k-toaster-w, 360px)"
    );
    const bottom = ruleIn768('html[data-k-drawer-open][data-k-toaster="bottom"] .k-toaster');
    expect(bottom).toContain("top: auto");
    expect(bottom).toContain("bottom: calc(var(--k-drawer-footer-h, 0px) + 24px)");
  });
});

describe("[AS-0a] Servicio sin servicios habilitados: copy explícito", () => {
  const noop = () => {};
  const pros = [{ id: "p1", name: "Lucía Méndez" }] as never;

  it("copy con el nombre y dónde se habilita", () => {
    expect(noServicesCopy("Lucía Méndez")).toBe(
      "Lucía Méndez no tiene servicios habilitados · Configuración → Profesionales"
    );
  });

  it("render: el placeholder y la ayuda lo dicen; con servicios, el de siempre", () => {
    const empty = renderToStaticMarkup(
      <ServiceSection
        practitioners={pros}
        practitionerId="p1"
        onPractitionerChange={noop}
        services={[]}
        serviceId=""
        onServiceChange={noop}
        serviceEnabled={null}
      />
    );
    expect(empty).toContain("— Lucía Méndez no tiene servicios habilitados —");
    expect(empty).toMatch(/role="status"[^>]*>Lucía Méndez no tiene servicios habilitados · Configuración → Profesionales/);

    const ok = renderToStaticMarkup(
      <ServiceSection
        practitioners={pros}
        practitionerId="p1"
        onPractitionerChange={noop}
        services={[{ id: "s1", name: "Kine", durationMin: 45 }] as never}
        serviceId=""
        onServiceChange={noop}
        serviceEnabled={null}
      />
    );
    expect(ok).toContain("— Seleccioná un servicio —");
    expect(ok).not.toContain("no tiene servicios habilitados");
  });
});
