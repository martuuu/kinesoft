/** CF3 · SH-L: `WhatsAppIcon` decorativo, `currentColor` por defecto y verde de marca con `brand`. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatsAppIcon } from "@/components/ui/brand-icons";

describe("[CF3-SHL9] WhatsAppIcon", () => {
  it("aria-hidden, tamaño por prop y currentColor por defecto", () => {
    const html = renderToStaticMarkup(<WhatsAppIcon size={16} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width="16"');
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain("#25D366");
  });
  it("brand → verde de marca", () => {
    const html = renderToStaticMarkup(<WhatsAppIcon brand />);
    expect(html).toContain('width="20"');
    expect(html).toContain('fill="#25D366"');
  });
});
