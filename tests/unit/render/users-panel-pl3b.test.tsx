import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// [PL-3b] Configuración → Usuarios y Profesionales: rótulos de rol (Titular / Titular sin agenda / …), «Atiendo
// pacientes» solo en la fila propia del Titular, permisos delegados SOLO para el Titular, cupos, copy de «¿Atiende?»
// al invitar y el switch «Aparece en el turnero online» deshabilitado con el turnero del consultorio apagado.
// Render real sin jsdom; se mockean solo las server actions (DB) y los hooks de navegación/confirmación.
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
vi.mock("@/lib/two-factor", () => proxy());
vi.mock("@/lib/practitioner-public", () => proxy());
// Los editores de la ficha del profesional (Horarios, Servicios, Coberturas) importan sus server actions.
vi.mock("@/lib/practitioner-schedule", () => proxy());
vi.mock("@/lib/practitioner-services", () => proxy());
vi.mock("@/lib/practitioner-payers", () => proxy());

import type { ReactElement } from "react";
import type { TenantVertical } from "@prisma/client";
import { UsersPanel, inviteAttendsCopy, memberRoleLabel, transferConfirmMatches } from "@/components/configuracion/panels/users-panel";
import { PractitionerPanel } from "@/components/configuracion/panels/practitioners/practitioner-panel";
import { TURNERO_OFF_HINT, publicBookingHint } from "@/components/configuracion/panels/practitioners/public-booking-switch";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { modulesFor } from "@/lib/tenant-modules";
import type { TeamMemberRow } from "@/lib/invitations-types";
import type { TenantPlanUsageView } from "@/lib/tenant-plan-usage-logic";

const member = (p: Partial<TeamMemberRow> & Pick<TeamMemberRow, "membershipId" | "fullName" | "role">): TeamMemberRow => ({
  userId: `u-${p.membershipId}`,
  email: `${p.membershipId}@test.local`,
  specialty: null,
  joinedAt: new Date("2026-10-01T12:00:00Z"),
  clinical: p.role === "PRACTITIONER" || p.role === "OWNER",
  grantSettings: false,
  grantBilling: false,
  disabledReason: null,
  isYou: false,
  disabledAt: null,
  hasAgenda: p.role === "PRACTITIONER" || p.role === "OWNER",
  practitionerId: p.role === "PRACTITIONER" || p.role === "OWNER" ? `pr-${p.membershipId}` : null,
  publicBookingEnabled: true,
  lastPasswordResetEmail: null,
  ...p,
});

const TEAM: TeamMemberRow[] = [
  member({ membershipId: "own", fullName: "Titular Uno", role: "OWNER", isYou: true }),
  member({ membershipId: "adm", fullName: "Admin Dos", role: "ADMIN", clinical: false, grantSettings: true }),
  member({ membershipId: "kin", fullName: "Kine Tres", role: "PRACTITIONER" }),
  member({ membershipId: "sec", fullName: "Secre Cuatro", role: "ASSISTANT", grantBilling: true }),
  member({ membershipId: "fac", fullName: "Fact Cinco", role: "BILLING" }),
];

function inTenant(ui: ReactElement, opts: { vertical?: TenantVertical; turnero?: boolean } = {}) {
  const vertical = opts.vertical ?? "GENERAL";
  const modules = modulesFor({ vertical, plan: "CLINICA", publicBookingEnabled: opts.turnero ?? true });
  return renderToStaticMarkup(
    <TenantModulesProvider modules={[...modules]} vertical={vertical}>
      {ui}
    </TenantModulesProvider>
  );
}

const SEATS: TenantPlanUsageView["seats"] = {
  value: "Profesionales 2 · Secretaría 3 · Total 5 de 5",
  used: 5,
  limit: 5,
  full: true,
  custom: false,
  detail: "No quedan lugares libres: para sumar a alguien, liberá un lugar o cambiá de plan.",
  lines: [],
  byKind: {
    total: { used: 5, limit: 5, remaining: 0, full: true },
    professional: { used: 2, limit: null, remaining: null, full: false },
    staff: { used: 3, limit: null, remaining: null, full: false },
  },
};

