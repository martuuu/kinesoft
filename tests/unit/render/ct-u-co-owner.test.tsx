import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CT-U] CF3b (M23, decisión de Martin del 05-nov): «Co-titular» en la UI. Render real sin jsdom de los componentes de
 * Configuración → Usuarios, de la barra de pestañas y del equipo de Plataforma, por rol de quien mira (Titular principal,
 * co-titular, profesional común, Administrador/a, Secretaria). Se mockean solo las server actions (DB/red), el router y
 * el confirm; nunca los componentes ni la lógica bajo test.
 */
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
vi.mock("@/lib/platform-team", () => proxy());
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import type { ReactElement } from "react";
import type { Role } from "@prisma/client";
import { UsersPanel, memberRoleLabel } from "@/components/configuracion/panels/users-panel";
import {
  CO_OWNER_GRANTS_NOTE,
  CO_OWNER_HINT,
  CO_OWNER_ROLE_CHANGE_SUFFIX,
  CO_OWNER_ROW_LOCKED_REASON,
  CO_OWNER_VIEWER_NOTE,
  NO_LICENSE_COPY,
  OWNER_ROW_LOCKED_REASON,
  coOwnerConfirm,
  memberLicenseText,
  teamRowAccess,
} from "@/components/configuracion/panels/users-co-owner-logic";
import { TabsBar, visibleConfigTabs, type ConfigTabAccess } from "@/components/configuracion/controls";
import { MemberRow } from "@/components/plataforma/team/team-panel";
import { TenantChoiceProvider, TenantSwitcher } from "@/components/layout/tenant-switcher";
import type { TenantOption } from "@/lib/tenant-choice";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { modulesFor } from "@/lib/tenant-modules";
import { CO_OWNER_LABEL, roleLabelWithCoOwner, tenantOptionRoleLabel, type TeamMemberView } from "@/lib/co-owner-types";
import type { PlatformTeamMemberRow } from "@/lib/invitations-types";

const member = (p: Partial<TeamMemberView> & Pick<TeamMemberView, "membershipId" | "fullName" | "role">): TeamMemberView => ({
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
  grantCoOwner: false,
  ...p,
});

/** Equipo con todo lo que importa: un co-titular, profesionales con y sin matrícula, un invitado sin aceptar, un suspendido. */
const TEAM: TeamMemberView[] = [
  member({ membershipId: "own", fullName: "Titular Uno", role: "OWNER" }),
  member({ membershipId: "co", fullName: "Co Dos", role: "PRACTITIONER", grantCoOwner: true, license: { kind: "MP", number: "4567", jurisdiction: "X" } }),
  member({ membershipId: "kin", fullName: "Kine Tres", role: "PRACTITIONER", license: { kind: "MN", number: "12345", jurisdiction: null } }),
  member({ membershipId: "nolic", fullName: "Kine Cuatro", role: "PRACTITIONER", license: null }),
  member({ membershipId: "adm", fullName: "Admin Cinco", role: "ADMIN", clinical: false, grantSettings: true, hasAgenda: false, practitionerId: null }),
  member({ membershipId: "sec", fullName: "Secre Seis", role: "ASSISTANT" }),
  member({ membershipId: "inv", fullName: "Sin Aceptar", role: "PRACTITIONER", joinedAt: null }),
  member({ membershipId: "sus", fullName: "Susp Siete", role: "PRACTITIONER", disabledAt: new Date("2026-10-10T12:00:00Z") }),
];

/** El equipo visto por `viewerId` (su fila es la «(vos)»). Sin matrícula para quien no es el principal (el loader no la manda). */
function teamFor(viewerId: string, opts: { withLicense?: boolean } = {}): TeamMemberView[] {
  return TEAM.map((m) => ({
    ...m,
    isYou: m.membershipId === viewerId,
    ...(opts.withLicense === false ? { license: undefined } : {}),
  }));
}

