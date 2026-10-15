import { describe, it, expect, vi } from "vitest";
// PL-Z (a2#4): el provider de Plataforma monta el `StepUpProvider`, que trae la server action `getStepUpOptions`.
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
import { renderToStaticMarkup } from "react-dom/server";

/** [BO3-D] /plataforma/salud — render del tablero con un reporte real (actions, router, toast y confirm mockeados). */
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

import { HealthBoard } from "@/components/plataforma/health/health-board";
import type { PlatformHealthReport } from "@/lib/platform-health-logic";

const empty = { available: true as const, count: 0, sample: [] };
const unavailable = { available: false as const, count: null, sample: [] as [] };

function report(over: Partial<PlatformHealthReport> = {}): PlatformHealthReport {
  return {
    generatedAt: "2026-10-14T15:00:00.000Z",
    authOrphans: empty,
    profilesWithoutAccess: empty,
    clinicalWithoutPractitioner: empty,
    practitionersWithoutMembership: empty,
    tenantsWithoutOwner: empty,
    expiredInvitations: empty,
    stalledOnboarding: empty,
    emailMismatches: empty,
    ...over,
  };
}

/** El fragmento de la Card de un detector. */
function card(html: string, key: string): string {
  const start = html.indexOf(`data-detector="${key}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf("data-detector=", start + 20);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("[BO3-D] Salud", () => {
  it("detector no disponible: «No disponible», nunca «Sin problemas»", () => {
    const html = renderToStaticMarkup(<HealthBoard report={report({ authOrphans: unavailable, emailMismatches: unavailable })} />);
    const c = card(html, "authOrphans");
    expect(c).toContain('data-state="unavailable"');
    expect(c).toContain("No disponible");
    expect(c).not.toContain("Sin problemas");
    expect(card(html, "tenantsWithoutOwner")).toContain("Sin problemas");
  });

  it("cada muestra con su acción", () => {
    const html = renderToStaticMarkup(
      <HealthBoard
        report={report({
          clinicalWithoutPractitioner: {
            available: true,
            count: 1,
            sample: [{ tenantId: "t1", tenantName: "Movare", userId: "u1", email: "k@x.com", role: "PRACTITIONER" }],
          },
          authOrphans: {
            available: true,
            count: 1,
            sample: [{ authUserId: "a1", email: "o@x.com", createdAt: "2026-10-01T12:00:00.000Z", canDelete: true }],
          },
          emailMismatches: { available: true, count: 1, sample: [{ userId: "u2", profileEmail: "a@x.com", authEmail: "b@x.com" }] },
          tenantsWithoutOwner: { available: true, count: 14, sample: [{ tenantId: "t2", name: "Sin dueño", slug: "sd", status: "ACTIVE" }] },
        })}
      />
    );
    expect(card(html, "clinicalWithoutPractitioner")).toMatch(/<button[^>]*>Crear profesional<\/button>/);
    expect(card(html, "authOrphans")).toMatch(/<button[^>]*>Borrar<\/button>/);
    expect(card(html, "emailMismatches")).toMatch(/<button[^>]*>Sincronizar email<\/button>/);
    const owner = card(html, "tenantsWithoutOwner");
    expect(owner).toContain('href="/plataforma/consultorios/t2/equipo"');
    expect(owner).toContain("14 casos");
    expect(owner).toContain("Mostramos los primeros 1 de 14.");
  });
});
