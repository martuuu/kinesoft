/**
 * CF2 T-U3 (D-CF2-10) · bloque «¿Necesitás un turno antes?» del paso «Fecha y hora» del turnero
 * (`components/booking/wizard/slot-window-step.tsx`).
 *
 * `listPublicSlotWindow` manda `leadContact` solo cuando HOY hay lugar libre dentro de la anticipación (que el turnero
 * no deja reservar) y el profesional prendió el contacto con consentimiento. El wizard lo pinta tal cual: dos `<a>`
 * (WhatsApp y Llamar) con links ya armados por el server, y NUNCA horarios (el paciente coordina con el profesional).
 * Sin la clave, el markup tiene que quedar idéntico al de antes de CF2.
 *
 * Render estático (entorno node, sin jsdom) de la VISTA sin efectos (`SlotWindowView`), igual que
 * `slot-window-step.test.tsx`.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  listPublicSlotWindow: vi.fn(async () => ({ days: [], nextFrom: null, reachedEnd: true, skippedFrom: null })),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));

import * as Step from "@/components/booking/wizard/slot-window-step";
import type { PublicSlotWindow } from "@/lib/public-booking-types";

const slot = (date: string, time: string) => ({ iso: `${date}T${time}:00.000-03:00`, time, available: true, locationId: null });

const BASE: PublicSlotWindow = {
  days: [
    { date: "2026-11-04", status: "open", slots: [slot("2026-11-04", "09:00"), slot("2026-11-04", "09:30")] },
    { date: "2026-11-05", status: "full", slots: [] },
    { date: "2026-11-06", status: "open", slots: [slot("2026-11-06", "10:00")] },
  ],
  nextFrom: "2026-11-07",
  reachedEnd: false,
  skippedFrom: null,
  minLeadMinutes: 2880,
};

const CONTACT = {
  name: "Laura Gómez",
  waUrl: "https://wa.me/5491122334455?text=Hola%20Laura",
  telUrl: "tel:+5491122334455",
};

const noop = () => {};
function view(window: PublicSlotWindow) {
  const props: Step.SlotWindowViewProps = {
    status: "ready",
    window,
    notice: null,
    canPrev: false,
    jumpValue: "2026-11-02",
    today: "2026-11-02",
    slotISO: null,
    locations: [],
    locationId: null,
    onLocationChange: noop,
    onPrev: noop,
    onNext: noop,
    onJump: noop,
    onFirstAvailable: noop,
    onPick: noop,
    onLater: null,
    onRetry: noop,
  };
  return renderToStaticMarkup(<Step.SlotWindowView {...props} />);
}

/** El HTML del bloque (desde su `<section>` hasta el cierre), para afirmar sobre él solo. */
function block(html: string): string {
  const m = /<section[^>]*data-lead-contact[^>]*>[\s\S]*?<\/section>/.exec(html);
  return m ? m[0] : "";
}

describe("[CF2-TU3] bloque de contacto dentro de la anticipación", () => {
  it("[CF2-TU3-1] con leadContact: título, copy en voseo con la anticipación y el nombre", () => {
    const b = block(view({ ...BASE, leadContact: CONTACT }));
    expect(b).not.toBe("");
    expect(b).toMatch(/<h3[^>]*>¿Necesitás un turno antes\?<\/h3>/);
    expect(b).toContain(
      "Por el turnero se reserva con al menos 2 días de anticipación. Laura Gómez puede tener lugar antes: escribile o llamá para coordinar.",
    );
    // La sección se nombra con su título (región navegable con lector de pantalla).
    const labelled = /<section[^>]*aria-labelledby="([^"]+)"/.exec(b);
    expect(labelled).not.toBeNull();
    expect(b).toMatch(new RegExp(`<h3[^>]*id="${labelled![1]}"`));
  });

  it("[CF2-TU3-2] WhatsApp en otra pestaña con rel seguro y aria que lo avisa; Llamar con tel:", () => {
    const b = block(view({ ...BASE, leadContact: CONTACT }));
    const links = b.match(/<a [^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(links).toHaveLength(2);
    const [wa, tel] = links;
    expect(wa).toContain(`href="${CONTACT.waUrl}"`);
    expect(wa).toContain('target="_blank"');
    expect(wa).toContain('rel="noopener noreferrer"');
    expect(wa).toContain('aria-label="Escribir a Laura Gómez por WhatsApp (se abre en otra pestaña)"');
    expect(wa).toMatch(/>WhatsApp<\/a>$/);
    expect(tel).toContain(`href="${CONTACT.telUrl}"`);
    expect(tel).not.toContain("target=");
    // ZB-4: el link de llamada nombra a quién llama (el texto visible es solo «Llamar»).
    expect(tel).toContain('aria-label="Llamar a Laura Gómez"');
    expect(tel).toMatch(/>Llamar<\/a>$/);
    // 44 px y foco visible: aspecto de botón del design system (`.k-btn-md` = min-height 44, `:focus-visible` global).
    for (const a of links) expect(a).toMatch(/class="[^"]*\bk-btn\b[^"]*\bk-btn-md\b/);
  });

  it("[CF2-TU3-3] nunca muestra horarios (ni HH:MM ni «horario»)", () => {
    const b = block(view({ ...BASE, leadContact: CONTACT }));
    const text = b.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(text.toLowerCase()).not.toContain("horario");
  });

  it("[CF2-TU3-4] sin leadContact: el markup es el de siempre (sin bloque)", () => {
    const html = view(BASE);
    expect(block(html)).toBe("");
    expect(html).not.toContain("¿Necesitás un turno antes?");
    expect(html).not.toContain("wa.me");
    expect(html).not.toContain("tel:");
  });

  it("[CF2-TU3-5] el bloque va después del aviso de anticipación", () => {
    const html = view({ ...BASE, leadContact: CONTACT });
    const notice = html.indexOf("Los turnos online se piden con al menos 2 días de anticipación.");
    const lead = html.indexOf("¿Necesitás un turno antes?");
    expect(notice).toBeGreaterThan(-1);
    expect(lead).toBeGreaterThan(notice);
  });
});
