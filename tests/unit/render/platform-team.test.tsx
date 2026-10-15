import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [BO3-C] /plataforma/consultorios/[id]/equipo — render de las vistas reales con props (sin jsdom). Se mockean las
 * actions (no hay DB en unit), el router, el toast y el confirm; nunca los componentes bajo test.
 */
vi.mock("@/lib/platform-team", () => ({
  platformInviteTeamMember: vi.fn(),
  platformResendInvitation: vi.fn(),
  platformRevokeInvitation: vi.fn(),
  platformChangeMemberRole: vi.fn(),
  platformTransferOwnership: vi.fn(),
  platformSuspendMember: vi.fn(),
  platformReactivateMember: vi.fn(),
  platformRemoveMember: vi.fn(),
  platformSendMemberPasswordReset: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { PlatformTeamPanel, MemberRow } from "@/components/plataforma/team/team-panel";
import { TransferOwnershipForm } from "@/components/plataforma/team/transfer-dialog";
import { InviteDrawerBody } from "@/components/plataforma/team/invite-drawer";
import type { PlatformTeamMemberRow, PlatformTenantTeam } from "@/lib/invitations-types";

const at = new Date("2026-09-01T15:00:00Z");
const member = (over: Partial<PlatformTeamMemberRow> = {}): PlatformTeamMemberRow => ({
  membershipId: "m1",
  userId: "u1",
  fullName: "Ana Dueña",
  email: "ana@movare.test",
  role: "OWNER",
  joinedAt: at,
  disabledAt: null,
  hasAgenda: true,
  ...over,
});
const owner = member();
const secretaria = member({
  membershipId: "m2",
  userId: "u2",
  fullName: "Sole Recepción",
  email: "sole@movare.test",
  role: "ASSISTANT",
  hasAgenda: false,
});
const team = (over: Partial<PlatformTenantTeam> = {}): PlatformTenantTeam => ({
  tenantId: "t1",
  members: [owner, secretaria],
  invitations: [
    {
      id: "i1",
      email: "nuevo@movare.test",
      firstName: "Nico",
      lastName: "Nuevo",
      role: "PRACTITIONER",
      status: "expired",
      invitedAt: at,
      expiresAt: new Date("2026-09-08T15:00:00Z"),
      lastSentAt: new Date("2026-09-02T01:30:00Z"),
      sendCount: 2,
      lastEmailStatus: "failed",
    },
  ],
  seats: {
    total: { used: 2, limit: 2, remaining: 0, full: true },
    professional: { used: 2, limit: null, remaining: null, full: false },
    staff: { used: 0, limit: null, remaining: null, full: false },
  },
  ...over,
});

/** El <li> de un miembro, por su data-attribute. */
function rowOf(html: string, membershipId: string): string {
  const start = html.indexOf(`data-member="${membershipId}"`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
}

describe("[BO3-C] PlatformTeamPanel", () => {
  it("cupos, miembros con rol / estado / agenda e invitación vencida con último envío y estado del mail", () => {
    const html = renderToStaticMarkup(<PlatformTeamPanel team={team()} vertical="KINESIOLOGY" />);
    expect(html).toContain("Total 2 de 2");
    expect(html).toContain("Cupo lleno");
    expect(html).toContain("cada uno en su tipo");
    expect(html).toContain("Ana Dueña");
    expect(html).toContain("ana@movare.test");
    expect(html).toContain("Titular");
    expect(html).toContain("Tiene agenda");
    expect(html).toContain("Sole Recepción");
    expect(html).toContain("Secretario/a");
    // Invitación: estado, rol por vertical, último envío en hora AR (01:30 UTC del 2 = 22:30 del 1), mail rechazado.
    expect(html).toContain("Nico Nuevo");
    expect(html).toContain("Vencida");
    expect(html).toContain("Kinesiólogo/a");
    expect(html).toContain("Último envío: 01/09/2026 22:30");
    expect(html).toContain("2 envíos");
    expect(html).toContain("Mail rechazado por el proveedor");
    expect(html).toContain("Venció el 08/09/2026");
    expect(html).toContain("Reenviar");
    expect(html).toContain("Anular");
  });

  it("vertical General: el profesional se llama «Profesional»", () => {
    const html = renderToStaticMarkup(<PlatformTeamPanel team={team()} vertical="GENERAL" />);
    expect(html).not.toContain("Kinesiólogo/a");
    expect(html).toContain("Profesional");
  });

  it("sin invitaciones no muestra la sección", () => {
    const html = renderToStaticMarkup(<PlatformTeamPanel team={team({ invitations: [] })} vertical="KINESIOLOGY" />);
    expect(html).not.toContain("Invitaciones sin aceptar");
  });
});

describe("[BO3-C] acciones del OWNER", () => {
  it("rol, suspender y quitar apagados con el porqué; sin transferir; el link de contraseña sí", () => {
    const html = renderToStaticMarkup(
      <ul>
        <MemberRow tenantId="t1" member={owner} owner={owner} vertical="KINESIOLOGY" />
      </ul>
    );
    const row = rowOf(html, "m1");
    expect(row).toMatch(/<select[^>]*disabled=""[^>]*aria-label="Rol de Ana Dueña"/);
    expect(row).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Suspender \(no disponible: [^"]*transferí la titularidad/);
    expect(row).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Quitar del equipo \(no disponible:/);
    expect(row).toContain('title="Es el titular del consultorio.');
    expect(row).not.toContain("Transferir titularidad");
    expect(row).toMatch(/<button type="button"(?![^>]*disabled="")[^>]*>Mandar link para cambiar la contraseña</);
    expect(row).toContain("primero transferí la titularidad");
    // El select muestra Titular pero no lo ofrece a nadie más.
    expect(row).toContain('<option value="OWNER" selected="">Titular</option>');
  });

  it("un miembro común tiene todo habilitado y el select no ofrece OWNER", () => {
    const html = renderToStaticMarkup(
      <ul>
        <MemberRow tenantId="t1" member={secretaria} owner={owner} vertical="KINESIOLOGY" />
      </ul>
    );
    const row = rowOf(html, "m2");
    expect(row).not.toMatch(/<select[^>]*disabled/);
    expect(row).not.toContain('value="OWNER"');
    expect(row).toMatch(/<button type="button"(?![^>]*disabled="")[^>]*>Transferir titularidad</);
    expect(row).toMatch(/<button type="button"(?![^>]*disabled="")[^>]*>Suspender</);
    expect(row).toMatch(/<button type="button"(?![^>]*disabled="")[^>]*>Quitar del equipo</);
  });

  it("suspendido: muestra Reactivar y apaga el link de contraseña", () => {
    const html = renderToStaticMarkup(
      <ul>
        <MemberRow tenantId="t1" member={{ ...secretaria, disabledAt: at }} owner={owner} vertical="KINESIOLOGY" />
      </ul>
    );
    const row = rowOf(html, "m2");
    expect(row).toContain("Suspendido");
    expect(row).toContain("Sin acceso desde el 01/09/2026");
    expect(row).toMatch(/>Reactivar</);
    expect(row).not.toMatch(/>Suspender</);
    expect(row).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Mandar link para cambiar la contraseña \(no disponible:/);
  });
});

describe("[BO3-C] transferir titularidad: confirmación tipeada", () => {
  const props = {
    member: secretaria,
    currentOwner: owner,
    vertical: "KINESIOLOGY" as const,
    onTypedChange: () => {},
    pending: false,
    onCancel: () => {},
    onConfirm: () => {},
  };
  it("sin el email tipeado, el botón está apagado y explica qué pasa con el dueño actual", () => {
    const html = renderToStaticMarkup(<TransferOwnershipForm {...props} typed="" />);
    expect(html).toContain("Para confirmar, escribí el email de Sole Recepción");
    // §20.17: el titular anterior que atiende queda como Profesional (no como Administrador/a, que nunca atiende).
    expect(html).toContain("Ana Dueña deja de ser titular y queda como Kinesiólogo/a (conserva su agenda), con «Configuración»");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Transferir titularidad</);
  });
  it("con otro email sigue apagado", () => {
    const html = renderToStaticMarkup(<TransferOwnershipForm {...props} typed="ana@movare.test" />);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Transferir titularidad</);
  });
  it("con el email del nuevo titular se habilita", () => {
    const html = renderToStaticMarkup(<TransferOwnershipForm {...props} typed="Sole@Movare.test" />);
    expect(html).toMatch(/<button[^>]*type="submit"(?![^>]*disabled="")[^>]*>Transferir titularidad</);
  });
});

describe("[BO3-C] Drawer de invitación", () => {
  const base = { open: true, onClose: () => {}, tenantId: "t1", vertical: "KINESIOLOGY" as const };
  it("formulario: email, nombre, apellido, rol (sin Titular) y aviso de cupo lleno para un profesional", () => {
    const html = renderToStaticMarkup(<InviteDrawerBody {...base} seatsFull />);
    expect(html).toContain("Invitar al equipo");
    expect(html).toContain('name="email"');
    expect(html).toContain('name="firstName"');
    expect(html).toContain('name="lastName"');
    expect(html).toContain("Secretario/a");
    expect(html).not.toContain(">Titular<");
    expect(html).toContain("El cupo de profesionales está lleno");
    expect(html).toContain("Mandar invitación");
  });
  it("sin cupo lleno no avisa", () => {
    const html = renderToStaticMarkup(<InviteDrawerBody {...base} seatsFull={false} />);
    expect(html).not.toContain("El cupo de profesionales está lleno");
  });
  it("si el mail no salió, muestra el link copiable", () => {
    const html = renderToStaticMarkup(
      <InviteDrawerBody
        {...base}
        seatsFull={false}
        initialResult={{
          id: "i9",
          url: "https://app.test/invite/tok",
          emailSent: false,
          transport: "log",
          emailStatus: "skipped",
          emailReason: "no_api_key",
        }}
      />
    );
    expect(html).toContain("https://app.test/invite/tok");
    expect(html).toContain("Copiar link");
    expect(html).toContain("Compartí el link a mano");
  });
  it("si el mail salió, no muestra el link", () => {
    const html = renderToStaticMarkup(
      <InviteDrawerBody
        {...base}
        seatsFull={false}
        initialResult={{
          id: "i9",
          url: "https://app.test/invite/tok",
          emailSent: true,
          transport: "resend",
          emailStatus: "sent",
          emailReason: null,
        }}
      />
    );
    expect(html).not.toContain("https://app.test/invite/tok");
    expect(html).toContain("Mandamos el mail de invitación.");
  });
});