function inTenant(ui: ReactElement) {
  const modules = modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] });
  return renderToStaticMarkup(
    <TenantModulesProvider modules={[...modules]} vertical="GENERAL">
      {ui}
    </TenantModulesProvider>
  );
}

const panel = (viewerId: string, viewerRole: Role, opts: { withLicense?: boolean; team?: TeamMemberView[] } = {}) =>
  inTenant(<UsersPanel team={opts.team ?? teamFor(viewerId, opts)} pending={[]} viewerRole={viewerRole} />);

/** Bloque `<li>` de la fila de un miembro (para afirmar qué tiene CADA fila, no la página entera). */
function row(html: string, membershipId: string): string {
  const start = html.indexOf(`data-member="${membershipId}"`);
  expect(start, `fila ${membershipId}`).toBeGreaterThan(-1);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end);
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("[CT-U-1] Titular principal", () => {
  const html = panel("own", "OWNER");

  it("[CT-U-1a] el switch «Co-titular» está solo en los profesionales activos (y en el co-titular, para sacárselo)", () => {
    expect(count(html, /data-co-owner-switch/g)).toBe(3);
    for (const id of ["co", "kin", "nolic"]) expect(row(html, id)).toContain("data-co-owner-switch");
    for (const id of ["own", "adm", "sec", "inv", "sus"]) expect(row(html, id)).not.toContain("data-co-owner-switch");
    expect(row(html, "kin")).toContain('aria-label="Co-titular: Kine Tres"');
    expect(row(html, "kin")).toMatch(/role="switch" aria-checked="false"/);
    expect(row(html, "co")).toMatch(/role="switch" aria-checked="true"/);
  });

  it("[CT-U-1b] explica qué tiene y muestra la matrícula (MN, MP con provincia) o «Sin matrícula cargada»", () => {
    expect(row(html, "kin")).toContain(CO_OWNER_HINT);
    expect(row(html, "kin")).toContain("MN 12345");
    expect(row(html, "co")).toContain("MP 4567 · Córdoba");
    expect(row(html, "nolic")).toContain(NO_LICENSE_COPY);
    // El hint se asocia al switch (lector de pantalla).
    const kin = row(html, "kin");
    const id = kin.match(/aria-label="Co-titular: Kine Tres" aria-describedby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(kin).toContain(`id="${id}"`);
  });

  it("[CT-U-1c] badge «Co-titular» en la fila y, en el co-titular, sin «Permisos» (ya tiene Configuración, nunca el plan)", () => {
    expect(count(html, /data-co-owner-badge/g)).toBe(1);
    expect(row(html, "co")).toContain(`>${CO_OWNER_LABEL}<`);
    expect(row(html, "co")).not.toContain("data-grants");
    expect(row(html, "co")).toContain(CO_OWNER_GRANTS_NOTE);
    // El resto sigue con sus permisos (incluido «Planes y pagos»): 6 = todos menos el Titular y el co-titular.
    expect(count(html, /data-grants/g)).toBe(6);
    expect(row(html, "kin")).toContain("Puede ver y cambiar el plan y los pagos");
    expect(html).not.toContain(OWNER_ROW_LOCKED_REASON);
    expect(html).not.toContain(CO_OWNER_VIEWER_NOTE);
  });
});

describe("[CT-U-2] co-titular", () => {
  const html = panel("co", "PRACTITIONER", { withLicense: false });

  it("[CT-U-2a] sin el switch «Co-titular» ni «Planes y pagos»; sí «Configuración» en los demás", () => {
    expect(html).not.toContain("data-co-owner-switch");
    expect(html).not.toContain(CO_OWNER_HINT);
    expect(html).not.toContain("Puede ver y cambiar el plan y los pagos");
    // Todos menos el Titular (bloqueado) y su propia fila.
    expect(count(html, /data-grants/g)).toBe(6);
    expect(row(html, "kin")).toContain("Puede cambiar la Configuración");
    expect(row(html, "co")).not.toContain("data-grants");
    expect(html).toContain(CO_OWNER_VIEWER_NOTE);
  });

  it("[CT-U-2b] la fila del Titular principal: sin menú, con el motivo", () => {
    const own = row(html, "own");
    expect(own).not.toContain('aria-label="Acciones para Titular Uno"');
    expect(own).toContain(OWNER_ROW_LOCKED_REASON);
    expect(html).not.toContain("data-attends");
    // Sí puede gestionar al resto (menú en un profesional común).
    expect(row(html, "kin")).toContain('aria-label="Acciones para Kine Tres"');
  });

  it("[CT-U-2c] otro co-titular: selector apagado y sin menú, con el motivo; la fila propia sin menú", () => {
    const team = [...teamFor("co", { withLicense: false }), member({ membershipId: "co2", fullName: "Co Ocho", role: "PRACTITIONER", grantCoOwner: true })];
    const h = panel("co", "PRACTITIONER", { team });
    const co2 = row(h, "co2");
    expect(co2).toContain(CO_OWNER_ROW_LOCKED_REASON);
    expect(co2).not.toContain('aria-label="Acciones para Co Ocho"');
    expect(co2).toMatch(/<select[^>]*disabled=""[^>]*aria-label="Rol de Co Ocho"/);
    expect(row(h, "co")).not.toContain('aria-label="Acciones para Co Dos"');
    expect(row(h, "co")).toContain(`>${CO_OWNER_LABEL}<`);
  });
});

describe("[CT-U-3] profesional común y Administrador/a (con Configuración)", () => {
  for (const [viewerId, viewerRole] of [["kin", "PRACTITIONER"], ["adm", "ADMIN"]] as const) {
    it(`[CT-U-3] ${viewerRole}: ve el badge, sin switch ni permisos; el Titular y el co-titular, bloqueados con motivo`, () => {
      const html = panel(viewerId, viewerRole, { withLicense: false });
      expect(html).not.toContain("data-co-owner-switch");
      expect(html).not.toContain("data-grants");
      expect(count(html, /data-co-owner-badge/g)).toBe(1);
      expect(row(html, "own")).toContain(OWNER_ROW_LOCKED_REASON);
      expect(row(html, "co")).toContain(CO_OWNER_ROW_LOCKED_REASON);
      expect(row(html, "co")).not.toContain('aria-label="Acciones para Co Dos"');
      expect(html).not.toContain(CO_OWNER_VIEWER_NOTE);
      expect(html).not.toContain("MN 12345");
    });
  }
});

describe("[CT-U-4] Secretaria", () => {
  it("[CT-U-4a] si llegara a montar Usuarios, no ve nada de «Co-titular» salvo el badge", () => {
    const html = panel("sec", "ASSISTANT", { withLicense: false });
    expect(html).not.toContain("data-co-owner-switch");
    expect(html).not.toContain("data-grants");
    expect(html).not.toContain(CO_OWNER_VIEWER_NOTE);
  });
});

describe("[CT-U-5] pestañas de Configuración por rol", () => {
  const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] }));
  const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);
  const PRINCIPAL: ConfigTabAccess = { tenantAdmin: true, billing: true, team: true, canExport: true, sensitive: true };
  const CO_OWNER: ConfigTabAccess = { tenantAdmin: true, billing: false, team: true, canExport: false, sensitive: true, coOwner: true };
  const COMMON: ConfigTabAccess = { tenantAdmin: false, billing: false, team: false, canExport: false };
  const SECRE: ConfigTabAccess = { tenantAdmin: true, billing: false, team: false, canExport: false, sensitive: false };

  it("[CT-U-5a] co-titular: lo del Titular (Usuarios y Exportar datos) sin «Plan y uso» ni «Facturación»", () => {
    const t = tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} access={CO_OWNER} modules={KINE} />));
    expect(t).toContain("Usuarios");
    expect(t).toContain("Exportar datos");
    expect(t).toContain("General");
    expect(t).not.toContain("Plan y uso");
    expect(t).not.toContain("Facturación");
  });

  it("[CT-U-5b] co-titular con «Planes y pagos» de antes: igual sin la suscripción (defensa en la UI)", () => {
    const v = visibleConfigTabs({ ...CO_OWNER, billing: true }, KINE);
    expect(v).not.toContain("plan");
    expect(v).not.toContain("facturacion");
    // `canExport` pisado por el TabsBar (BO-Z B6) no le saca «Exportar» al co-titular.
    const t = tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} access={CO_OWNER} canExport={false} modules={KINE} />));
    expect(t).toContain("Exportar datos");
  });

  it("[CT-U-5c] Titular principal: todo; profesional común y Secretaria: ni Usuarios, ni Exportar, ni el plan", () => {
    const p = visibleConfigTabs(PRINCIPAL, KINE);
    for (const k of ["usuarios", "plan", "facturacion", "exportar"] as const) expect(p).toContain(k);
    for (const a of [COMMON, SECRE]) {
      const v = visibleConfigTabs(a, KINE);
      for (const k of ["usuarios", "plan", "facturacion", "exportar"] as const) expect(v).not.toContain(k);
    }
  });
});

