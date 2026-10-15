import { describe, it, expect, vi } from "vitest";
// PL-Z (a2#4): el provider de Plataforma monta el `StepUpProvider`, que trae la server action `getStepUpOptions`.
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [BO3-D] /plataforma/usuarios — render del directorio, del detalle y del Modal de superadmin con props reales.
 * Sin jsdom: `renderToStaticMarkup`. Se mockean las actions (no hay DB en unit), el router, el toast y el
 * confirm; nunca los componentes bajo test.
 */
vi.mock("@/lib/platform-users", () => ({
  sendPlatformAccessLink: vi.fn(),
  setPlatformUserDisabled: vi.fn(),
  setPlatformSuperadmin: vi.fn(),
  repairCreatePractitioner: vi.fn(),
  repairDeleteAuthOrphan: vi.fn(),
  repairSyncProfileEmail: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { UserList } from "@/components/plataforma/users/user-list";
import { UserDetailView } from "@/components/plataforma/users/user-detail";
import { SuperadminForm, CopyLinkBox } from "@/components/plataforma/users/user-actions";
import type { PlatformUserDetail, PlatformUserPage, PlatformUserRow } from "@/lib/platform-health-logic";

const row = (over: Partial<PlatformUserRow> = {}): PlatformUserRow => ({
  id: "u1",
  email: "ana@x.com",
  fullName: "Ana Pérez",
  kind: "team",
  isPlatformAdmin: false,
  disabled: false,
  membershipCount: 1,
  portalLinkCount: 0,
  createdAt: "2026-09-01T15:00:00.000Z",
  ...over,
});

const page = (rows: PlatformUserRow[], over: Partial<PlatformUserPage> = {}): PlatformUserPage => ({
  rows,
  total: rows.length,
  page: 1,
  pageSize: 25,
  authOnly: null,
  ...over,
});

const detail = (over: Partial<PlatformUserDetail> = {}): PlatformUserDetail => ({
  id: "u1",
  email: "ana@x.com",
  fullName: "Ana Pérez",
  kind: "team",
  isPlatformAdmin: false,
  disabled: false,
  disabledAt: null,
  disabledReason: null,
  createdAt: "2026-09-01T15:00:00.000Z",
  memberships: [
    {
      membershipId: "m1",
      tenantId: "t1",
      tenantName: "Movare",
      tenantSlug: "movare",
      tenantStatus: "ACTIVE",
      tenantVertical: "KINESIOLOGY",
      role: "PRACTITIONER",
      clinical: true,
      accepted: true,
      acceptedAt: "2026-09-02T15:00:00.000Z",
      suspended: false,
      hasPractitioner: true,
    },
  ],
  portalLinkCount: 0,
  auth: { status: "ok", email: "ana@x.com", emailConfirmed: true, lastSignInAt: "2026-10-15T02:30:00.000Z", banned: false, emailMismatch: false },
  ...over,
});

const q = { q: "", kind: "all" as const, page: 1 };

describe("[BO3-D] directorio de usuarios", () => {
  it("paciente de portal: solo «Paciente en N consultorios», sin links a consultorios", () => {
    const html = renderToStaticMarkup(
      <UserList page={page([row({ id: "p1", email: "pac@x.com", fullName: null, kind: "portal", membershipCount: 0, portalLinkCount: 2 })])} query={q} />
    );
    expect(html).toContain("Paciente en 2 consultorios");
    expect(html).toContain("Paciente de portal");
    expect(html).not.toContain("/plataforma/consultorios");
    expect(html).toContain('href="/plataforma/usuarios/p1"');
  });

  it("fila de equipo: tipo, conteo, superadmin y deshabilitado", () => {
    const html = renderToStaticMarkup(<UserList page={page([row({ isPlatformAdmin: true, disabled: true, membershipCount: 3 })])} query={q} />);
    expect(html).toContain("Equipo en 3 consultorios");
    expect(html).toContain("Superadmin");
    expect(html).toContain("Deshabilitado");
  });

  it("email exacto solo en Auth: tarjeta con «Borrar» si canDelete, sin botón si no", () => {
    const hit = { authUserId: "a1", email: "solo@x.com", emailConfirmed: false, lastSignInAt: null, createdAt: "2026-10-01T12:00:00.000Z", canDelete: true };
    const yes = renderToStaticMarkup(<UserList page={page([], { authOnly: hit })} query={{ ...q, q: "solo@x.com" }} />);
    expect(yes).toContain("Solo en Auth");
    expect(yes).toMatch(/<button[^>]*>Borrar<\/button>/);
    const no = renderToStaticMarkup(<UserList page={page([], { authOnly: { ...hit, canDelete: false } })} query={{ ...q, q: "solo@x.com" }} />);
    expect(no).toContain("Solo en Auth");
    expect(no).not.toMatch(/<button[^>]*>Borrar<\/button>/);
  });

  it("paginado con los filtros en la URL", () => {
    const html = renderToStaticMarkup(<UserList page={page([row()], { total: 60, page: 2 })} query={{ q: "ana", kind: "team", page: 2 }} />);
    expect(html).toContain("Página 2 de 3");
    expect(html).toContain('href="/plataforma/usuarios?q=ana&amp;kind=team"');
    expect(html).toContain('href="/plataforma/usuarios?q=ana&amp;kind=team&amp;page=3"');
  });
});

describe("[BO3-D] detalle de usuario", () => {
  it("membresías con link al consultorio y conteo de portal sin nombres", () => {
    const html = renderToStaticMarkup(<UserDetailView user={detail({ portalLinkCount: 2 })} actorId="admin" />);
    expect(html).toContain('href="/plataforma/consultorios/t1"');
    expect(html).toContain("Movare");
    expect(html).toContain("Paciente en 2 consultorios");
    // Último ingreso en hora AR (02:30 UTC del 15 = 23:30 del 14).
    expect(html).toMatch(/14.*oct.*2026.*23:30/);
  });

  it("uno mismo: «Deshabilitar» deshabilitado con el porqué", () => {
    const html = renderToStaticMarkup(<UserDetailView user={detail({ id: "admin" })} actorId="admin" />);
    expect(html).toContain("No podés deshabilitarte a vos mismo.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Deshabilitar<\/button>/);
  });

  it("email distinto ofrece sincronizar y bloquea el link de acceso", () => {
    const html = renderToStaticMarkup(
      <UserDetailView
        user={detail({ auth: { status: "ok", email: "nuevo@x.com", emailConfirmed: true, lastSignInAt: null, banned: false, emailMismatch: true } })}
        actorId="admin"
      />
    );
    expect(html).toContain("Sincronizar email con Auth");
    expect(html).toContain("Primero sincronizá el email.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Mandar link de acceso<\/button>/);
  });

  it("sin email distinto no ofrece sincronizar", () => {
    expect(renderToStaticMarkup(<UserDetailView user={detail()} actorId="admin" />)).not.toContain("Sincronizar email con Auth");
  });

  it("[PL-Z FX2] la 2FA de otro superadmin no se resetea desde acá: botón deshabilitado con el porqué", () => {
    const other = renderToStaticMarkup(<UserDetailView user={detail({ isPlatformAdmin: true })} actorId="admin" />);
    expect(other).toMatch(/<button[^>]*disabled=""[^>]*>Resetear verificación<\/button>/);
    expect(other).toContain("Es superadmin: su verificación la cambia esa persona desde Seguridad de la cuenta.");
    const plain = renderToStaticMarkup(<UserDetailView user={detail({ isPlatformAdmin: false })} actorId="admin" />);
    expect(plain).not.toMatch(/<button[^>]*disabled=""[^>]*>Resetear verificación<\/button>/);
    expect(plain).not.toContain("data-reset-other-admin");
  });
});

describe("[BO3-D] Modal de superadmin exige el email", () => {
  const props = { email: "ana@x.com", grant: true, busy: false, error: null, onCancel: () => {}, onConfirm: () => {} };

  it("vacío o distinto: confirmar deshabilitado", () => {
    expect(renderToStaticMarkup(<SuperadminForm {...props} />)).toMatch(/<button[^>]*disabled=""[^>]*data-testid="superadmin-confirm"/);
    expect(renderToStaticMarkup(<SuperadminForm {...props} initialTyped="ana@x.co" />)).toMatch(
      /<button[^>]*disabled=""[^>]*data-testid="superadmin-confirm"/
    );
  });

  it("email exacto (sin importar mayúsculas): confirmar habilitado", () => {
    const html = renderToStaticMarkup(<SuperadminForm {...props} initialTyped="ANA@x.com" />);
    expect(html).toMatch(/<button[^>]*data-testid="superadmin-confirm"[^>]*>Dar acceso<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-testid="superadmin-confirm"/);
  });

  it("muestra el error del server", () => {
    expect(renderToStaticMarkup(<SuperadminForm {...props} grant={false} error="Es el último superadmin activo" />)).toContain(
      "Es el último superadmin activo"
    );
  });

  it("caja de link copiable", () => {
    const html = renderToStaticMarkup(<CopyLinkBox url="https://kinesoft.test/auth/confirm?x=1" />);
    expect(html).toContain('value="https://kinesoft.test/auth/confirm?x=1"');
    expect(html).toContain("Copiar");
  });
});
