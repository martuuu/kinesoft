/**
 * [MB-1f · C-MB3 Plataforma] Tablas de Plataforma → cards bajo 768 y filtros en Drawer «Filtros (n)»; pasada de
 * targets de 44 px en Planes / Biblioteca / Diagnóstico y `ModalCloseButton` a 44 px bajo 768.
 *
 * Vitest en `node` (sin jsdom, como el resto de `tests/unit/render`): markup real por SSR de las vistas reales + el CSS
 * real de los CSS Modules (sin comentarios). Las medidas vivas a 390 / 1366×695 las toma el revisor B con Playwright.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/platform-users", () => ({}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/plataforma/consultorios",
}));

import { TenantList } from "@/components/plataforma/tenants/tenant-list";
import { UserList } from "@/components/plataforma/users/user-list";
import { AuditView } from "@/components/plataforma/audit/audit-view";
import { AccountsList } from "@/components/plataforma/billing/accounts-list";
import { FiltersDrawer } from "@/components/plataforma/filters-drawer";
import { ModalCloseButton } from "@/components/ui/modal-close";
import type { PlatformTenantRow } from "@/lib/platform-tenants-types";
import type { PlatformAuditPage } from "@/lib/platform-audit-logic";

const css = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** Bloque de una media query (hasta la llave que la cierra). */
function media(src: string, query: string): string {
  const start = src.indexOf(`@media (${query})`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}
function allMedia(src: string, query: string): string {
  let out = "";
  let rest = src;
  for (;;) {
    const m = media(rest, query);
    if (!m) return out;
    out += m;
    rest = rest.slice(rest.indexOf(m) + m.length);
  }
}

const TABLE = css("components/plataforma/responsive-table.module.css");

const tenant = (over: Partial<PlatformTenantRow> = {}): PlatformTenantRow => ({
  id: "t1",
  name: "Movare",
  slug: "movare",
  vertical: "KINESIOLOGY",
  saasPlan: "INDIVIDUAL",
  subscriptionStatus: "ACTIVE",
  trialEndsOn: null,
  publicBookingEnabled: false,
  onboardingCompleted: true,
  ownerEmails: ["owner@movare.test"],
  ownerNames: ["Ana Pérez"],
  patientCount: 12,
  memberCount: 3,
  createdAt: "2026-09-01T15:00:00.000Z",
  isPlatformHome: false,
  status: "ACTIVE",
  statusReason: null,
  statusChangedAt: null,
  maxUsersOverride: null,
  maxProfessionalsOverride: null,
  maxStaffOverride: null,
  limits: { maxUsers: 1, maxProfessionals: 1, maxStaff: 1 },
  access: { mode: "full", reason: "active", daysLeft: null },
  effectiveAccessMode: "full",
  slugAliases: [],
  ...over,
});

describe("[MB-1f] tablas de Plataforma → cards bajo 768", () => {
  it("CSS: desde 768 la grilla usa --pt-cols/--pt-min-w; bajo 768 encabezado oculto, fila en 2 columnas con rótulos", () => {
    expect(TABLE).toMatch(/\.head,\s*\.row\s*\{[^}]*grid-template-columns:\s*var\(--pt-cols\)/);
    expect(TABLE).toMatch(/\.inner\s*\{[^}]*min-width:\s*var\(--pt-min-w, 0\)/);
    const mobile = allMedia(TABLE, "max-width: 767px");
    expect(mobile).toMatch(/\.head\s*\{\s*display:\s*none/);
    expect(mobile).toMatch(/\.inner\s*\{\s*min-width:\s*0/);
    expect(mobile).toMatch(/\.row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    expect(mobile).toMatch(/\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/);
    // La celda fija (sticky) es solo de escritorio: en la card no hay scroll de costado.
    expect(media(TABLE, "min-width: 768px")).toMatch(/\.sticky\s*\{[^}]*position:\s*sticky/);
    expect(mobile).not.toMatch(/position:\s*sticky/);
    // Filtros: en línea desde 768, botón bajo 768.
    expect(TABLE).toMatch(/\.filtersTrigger\s*\{\s*display:\s*none/);
    expect(mobile).toMatch(/\.filtersInline\s*\{\s*display:\s*none/);
    // Targets de 44 px en controles, chips y paginación.
    expect(mobile).toMatch(/\.chip\s*\{[^}]*min-height:\s*44px/);
    expect(mobile).toMatch(/\.tapScope :is\(button, select, input[^)]*\)[^{]*\{\s*min-height:\s*44px/);
  });

  it("consultorios: columnas como variables (no inline) y cada celda con su rótulo", () => {
    const html = renderToStaticMarkup(
      <TenantList
        page={{ rows: [tenant()], total: 1, page: 1, pageSize: 50 }}
        query={{ q: "mov", vertical: "", plan: "PRO", status: "", tenantStatus: "", page: 1 }}
      />
    );
    expect(html).toContain("--pt-cols:minmax(200px,1.6fr)");
    expect(html).toContain("--pt-min-w:1310px");
    expect(html).not.toContain("grid-template-columns:minmax(200px");
    for (const l of ["Estado", "Tipo", "Plan y cupo", "Suscripción", "Turnos online", "Onboarding", "Titular", "Pacientes"]) {
      expect(html).toContain(`data-label="${l}"`);
    }
    // Filtros: botón «Filtros (2)» (búsqueda + plan) que abre un diálogo; el Drawer no se monta cerrado.
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*>Filtros \(2\)<\/button>/);
    expect(html).not.toContain('role="dialog"');
    // Los filtros en línea siguen (escritorio): un solo form de búsqueda en el markup cerrado.
    expect(html.match(/role="search"/g)).toHaveLength(1);
  });

  it("usuarios, facturación y auditoría: misma grilla con rótulos", () => {
    const users = renderToStaticMarkup(
      <UserList
        page={{
          rows: [
            {
              id: "u1",
              email: "ana@x.com",
              fullName: "Ana",
              kind: "staff",
              membershipCount: 1,
              portalLinkCount: 0,
              isPlatformAdmin: false,
              disabled: false,
              tenants: [],
            } as never,
          ],
          total: 1,
          page: 1,
          pageSize: 50,
          authOnly: null,
        } as never}
        query={{ q: "", kind: "all", page: 1 } as never}
      />
    );
    expect(users).toContain("--pt-min-w:870px");
    for (const l of ["Tipo", "Consultorios", "Plataforma", "Estado"]) expect(users).toContain(`data-label="${l}"`);

    const accounts = renderToStaticMarkup(
      <AccountsList
        rows={[
          {
            tenantId: "t1",
            name: "Movare",
            slug: "movare",
            saasPlan: "PRO",
            subscriptionStatus: "ACTIVE",
            balanceCents: 0,
            openCharges: 0,
            overdueCharges: 0,
            nextChargeOn: null,
            lastPaymentAt: null,
            pendingReviews: 0,
            priceCents: 1000000,
            customPriceCents: null,
          } as never,
        ]}
        nextCursor={null}
        query={{ view: "all", plan: "", status: "ACTIVE", q: "", cursor: null } as never}
      />
    );
    expect(accounts).toContain("--pt-min-w:1060px");
    for (const l of ["Plan", "Precio", "Saldo", "Próximo cargo", "Último pago", "Estado"]) expect(accounts).toContain(`data-label="${l}"`);
    expect(accounts).toMatch(/>Filtros \(1\)<\/button>/);

    const page: PlatformAuditPage = {
      rows: [
        {
          id: "a1",
          createdAt: "2026-10-13T12:00:00.000Z",
          action: "platform.tenant.status",
          actorEmail: null,
          tenant: null,
          targetUserId: null,
          payload: [],
        } as never,
      ],
      nextCursor: null,
    };
    const audit = renderToStaticMarkup(<AuditView page={page} filters={{ from: "2026-10-01", to: "2026-10-10" }} />);
    expect(audit).toContain("--pt-min-w:960px");
    for (const l of ["Acción", "Quién", "Consultorio / usuario", "Qué cambió"]) expect(audit).toContain(`data-label="${l}"`);
    expect(audit).toMatch(/>Filtros \(2\)<\/button>/);
  });

  it("FiltersDrawer sin filtros: «Filtros» a secas; los hijos en línea", () => {
    const html = renderToStaticMarkup(
      <FiltersDrawer count={0}>
        <form data-x="" />
      </FiltersDrawer>
    );
    expect(html).toMatch(/>Filtros<\/button>/);
    expect(html.match(/data-x=""/g)).toHaveLength(1);
  });

  it("AutoSubmitSelect no aplica al cambiar dentro del Drawer (cerraría el Drawer con la navegación)", () => {
    const src = readFileSync(join(process.cwd(), "components/plataforma/tenants/auto-submit-select.tsx"), "utf8");
    expect(src).toContain("useInFiltersDrawer()");
    expect(src).toMatch(/if \(!inDrawer\) e\.currentTarget\.form\?\.requestSubmit\(\)/);
  });
});

describe("[MB-1f] targets de 44 px", () => {
  it("ModalCloseButton: 32×32 a 16 px en escritorio; 44×44 bajo 768", () => {
    const html = renderToStaticMarkup(<ModalCloseButton onClose={() => {}} />);
    expect(html).toMatch(/<button type="button" aria-label="Cerrar" class="[^"]+"/);
    expect(html).not.toContain("style=");
    const src = css("components/ui/modal-close.module.css");
    expect(src).toMatch(/\.close\s*\{[^}]*top:\s*16px;[^}]*right:\s*16px;[^}]*width:\s*32px;[^}]*height:\s*32px/);
    const mobile = media(src, "max-width: 767px");
    expect(mobile).toMatch(/width:\s*44px/);
    expect(mobile).toMatch(/height:\s*44px/);
  });

  it("Planes, Biblioteca y Diagnóstico: alcance de 44 px bajo 768 y sin 100vh suelto", () => {
    for (const f of ["components/planes/planes-mobile.module.css", "components/biblioteca/biblioteca.module.css"]) {
      const mobile = allMedia(css(f), "max-width: 767px");
      expect(mobile, f).toMatch(/\.tapScope :is\(button, select, a\[href\], input[^)]*\)[^{]*\{\s*min-height:\s*44px/);
      expect(mobile, f).toMatch(/\.tapScope button\s*\{\s*min-width:\s*44px/);
    }
    // La barra de selección de Biblioteca no tapa la barra inferior.
    expect(css("components/biblioteca/biblioteca.module.css")).toMatch(/\.actionBar\s*\{[^}]*bottom:\s*calc\(var\(--k-bottom-nav-h, 0px\) \+ 24px\)/);
    const diag = css("components/diagnostico/diagnostico.module.css");
    expect(diag).toMatch(/min-height:\s*calc\(100vh - 90px\);\s*min-height:\s*calc\(100dvh - 90px\)/);
    expect(readFileSync(join(process.cwd(), "components/screens/diagnostico-screen.tsx"), "utf8")).not.toContain("100vh");
  });
});
