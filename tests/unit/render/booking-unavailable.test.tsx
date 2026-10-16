import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [EV0-fix] `/c/[slug]/booking` con los turnos online apagados. Se monta el
 * componente real (server component sin estado, sin mocks): con contacto
 * publicado muestra los canales con su link; sin contacto no promete un canal
 * que no existe.
 * [VX2-d2] Ahora va en el marco del turnero (`BookingFrame`): marca del
 * consultorio arriba, una sola h1, `<main id="main">`, estilos en CSS Module.
 */
import { BookingUnavailable, clinicInitials } from "@/components/booking/booking-unavailable";

const render = (contact: Partial<Parameters<typeof BookingUnavailable>[0]["contact"]> = {}) =>
  renderToStaticMarkup(
    <BookingUnavailable
      contact={{ name: "Consultorio Norte", phone: null, whatsapp: null, email: null, ...contact }}
    />,
  );

const CSS = readFileSync(resolve(process.cwd(), "components/booking/booking-result.module.css"), "utf8");

describe("[EV0-fix] BookingUnavailable (render)", () => {
  it("con contacto: título, canales con link (WhatsApp en pestaña nueva) y copy de «escribiles»", () => {
    const html = render({
      whatsapp: "+54 9 11 5555-5555",
      phone: "011 4444-4444",
      email: "turnos.del.consultorio.con.un.nombre.largo@norte.test",
    });
    expect(html).toContain("Turnos online no disponibles");
    expect(html).toContain("Consultorio Norte no está tomando turnos online. Escribiles o llamalos");
    expect(html).toContain('href="https://wa.me/5491155555555"');
    expect(html).toMatch(/href="https:\/\/wa\.me\/[^"]+"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(html).toContain('href="tel:01144444444"');
    expect(html).toContain('href="mailto:turnos.del.consultorio.con.un.nombre.largo@norte.test"');
  });

  it("el email largo se parte en vez de cortarse con «…» (revisión EV0; ahora en el CSS Module)", () => {
    const channelValue = CSS.match(/\.channelValue\s*\{[^}]*\}/)?.[0] ?? "";
    expect(channelValue).toContain("overflow-wrap: anywhere");
    expect(channelValue).not.toMatch(/text-overflow:\s*ellipsis/);
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

  it("[VX2-d2] marco del turnero: marca del consultorio arriba, una h1, main#main, KineSoft en el pie", () => {
    const html = render();
    expect(html).toContain('data-surface="turnero"');
    expect(html).toMatch(/<header[^>]*>[\s\S]*>CN<\/span>[\s\S]*<p[^>]*>Consultorio Norte<\/p>[\s\S]*<\/header>/);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<main id="main"/);
    expect(html).toMatch(/<footer[^>]*>[\s\S]*Turnos online con[\s\S]*<\/footer>/);
    // Sin estilos inline de color/fondo en la card: tokens en el CSS Module.
    const main = html.match(/<main[\s\S]*<\/main>/)?.[0] ?? "";
    expect(main).not.toBe("");
    expect(main).not.toMatch(/style="[^"]*(background|color)/);
  });

  it("[VX2-d2] el CSS del marco usa tokens y no tiene blur (D-VX9)", () => {
    expect(CSS).toContain("var(--bg-public)");
    expect(CSS).not.toMatch(/filter:\s*blur|backdrop-filter/);
  });

  it("[VX2-d2] iniciales del monograma", () => {
    expect(clinicInitials("Consultorio Norte")).toBe("CN");
    expect(clinicInitials("kine")).toBe("K");
    expect(clinicInitials("Ñandú · Salud Integral")).toBe("ÑS");
    expect(clinicInitials("—")).toBe("");
  });
});
