import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, ButtonLink, buttonClassName } from "@/components/ui/button";
import { GoogleIcon, FacebookIcon } from "@/components/ui/brand-icons";
import { Tag } from "@/components/ui/tag";
import { KindTag } from "@/components/clinical-notes/kind-tag";

/** [VX F-b2] C-F5: ButtonLink = un solo `<a>` (fin de `<Link><Button/></Link>`), tamaños de C-F2, íconos de marca y Tag outline. */

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("[VX F-b2] Button / ButtonLink", () => {
  it("buttonClassName: sin size queda la base de siempre; size/block suman los modificadores de C-F2", () => {
    expect(buttonClassName()).toBe("k-btn k-btn-primary");
    expect(buttonClassName({ variant: "dark", size: "lg", block: true, className: "x" })).toBe(
      "k-btn k-btn-dark k-btn-lg k-btn-block x",
    );
  });

  it("Button sin props nuevas renderiza igual que antes de VX", () => {
    expect(render(<Button variant="ghost">Cancelar</Button>)).toBe('<button class="k-btn k-btn-ghost">Cancelar</button>');
  });

  it("ButtonLink es un único <a> con las clases del botón, sin <button> adentro", () => {
    const html = render(
      <ButtonLink href="/signup" variant="lime" size="md">
        Crear cuenta
      </ButtonLink>,
    );
    expect(html).toBe('<a class="k-btn k-btn-lime k-btn-md" href="/signup">Crear cuenta</a>');
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).not.toContain("<button");
  });
});

describe("[VX F-b2] íconos de marca", () => {
  it("Google (4 colores) y Facebook (#1877F2) son decorativos", () => {
    const g = render(<GoogleIcon />);
    expect(g).toContain('aria-hidden="true"');
    for (const c of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) expect(g).toContain(c);
    const f = render(<FacebookIcon size={24} />);
    expect(f).toContain('width="24"');
    expect(f).toContain('aria-hidden="true"');
    expect(f).toContain("#1877F2");
  });
});

describe("[VX F-b2] Tag outline (cierra ev2-kindtag-borde-inline)", () => {
  it("la variante outline suma el borde visible; fill queda como siempre", () => {
    expect(render(<Tag tone="soft">x</Tag>)).toBe('<span class="k-tag k-tag-soft">x</span>');
    expect(render(<Tag tone="soft" variant="outline">x</Tag>)).toBe(
      '<span class="k-tag k-tag-soft" style="border:1px solid var(--navy-200)">x</span>',
    );
  });

  it("KindTag usa Tag (Alta con outline, mismo markup que EV2-Z)", () => {
    expect(render(<KindTag kind="DISCHARGE" />)).toBe(
      '<span class="k-tag k-tag-soft" style="border:1px solid var(--navy-200)">Alta</span>',
    );
    expect(render(<KindTag kind="EVOLUTION" />)).toBe('<span class="k-tag k-tag-sky">Evolución</span>');
  });
});
