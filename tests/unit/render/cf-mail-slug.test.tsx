import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF-G2] (§28 G · Mails): el slug queda en el link del portal y del turnero que reciben los pacientes. El consultorio
 * del cliente quedó dado de alta como «tmp» y eso viajaba en cada invitación. Aviso suave en el alta de Plataforma
 * (no bloquea). Render estático del form real; se mockea solo la action (no hay DB en unit), el router y el toast.
 */
vi.mock("@/lib/platform-provisioning", () => ({ createTenantWithOwner: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/plataforma/consultorios",
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { NewTenantForm, emptyNewTenantForm, isPlaceholderSlug } from "@/components/plataforma/tenants/new-tenant-drawer";

const WARN = "Ese slug queda en los links que reciben los pacientes. Elegí uno con el nombre del consultorio.";
const render = (slug: string, clinicName = "Consultorio Pérez") =>
  renderToStaticMarkup(
    <NewTenantForm
      form={{ ...emptyNewTenantForm(), clinicName, slug }}
      pending={false}
      error={null}
      fieldErrors={{}}
      onChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
    />
  );

describe("[CF-G2] aviso de slug de prueba en el alta de consultorio", () => {
  it("[CF-G2] slug «tmp» muestra el aviso; «consultorio-perez» no", () => {
    expect(render("tmp")).toContain(WARN);
    expect(render("consultorio-perez")).not.toContain(WARN);
  });

  it("[CF-G2] el derivado del nombre también avisa («Test» → test)", () => {
    expect(render("", "Test")).toContain(WARN);
  });

  it("[CF-G2] reglas: tmp|test|prueba|demo solos o seguidos de guion", () => {
    for (const s of ["tmp", "TEST", "prueba", "demo", "tmp-1", "demo-kine", " test "]) expect(isPlaceholderSlug(s)).toBe(true);
    for (const s of ["consultorio-perez", "testa", "demolicion", "kine-demo", "pruebas", ""]) expect(isPlaceholderSlug(s)).toBe(false);
  });

  it("[CF-G2] no bloquea: el botón de crear sigue habilitado", () => {
    const html = render("tmp");
    expect(html).toMatch(/<button[^>]*type="submit"(?![^>]*disabled)[^>]*>/);
  });
});