describe("[CT-U-6] reglas y copy (puro)", () => {
  const base = TEAM[2];
  const P = { principal: true, coOwner: false };
  const C = { principal: false, coOwner: true };
  const N = { principal: false, coOwner: false };

  it("[CT-U-6a] teamRowAccess por quien mira", () => {
    expect(teamRowAccess(base, { isOwnerRow: false, staff: false, viewer: P })).toEqual({
      coOwnerSwitch: true,
      lockedReason: null,
      grants: true,
      billingGrant: true,
    });
    expect(teamRowAccess(base, { isOwnerRow: false, staff: false, viewer: C })).toEqual({
      coOwnerSwitch: false,
      lockedReason: null,
      grants: true,
      billingGrant: false,
    });
    expect(teamRowAccess(base, { isOwnerRow: false, staff: false, viewer: N }).grants).toBe(false);
    expect(teamRowAccess(TEAM[0], { isOwnerRow: true, staff: false, viewer: C }).lockedReason).toBe(OWNER_ROW_LOCKED_REASON);
    // Solo un PROFESIONAL puede ser co-titular (CHECK de M23): ni el Administrador/a ni la Secretaria.
    expect(teamRowAccess(TEAM[4], { isOwnerRow: false, staff: false, viewer: P }).coOwnerSwitch).toBe(false);
    expect(teamRowAccess(TEAM[5], { isOwnerRow: false, staff: true, viewer: P }).coOwnerSwitch).toBe(false);
    // Suspendido: no se le da; si ya lo era, se le puede sacar.
    const sus = TEAM[7];
    expect(teamRowAccess(sus, { isOwnerRow: false, staff: false, viewer: P }).coOwnerSwitch).toBe(false);
    expect(teamRowAccess({ ...sus, grantCoOwner: true }, { isOwnerRow: false, staff: false, viewer: P }).coOwnerSwitch).toBe(true);
  });

  it("[CT-U-6b] confirmaciones: al prender, con la matrícula o «No cargó su matrícula»; al apagar, en rojo", () => {
    const on = coOwnerConfirm("Kine Tres", true, { kind: "MN", number: "12345", jurisdiction: null });
    expect(on.title).toBe("¿Hacer co-titular a Kine Tres?");
    expect(on.message).toContain("Matrícula: MN 12345.");
    expect(on.message).toContain("exportar todos los datos del consultorio");
    expect(on.tone).toBeUndefined();
    expect(coOwnerConfirm("Kine Cuatro", true, null).message).toContain("No cargó su matrícula.");
    const off = coOwnerConfirm("Co Dos", false, null);
    expect(off.tone).toBe("danger");
    expect(off.confirmLabel).toBe("Sacar co-titular");
  });

  it("[CT-U-6c] matrícula y rótulos", () => {
    expect(memberLicenseText(null)).toBeNull();
    expect(memberLicenseText({ kind: "MN", number: "12345", jurisdiction: null })).toBe("MN 12345");
    expect(memberLicenseText({ kind: "MP", number: "4567", jurisdiction: "B" })).toBe("MP 4567 · Buenos Aires");
    expect(roleLabelWithCoOwner("PRACTITIONER", "GENERAL", { coOwner: true })).toBe(CO_OWNER_LABEL);
    expect(roleLabelWithCoOwner("PRACTITIONER", "GENERAL")).toBe("Profesional");
    // Un rol que no es PRACTITIONER nunca se rotula co-titular (la base no lo deja; la UI tampoco lo inventa).
    expect(roleLabelWithCoOwner("OWNER", "GENERAL", { coOwner: true })).toBe("Titular");
    expect(memberRoleLabel({ role: "PRACTITIONER", clinical: true, grantCoOwner: true }, "GENERAL")).toBe(CO_OWNER_LABEL);
    expect(CO_OWNER_ROLE_CHANGE_SUFFIX).toContain("Deja de ser co-titular");
  });
});

