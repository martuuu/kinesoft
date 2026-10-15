import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// IAM-4c · panel de Usuarios: badge «Suspendido», menú de acciones por miembro (no en la fila propia ni en la del
// dueño para un ADMIN), estado del último link de contraseña y copy sin el «Compartí el link» engañoso. Render real
// sin jsdom; se mockean solo las server actions (DB) y los hooks de navegación/confirmación. Más los helpers puros
// de copy de `lib/invitations-constants.ts`.
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/invitations", () => proxy());
// PL-3b: el panel monta el step-up (`lib/two-factor`) y el switch del turnero (`lib/practitioner-public`): server actions.
vi.mock("@/lib/two-factor", () => proxy());
vi.mock("@/lib/practitioner-public", () => proxy());

import { UsersPanel } from "@/components/configuracion/panels/users-panel";
import type { InvitationRow, TeamMemberRow } from "@/lib/invitations-types";
import { passwordResetEmailStatusCopy, reassignBeforeRoleChangeCopy } from "@/lib/invitations-constants";

const member = (p: Partial<TeamMemberRow> & Pick<TeamMemberRow, "membershipId" | "fullName" | "role">): TeamMemberRow => ({
  userId: `u-${p.membershipId}`,
  email: `${p.membershipId}@test.local`,
  specialty: null,
  joinedAt: new Date("2026-10-01T12:00:00Z"),
  // PL-1c: «¿Atiende?» y permisos delegados (defaults de un profesional).
  clinical: p.role !== "ASSISTANT" && p.role !== "BILLING",
  grantSettings: p.role === "ADMIN",
  grantBilling: false,
  disabledReason: null,
  isYou: false,
  disabledAt: null,
  hasAgenda: true,
  practitionerId: p.role === "ASSISTANT" || p.role === "BILLING" ? null : `pr-${p.membershipId}`,
  publicBookingEnabled: true,
  lastPasswordResetEmail: null,
  ...p,
});

const TEAM: TeamMemberRow[] = [
  member({ membershipId: "own", fullName: "Dueña Uno", role: "OWNER" }),
  member({ membershipId: "adm", fullName: "Admin Dos", role: "ADMIN", isYou: true }),
  member({ membershipId: "kin", fullName: "Kine Tres", role: "PRACTITIONER", disabledAt: new Date("2026-10-10T15:00:00Z") }),
  member({
    membershipId: "sec",
    fullName: "Secre Cuatro",
    role: "ASSISTANT",
    hasAgenda: false,
    lastPasswordResetEmail: { status: "sent", transport: "resend", reason: null, at: new Date("2026-10-12T15:00:00Z") },
  }),
];

const PENDING: InvitationRow[] = [
  {
    id: "inv1",
    email: "nueva@test.local",
    firstName: "Nueva",
    lastName: "Persona",
    role: "PRACTITIONER",
    specialty: null,
    invitedAt: new Date("2026-10-10T12:00:00Z"),
    expiresAt: new Date("2026-10-17T12:00:00Z"),
    acceptedAt: null,
    url: null,
    status: "pending",
    lastSentAt: null,
    sendCount: 1,
    lastEmail: null,
  },
];

describe("[IAM-4c] UsersPanel · administración del equipo", () => {
  it("ADMIN: menú de acciones para los miembros, no para sí mismo ni para el dueño", () => {
    const html = renderToStaticMarkup(<UsersPanel team={TEAM} pending={PENDING} viewerRole="ADMIN" />);
    expect(html).toContain('aria-label="Acciones para Kine Tres"');
    expect(html).toContain('aria-label="Acciones para Secre Cuatro"');
    expect(html).not.toContain('aria-label="Acciones para Admin Dos"');
    expect(html).not.toContain('aria-label="Acciones para Dueña Uno"');
  });

  it("OWNER: puede mandarle el link a otro miembro; su fila propia no tiene menú", () => {
    const team = TEAM.map((m) => ({ ...m, isYou: m.membershipId === "own" }));
    const html = renderToStaticMarkup(<UsersPanel team={team} pending={[]} viewerRole="OWNER" />);
    expect(html).not.toContain('aria-label="Acciones para Dueña Uno"');
    expect(html).toContain('aria-label="Acciones para Admin Dos"');
  });

  it("muestra el badge «Suspendido» con la fecha (en hora AR) y el último link de contraseña enviado", () => {
    const html = renderToStaticMarkup(<UsersPanel team={TEAM} pending={PENDING} viewerRole="OWNER" />);
    expect(html.match(/Suspendido/g)).toHaveLength(1);
    expect(html).toContain("Sin acceso desde el 10/10/2026");
    expect(html).toContain("Link de contraseña enviado · 12/10/2026");
  });

  it("las pendientes ya no dicen «Compartí el link» (la lista nunca lo muestra)", () => {
    const html = renderToStaticMarkup(<UsersPanel team={TEAM} pending={PENDING} viewerRole="OWNER" />);
    expect(html).not.toContain("Compartí el link con el invitado");
    expect(html).toContain("Reenviar");
  });
});

describe("[IAM-4c] copy puro", () => {
  it("reassignBeforeRoleChangeCopy: solo lo que hay, con plural", () => {
    expect(reassignBeforeRoleChangeCopy(0, 0)).toBeNull();
    expect(reassignBeforeRoleChangeCopy(1, 0)).toContain("Reasigná sus 1 turno futuro antes de cambiarle el rol");
    expect(reassignBeforeRoleChangeCopy(0, 3)).toContain("Reasigná sus 3 pacientes asignados antes");
    expect(reassignBeforeRoleChangeCopy(2, 1)).toContain("2 turnos futuros y 1 paciente asignado");
  });

  it("passwordResetEmailStatusCopy: nunca ofrece compartir el link a mano", () => {
    for (const s of ["sent", "skipped", "failed", "blocked"] as const) {
      const c = passwordResetEmailStatusCopy(s, s === "skipped" ? "no_api_key" : null);
      expect(c.text).not.toMatch(/compart/i);
    }
    expect(passwordResetEmailStatusCopy("sent", null).tone).toBe("ok");
    expect(passwordResetEmailStatusCopy("skipped", "no_api_key").tone).toBe("warn");
    expect(passwordResetEmailStatusCopy("failed", "http_500").tone).toBe("error");
  });
});

describe("[PL-Z FX3 H4] cambiar el rol pasa por el step-up", () => {
  // Sin jsdom no hay click: se fija en la fuente que ninguna action de equipo que puede pedir step-up se llama
  // pelada (`await changeMemberRole(`). Antes pasar a Administrador/a devolvía el digest del step-up como error de la
  // fila en vez de abrir el modal. Se ignoran comentarios.
  it("`changeMemberRole` solo se invoca a través de `run`/`runStepUp`", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const code = readFileSync(join(__dirname, "..", "..", "..", "components/configuracion/panels/users-panel.tsx"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/await\s+changeMemberRole\(/);
    expect(code).toMatch(/run(StepUp)?\(\(\) => changeMemberRole\(/);
  });
});
