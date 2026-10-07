import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [EV0-fix] `/c/[slug]/booking` con los turnos online apagados. Se monta el
 * componente real (server component sin estado, sin mocks): con contacto
 * publicado muestra los canales con su link; sin contacto no promete un canal
 * que no existe.
 */
import { BookingUnavailable } from "@/components/booking/booking-unavailable";

const render = (contact: Partial<Parameters<typeof BookingUnavailable>[0]["contact"]> = {}) =>
  renderToStaticMarkup(
    <BookingUnavailable
      contact={{ name: "Movare", phone: null, whatsapp: null, email: null, ...contact }}
    />,
  );

describe("[EV0-fix] BookingUnavailable (render)", () => {
  it("con contacto: título, canales con link (WhatsApp en pestaña nueva) y copy de «escribiles»", () => {
    const html = render({
      whatsapp: "+54 9 11 5555-5555",
      phone: "011 4444-4444",
      email: "turnos.del.consultorio.con.un.nombre.largo@movare.test",
    });
    expect(html).toContain("Turnos online no disponibles");
    expect(html).toContain("Movare no está tomando turnos online. Escribiles o llamalos");
    expect(html).toContain('href="https://wa.me/5491155555555"');
    expect(html).toMatch(/href="https:\/\/wa\.me\/[^"]+"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(html).toContain('href="tel:01144444444"');
    expect(html).toContain('href="mailto:turnos.del.consultorio.con.un.nombre.largo@movare.test"');
    // El email largo se parte en vez de cortarse con "…" (revisión EV0).
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).not.toContain("text-overflow:ellipsis;white-space:nowrap;min-width:0");
  });

  it("sin contacto: sin lista de canales y sin prometer un canal", () => {
    const html = render();
    expect(html).toContain("Turnos online no disponibles");
    expect(html).toContain("Comunicate directamente con el consultorio");
    expect(html).not.toContain("Escribiles");
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("wa.me");
  });

  it("un WhatsApp sin dígitos no arma link", () => {
    const html = render({ whatsapp: "—" });
    expect(html).not.toContain("wa.me");
    expect(html).toContain("Comunicate directamente con el consultorio");
  });
});