describe("[PL-3b] Usuarios · rótulos", () => {
  it("Titular / Titular (sin agenda) / Administrador/a / Profesional / Secretario/a / Facturación", () => {
    expect(memberRoleLabel({ role: "OWNER", clinical: true }, "GENERAL")).toBe("Titular");
    expect(memberRoleLabel({ role: "OWNER", clinical: false }, "GENERAL")).toBe("Titular (sin agenda)");
    expect(memberRoleLabel({ role: "ADMIN", clinical: false }, "GENERAL")).toBe("Administrador/a");
    expect(memberRoleLabel({ role: "PRACTITIONER", clinical: true }, "GENERAL")).toBe("Profesional");
    expect(memberRoleLabel({ role: "ASSISTANT", clinical: false }, "GENERAL")).toBe("Secretario/a");
    expect(memberRoleLabel({ role: "BILLING", clinical: false }, "GENERAL")).toBe("Facturación");

    const html = inTenant(<UsersPanel team={TEAM} pending={[]} viewerRole="OWNER" />);
    expect(html).toContain(">Titular<");
    const noAgenda = TEAM.map((m) => (m.role === "OWNER" ? { ...m, clinical: false, practitionerId: null } : m));
    expect(inTenant(<UsersPanel team={noAgenda} pending={[]} viewerRole="OWNER" />)).toContain("Titular (sin agenda)");
  });

  it("el selector de rol nunca ofrece «Titular» (se transfiere aparte) y la fila del Titular no tiene selector", () => {
    const html = inTenant(<UsersPanel team={TEAM} pending={[]} viewerRole="OWNER" />);
    expect(html).not.toContain('aria-label="Rol de Titular Uno"');
    expect(html).toContain('aria-label="Rol de Kine Tres"');
    expect(html).not.toMatch(/<option value="OWNER"/);
  });
});

