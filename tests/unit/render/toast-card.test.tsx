/**
 * [SV03u] Toast con acción, `leading`, dedupe por `id` y pausa (C-SV8).
 *
 * Por qué existe: los avisos de la sala de espera (SV11b) usan el toast para
 * «Llegó María G. · 10:30 — Ver sala». Un mismo evento puede llegar dos veces
 * (lote + resync) y no tiene que apilar dos toasts; la Secretaria que pasa el
 * mouse por encima para leerlo no tiene que verlo desaparecer.
 *
 * Se renderiza el `ToastCard` real con `renderToStaticMarkup` (sin jsdom) y se
 * testea la lógica de pila y reloj, que vive en funciones puras exportadas
 * del mismo `toast.tsx` (el provider solo las aplica).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ToastCard,
  TOAST_STACK_MAX,
  dismissToast,
  showToast,
  toastClockHold,
  toastClockRestart,
  toastDefaultDuration,
  type ToastItem,
} from "@/components/ui/toast";

function item(over: Partial<ToastItem> = {}): ToastItem {
  return { id: "t1", tone: "info", title: "Turno creado", duration: 4500, version: 0, ...over };
}

const noop = () => {};

describe("[SV03u] ToastCard", () => {
  it("con action renderiza el botón con su label y un aria-label descriptivo; role=status", () => {
    const html = renderToStaticMarkup(
      <ToastCard
        item={item({ tone: "arrival", title: "Llegó María G. · 10:30", action: { label: "Ver sala", onClick: noop } })}
        onDismiss={noop}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toMatch(/<button[^>]*data-toast-action[^>]*><span[^>]*>Ver sala<\/span><\/button>/);
    expect(html).toContain('aria-label="Ver sala: Llegó María G. · 10:30"');
    // El cierre sigue estando, con su label de siempre.
    expect(html).toContain('aria-label="Cerrar notificación"');
  });

  it("[FX2b] la acción y la X quedan FUERA del bloque de texto que se remonta por versión (no pierden el foco)", () => {
    const html = renderToStaticMarkup(
      <ToastCard
        item={item({ tone: "arrival", title: "Llegó María G. · 10:30", version: 2, action: { label: "Ver sala", onClick: noop } })}
        onDismiss={noop}
      />,
    );
    // El bloque keyed (`data-toast-text`) cierra antes del botón de acción.
    const text = html.match(/<div data-toast-text[^>]*>([\s\S]*?)<\/div><button/);
    expect(text).not.toBeNull();
    expect(text![1]).toContain("Llegó María G. · 10:30");
    expect(text![1]).not.toContain("<button");
    expect(html.indexOf("data-toast-text")).toBeLessThan(html.indexOf("data-toast-action"));
  });

  it("[FX2b] área de toque ≥ 32 px en «Ver sala» y en la X", () => {
    const html = renderToStaticMarkup(
      <ToastCard item={item({ tone: "arrival", action: { label: "Ver sala", onClick: noop } })} onDismiss={noop} />,
    );
    expect(html).toMatch(/<button[^>]*data-toast-action[^>]*style="[^"]*min-height:32px/);
    expect(html).toMatch(/<button[^>]*aria-label="Cerrar notificación"[^>]*style="[^"]*width:32px;height:32px/);
  });

  it("leading reemplaza el ícono del tono", () => {
    const html = renderToStaticMarkup(
      <ToastCard item={item({ tone: "arrival", leading: <span data-testid="avatar">MG</span> })} onDismiss={noop} />,
    );
    expect(html).toContain('<span data-testid="avatar">MG</span>');
    expect(html).toContain("data-toast-leading");
  });

  it("sin action no hay botón de acción: solo el de cerrar", () => {
    const html = renderToStaticMarkup(<ToastCard item={item()} onDismiss={noop} />);
    expect(html).not.toContain("data-toast-action");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('role="status"');
    expect(html).toContain("Turno creado");
  });

  it("la barra de progreso es la clase CSS pausable y dura lo que dura el toast", () => {
    const html = renderToStaticMarkup(<ToastCard item={item({ tone: "arrival", duration: 12000 })} onDismiss={noop} />);
    expect(html).toMatch(/class="k-toast-progress"[^>]*animation-duration:12000ms/);
    const sticky = renderToStaticMarkup(<ToastCard item={item({ duration: 0 })} onDismiss={noop} />);
    expect(sticky).not.toContain("k-toast-progress");
  });

  it("el tono arrival dura 12 s por default; el resto, 4,5 s", () => {
    expect(toastDefaultDuration("arrival")).toBe(12000);
    expect(toastDefaultDuration("info")).toBe(4500);
    expect(toastDefaultDuration("error")).toBe(4500);
  });
});

describe("[SV03u] pila: showToast / dismissToast", () => {
  it("un id repetido reemplaza el contenido en su lugar y sube la versión, sin apilar", () => {
    const a = showToast([], item({ id: "arr:b1:x", title: "Llegó María G." })).toasts;
    const b = showToast(a, item({ id: "otro", title: "Otro" })).toasts;
    const r = showToast(b, item({ id: "arr:b1:x", title: "Llegó María G. · 10:30" }));
    expect(r.toasts.map((t) => t.id)).toEqual(["otro", "arr:b1:x"]);
    expect(r.toasts[1].title).toBe("Llegó María G. · 10:30");
    expect(r.toasts[1].version).toBe(1);
    expect(r.replaced).toBe(true);
    expect(r.dropped).toEqual([]);
  });

  it("uno nuevo entra arriba y la pila se corta en 5 (el más viejo sale y se informa)", () => {
    let list: ToastItem[] = [];
    for (let i = 1; i <= TOAST_STACK_MAX; i++) list = showToast(list, item({ id: `t${i}` })).toasts;
    const r = showToast(list, item({ id: "t6" }));
    expect(TOAST_STACK_MAX).toBe(5);
    expect(r.toasts.map((t) => t.id)).toEqual(["t6", "t5", "t4", "t3", "t2"]);
    expect(r.dropped.map((t) => t.id)).toEqual(["t1"]);
    expect(r.replaced).toBe(false);
  });

  it("dismiss saca el toast y lo devuelve; un id desconocido no cambia nada", () => {
    const list = showToast([], item({ id: "a" })).toasts;
    const r = dismissToast(list, "a");
    expect(r.toasts).toEqual([]);
    expect(r.removed?.id).toBe("a");
    const same = dismissToast(list, "zzz");
    expect(same.toasts).toBe(list);
    expect(same.removed).toBeNull();
  });
});

describe("[SV03u] reloj: pausa en hover / focus y reanuda donde quedó", () => {
  it("hover pausa, salir reanuda con lo que faltaba", () => {
    let c = toastClockRestart(null, 12000, 1000);
    expect(c).toMatchObject({ remaining: 12000, startedAt: 1000 });
    c = toastClockHold(c, "hover", true, 4000); // corrió 3 s
    expect(c).toMatchObject({ remaining: 9000, startedAt: null });
    c = toastClockHold(c, "hover", false, 60000); // estuvo pausado mucho: no descuenta
    expect(c).toMatchObject({ remaining: 9000, startedAt: 60000 });
  });

  it("hover y focus juntos: solo reanuda cuando se van los dos", () => {
    let c = toastClockRestart(null, 10000, 0);
    c = toastClockHold(c, "hover", true, 2000);
    c = toastClockHold(c, "focus", true, 3000);
    c = toastClockHold(c, "hover", false, 4000);
    expect(c.startedAt).toBeNull();
    expect(c.remaining).toBe(8000);
    c = toastClockHold(c, "focus", false, 5000);
    expect(c).toMatchObject({ remaining: 8000, startedAt: 5000 });
  });

  it("reemplazo por id reinicia el tiempo completo y respeta una pausa en curso", () => {
    let c = toastClockRestart(null, 12000, 0);
    c = toastClockHold(c, "hover", true, 5000);
    c = toastClockRestart(c, 12000, 6000);
    expect(c).toMatchObject({ remaining: 12000, startedAt: null, hover: true });
  });

  it("hold repetido no descuenta dos veces", () => {
    let c = toastClockRestart(null, 10000, 0);
    c = toastClockHold(c, "hover", true, 1000);
    c = toastClockHold(c, "hover", true, 5000);
    expect(c.remaining).toBe(9000);
  });
});
