import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthShell } from "@/components/auth/auth-shell";

/**
 * [VX F-b1 · C-F4] AuthShell v2 (render sin jsdom, componente real). Se afirma lo observable del markup: children en
 * las 3 variantes, una sola h1 según `introAs`, el panel de producto como `<aside aria-label>` con el mock
 * `aria-hidden`, y nada de `filter: blur` (D-VX9) ni en el markup ni en los CSS Modules del shell.
 */
const CHILD = <p data-testid="child">Contenido de la card</p>;

const h1Count = (html: string) => (html.match(/<h1[\s>]/g) ?? []).length;

describe("[VX F-b1] AuthShell v2", () => {
  it("las 3 variantes renderizan children dentro de <main>", () => {
    for (const variant of ["product", "split", "centered"] as const) {
      const html = renderToStaticMarkup(
        <AuthShell variant={variant} eyebrow="E" heading="Título" blurb="Bajada">
          {CHILD}
        </AuthShell>,
      );
      expect(html, variant).toContain('data-testid="child"');
      expect(html, variant).toMatch(/<main id="main"[^>]*>[\s\S]*data-testid="child"[\s\S]*<\/main>/);
      expect(html, variant).toContain(`data-variant="${variant}"`);
      expect(html, variant).toContain("© 2026 KineSoft");
    }
  });

  it("default = split con la intro como h1 (VX-Z: el shim components/screens/auth-shell ya no existe)", () => {
    const html = renderToStaticMarkup(
      <AuthShell eyebrow="Acceso" heading="No podés entrar todavía." blurb="Motivo">
        {CHILD}
      </AuthShell>,
    );
    expect(html).toContain('data-variant="split"');
    expect(h1Count(html)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>No podés entrar todavía\.<\/h1>/);
    expect(html).toContain("Acceso");
    expect(html).toContain("Motivo");
  });

  it('introAs="p" no deja ninguna h1 en el shell', () => {
    const html = renderToStaticMarkup(
      <AuthShell eyebrow="Plan" heading="Empezá hoy con tu consultorio." blurb="Bajada" introAs="p">
        {CHILD}
      </AuthShell>,
    );
    expect(h1Count(html)).toBe(0);
    expect(html).toMatch(/<p[^>]*>Empezá hoy con tu consultorio\.<\/p>/);
  });

  it("product y centered ignoran la intro (la h1 va en la card)", () => {
    for (const variant of ["product", "centered"] as const) {
      const html = renderToStaticMarkup(
        <AuthShell variant={variant} eyebrow="EYEBROW-X" heading="HEADING-X" blurb="BLURB-X">
          {CHILD}
        </AuthShell>,
      );
      expect(h1Count(html), variant).toBe(0);
      expect(html, variant).not.toContain("HEADING-X");
      expect(html, variant).not.toContain("EYEBROW-X");
    }
  });

  it("product: <aside> con label y copy; el mock de agenda y la sala son aria-hidden", () => {
    const html = renderToStaticMarkup(<AuthShell variant="product">{CHILD}</AuthShell>);
    const aside = html.match(/<aside[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/aside>/);
    expect(aside).not.toBeNull();
    expect(aside![1].length).toBeGreaterThan(0);
    const inner = aside![2];
    expect(inner).toContain("Tu consultorio, ordenado de punta a punta.");
    expect(inner).toContain("Para kinesiología y para cualquier consultorio de salud.");
    // El mock (avatares con iniciales, estados) y la tarjeta flotante quedan fuera del árbol de accesibilidad.
    const hidden = inner.match(/<div[^>]*aria-hidden="true"[^>]*>/g) ?? [];
    expect(hidden.length).toBeGreaterThanOrEqual(2);
    expect(inner).toMatch(/aria-hidden="true"[^>]*>[\s\S]*Agenda[\s\S]*AL/);
    expect(inner).toMatch(/aria-hidden="true"[^>]*>[\s\S]*Sala de espera[\s\S]*Llamado[\s\S]*En sala/);
    // El form queda fuera del aside.
    expect(inner).not.toContain('data-testid="child"');
  });

  it("split: aside y topRight se pintan; footerLinks como links", () => {
    const html = renderToStaticMarkup(
      <AuthShell
        heading="H"
        introAs="p"
        aside={<ul data-testid="points" />}
        topRight={<a href="/login">Ingresá</a>}
        footerLinks={[{ label: "Volver al login", href: "/login" }]}
      >
        {CHILD}
      </AuthShell>,
    );
    expect(html).toContain('data-testid="points"');
    expect(html).toContain("Ingresá");
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>Volver al login<\/a>/);
  });

  it("sin filter: blur en el markup ni en los CSS Modules (D-VX9)", () => {
    for (const variant of ["product", "split", "centered"] as const) {
      const html = renderToStaticMarkup(
        <AuthShell variant={variant} heading="H">
          {CHILD}
        </AuthShell>,
      );
      expect(html, variant).not.toMatch(/blur\(/);
    }
    for (const f of ["auth-shell.module.css", "product-panel.module.css"]) {
      // Sin comentarios: los encabezados mencionan «sin filter: blur» como regla.
      const css = readFileSync(resolve(process.cwd(), "components/auth", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, f).not.toMatch(/filter\s*:\s*blur|backdrop-filter/);
    }
  });
});