describe("[PL-3b] Usuarios · lo que solo ve el Titular", () => {
  it("Titular: permisos delegados en cada miembro (no en el suyo) y su «Atiendo pacientes»", () => {
    const html = inTenant(<UsersPanel team={TEAM} pending={[]} viewerRole="OWNER" />);
    expect(html.match(/data-grants/g)).toHaveLength(4);
    expect(html).toContain("Puede cambiar la Configuración");
    expect(html).toContain("Puede ver y cambiar el plan y los pagos");
    expect(html.match(/data-attends/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Atiendo pacientes"');
  });

  it("Administrador/a (o quien tenga Configuración): no ve permisos, ni el «Atiendo» del Titular, ni puede transferir", () => {
    const team = TEAM.map((m) => ({ ...m, isYou: m.membershipId === "adm" }));
    const html = inTenant(<UsersPanel team={team} pending={[]} viewerRole="ADMIN" />);
    expect(html).not.toContain("data-grants");
    expect(html).not.toContain("Puede cambiar la Configuración");
    expect(html).not.toContain("data-attends");
    expect(html).not.toContain('aria-label="Acciones para Titular Uno"');
  });

  it("cupos: muestra el uso del plan y avisa cupo lleno", () => {
    const html = inTenant(<UsersPanel team={TEAM} pending={[]} viewerRole="OWNER" seats={SEATS} />);
    expect(html).toContain("Lugares: Profesionales 2 · Secretaría 3 · Total 5 de 5");
    expect(html).toContain("Cupo lleno");
  });

  it("transferir: hay que tipear el email del nuevo Titular", () => {
    expect(transferConfirmMatches(" KIN@test.local ", "kin@test.local")).toBe(true);
    expect(transferConfirmMatches("", "kin@test.local")).toBe(false);
    expect(transferConfirmMatches("otro@test.local", "kin@test.local")).toBe(false);
  });
});

describe("[PL-3b] invitar · el rol define si atiende", () => {
  it("Profesional atiende; Administrador/a, Secretaría y Facturación no", () => {
    expect(inviteAttendsCopy("PRACTITIONER")).toMatch(/^Atiende pacientes/);
    for (const r of ["ADMIN", "ASSISTANT", "BILLING"] as const) expect(inviteAttendsCopy(r)).toMatch(/^No atiende pacientes/);
    expect(inviteAttendsCopy("ADMIN")).toContain("Configuración");
  });

  it("[PL-Z M3] copy sin «lugar de profesional / no clínico» (el plan muestra un solo cupo)", () => {
    expect(inviteAttendsCopy("PRACTITIONER")).toBe("Atiende pacientes: tiene agenda propia y ocupa un lugar del plan.");
    const html = inTenant(<UsersPanel team={TEAM} pending={[]} viewerRole="OWNER" />);
    expect(html).toContain("Tenés agenda propia, ves historias clínicas y podés aparecer en el turnero online.");
    expect(html).not.toContain("lugar de profesional");
    expect(html).not.toContain("lugar no clínico");
  });

  it("[PL-Z M4] «⋯» de 44×44 y los permisos delegados con target de 44 px", () => {
    const html = inTenant(<UsersPanel team={TEAM} pending={[]} viewerRole="OWNER" />);
    const dots = html.match(/<button[^>]*aria-label="Acciones para [^"]+"[^>]*>/g) ?? [];
    expect(dots.length).toBeGreaterThan(0);
    for (const d of dots) expect(d).toMatch(/width:\s*44px;\s*height:\s*44px/);
    expect(html).not.toMatch(/min-height:\s*32px/);
  });
});

describe("[PL-3b] turnero por profesional", () => {
  it("con el turnero del consultorio apagado: switches deshabilitados con «Primero prendé el turnero del consultorio»", () => {
    const html = inTenant(<UsersPanel team={TEAM} pending={[]} viewerRole="OWNER" />, { turnero: false });
    // Quien atiende (Titular y Kine) tiene el switch; Admin, Secretaría y Facturación no.
    const switches = html.match(/aria-label="Aparece en el turnero online: [^"]+"/g) ?? [];
    expect(switches).toEqual([
      'aria-label="Aparece en el turnero online: Titular Uno"',
      'aria-label="Aparece en el turnero online: Kine Tres"',
    ]);
    expect(html).toMatch(/aria-checked="false" aria-label="Aparece en el turnero online: Kine Tres" disabled=""/);
    expect(html).toContain(TURNERO_OFF_HINT);
  });

  it("con el turnero prendido: switch activo y refleja el valor del profesional", () => {
    const team = TEAM.map((m) => (m.membershipId === "kin" ? { ...m, publicBookingEnabled: false } : m));
    const html = inTenant(<UsersPanel team={team} pending={[]} viewerRole="OWNER" />, { turnero: true });
    expect(html).toMatch(/aria-checked="true" aria-label="Aparece en el turnero online: Titular Uno"(?! disabled)/);
    expect(html).toMatch(/aria-checked="false" aria-label="Aparece en el turnero online: Kine Tres"(?! disabled)/);
    expect(html).not.toContain(TURNERO_OFF_HINT);
  });

  it("Profesionales: la ficha muestra el switch y, apagado el consultorio, lo deshabilita con el aviso", () => {
    const summary = [
      { practitionerId: "pr-kin", name: "Kine Tres", summary: "Lun-Vie 8-13", isFallback: false, rangeCount: 5, locationIds: [] },
    ];
    const off = inTenant(<PractitionerPanel summary={summary} locations={[]} team={TEAM} />, { turnero: false });
    expect(off).toMatch(/aria-label="Aparece en el turnero online: Kine Tres" disabled=""/);
    expect(off).toContain(TURNERO_OFF_HINT);
    const on = inTenant(<PractitionerPanel summary={summary} locations={[]} team={TEAM} />, { turnero: true });
    expect(on).toMatch(/aria-checked="true" aria-label="Aparece en el turnero online: Kine Tres"(?! disabled)/);
    // Sin el equipo (prop opcional hasta el handoff de Configuración) no se inventa un valor: no hay switch.
    expect(inTenant(<PractitionerPanel summary={summary} locations={[]} />)).not.toContain("Aparece en el turnero online");
  });

  it("copy puro", () => {
    expect(publicBookingHint(false, true)).toBe(TURNERO_OFF_HINT);
    expect(publicBookingHint(true, false)).toMatch(/^No aparece en el turnero/);
  });
});