describe("[CT-U-7] Plataforma: «Co-titular» en el equipo del consultorio (solo lectura)", () => {
  const at = new Date("2026-09-01T15:00:00Z");
  const pm = (over: Partial<PlatformTeamMemberRow>): PlatformTeamMemberRow => ({
    membershipId: "m3",
    userId: "u3",
    fullName: "Kine Co",
    email: "co@movare.test",
    role: "PRACTITIONER",
    joinedAt: at,
    disabledAt: null,
    hasAgenda: true,
    clinical: true,
    grantSettings: false,
    grantBilling: false,
    publicBookingEnabled: true,
    ...over,
  });

  it("[CT-U-7a] badge en el co-titular; no en un profesional común", () => {
    const co = renderToStaticMarkup(<MemberRow tenantId="t1" member={pm({ grantCoOwner: true })} owner={null} vertical="GENERAL" />);
    expect(co).toContain("data-co-owner-badge");
    expect(co).toContain(`>${CO_OWNER_LABEL}<`);
    const common = renderToStaticMarkup(<MemberRow tenantId="t1" member={pm({})} owner={null} vertical="GENERAL" />);
    expect(common).not.toContain("data-co-owner-badge");
  });
});

describe("[CT-U-8] selector de consultorio: «Co-titular» donde se muestra el rol", () => {
  // `coOwner` lo manda `lib/tenant-choice.ts` (handoff); el tipo de hoy no lo tiene, de ahí el cast del fixture.
  const opt = (over: Partial<TenantOption> & { coOwner?: boolean }) =>
    ({ tenantId: "t-a", name: "Consultorio Sur", slug: "sur", role: "PRACTITIONER", vertical: "GENERAL", ...over }) as TenantOption;
  // Con un solo consultorio el selector muestra solo el nombre; el rol aparece con 2+ (botón del activo).
  const other = opt({ tenantId: "t-b", name: "Kine Norte", role: "ASSISTANT" });
  const render = (o: TenantOption) =>
    renderToStaticMarkup(
      <TenantChoiceProvider options={[o, other]} activeTenantId={o.tenantId} switchTenant={async () => ({ ok: true as const, data: undefined })}>
        <TenantSwitcher />
      </TenantChoiceProvider>
    );

  it("[CT-U-8a] el botón del consultorio activo dice «Co-titular»; sin el flag, el rol de siempre", () => {
    expect(render(opt({ coOwner: true }))).toContain(`>${CO_OWNER_LABEL}<`);
    const common = render(opt({}));
    expect(common).toContain(">Profesional<");
    expect(common).not.toContain(CO_OWNER_LABEL);
    expect(tenantOptionRoleLabel({ role: "OWNER", vertical: "GENERAL", coOwner: true })).toBe("Titular");
  });
});
