import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessWall, accessWallTitle, ACCESS_WALL_PLANS_HREF } from "@/components/ui/access-wall";
import AppNotFound from "@/app/(app)/not-found";

/** [VX2-b2] D-VX20: copy del muro por capacidad (`canBuy` = `account.billing`) y el 404 dentro del workspace. */

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("[VX2-b2] AccessWall", () => {
  it("título «{Módulo} está en el plan {Plan}» con los nombres que ve el consultorio", () => {
    expect(accessWallTitle("salaEspera", "CLINICA")).toBe("Sala de espera está en el plan Clínica");
    expect(accessWallTitle("plantillas", "CONSULTORIO")).toBe("Plantillas de plan está en el plan Consultorio");
    // Sin nombre en «Plan y uso» → genérico, nunca la clave interna.
    expect(accessWallTitle("reportes", "CLINICA")).toBe("Este módulo está en el plan Clínica");
  });

  it("con `account.billing` → «Ver planes» a la pestaña Plan y uso, un solo h1", () => {
    const html = render(<AccessWall module="salaEspera" plan="CLINICA" canBuy />);
    expect(ACCESS_WALL_PLANS_HREF).toBe("/configuracion?tab=plan");
    expect(html).toContain('href="/configuracion?tab=plan"');
    expect(html).toContain(">Ver planes</a>");
    expect(html).not.toContain("Pedile a quien administra");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain("Sala de espera está en el plan Clínica");
    expect(html).not.toContain("<button");
  });

  it("sin `account.billing` → pedírselo a quien administra, sin link a planes", () => {
    const html = render(<AccessWall module="salaEspera" plan="CLINICA" canBuy={false} />);
    expect(html).toContain("Pedile a quien administra la cuenta que cambie de plan.");
    expect(html).not.toContain("/configuracion");
    expect(html).not.toContain("Ver planes");
    expect(html).toContain('href="/dashboard"');
  });
});

describe("[VX2-b2] 404 del workspace", () => {
  it("una h1, vuelta al inicio y sin datos del recurso", () => {
    const html = render(<AppNotFound />);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('href="/dashboard"');
  });
});
