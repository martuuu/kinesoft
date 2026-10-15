import { describe, it, expect } from "vitest";
import type { PlatformHealthReport } from "@/lib/platform-health-logic";
import {
  HEALTH_DETECTORS,
  detectorCountLabel,
  detectorState,
  healthRows,
  healthSummary,
  sampleNote,
} from "@/components/plataforma/health/health-logic";

/** [BO3-D] Lógica pura de /plataforma/salud: estado de cada detector y qué acción se ofrece por fila. */
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

describe("[BO3-D] health-logic", () => {
  it("cubre los 8 detectores del reporte, sin repetir", () => {
    const keys = HEALTH_DETECTORS.map((d) => d.key).sort();
    const reportKeys = Object.keys(report()).filter((k) => k !== "generatedAt").sort();
    expect(keys).toEqual(reportKeys);
  });

  it("no disponible nunca es «Sin problemas» (falso verde)", () => {
    expect(detectorState(unavailable)).toBe("unavailable");
    expect(detectorCountLabel(unavailable)).toBe("No disponible");
    expect(detectorState(empty)).toBe("ok");
    expect(detectorCountLabel(empty)).toBe("Sin problemas");
    expect(detectorCountLabel({ available: true, count: 1, sample: [] })).toBe("1 caso");
    expect(detectorCountLabel({ available: true, count: 12, sample: [] })).toBe("12 casos");
  });

  it("nota de muestra recortada y resumen", () => {
    const d = { available: true as const, count: 37, sample: Array.from({ length: 10 }, (_, i) => i) };
    expect(sampleNote(d)).toBe("Mostramos los primeros 10 de 37.");
    expect(sampleNote(empty)).toBeNull();
    expect(healthSummary(report({ authOrphans: unavailable, emailMismatches: unavailable, stalledOnboarding: { available: true, count: 2, sample: [] } }))).toEqual({
      problems: 2,
      unavailable: 2,
    });
  });

  it("acción por detector", () => {
    const r = report({
      clinicalWithoutPractitioner: {
        available: true,
        count: 1,
        sample: [{ tenantId: "t1", tenantName: "Movare", userId: "u1", email: "k@x.com", role: "PRACTITIONER" }],
      },
      authOrphans: {
        available: true,
        count: 2,
        sample: [
          { authUserId: "a1", email: "o@x.com", createdAt: "2026-10-01T12:00:00.000Z", canDelete: true },
          { authUserId: "a2", email: "used@x.com", createdAt: "2026-10-01T12:00:00.000Z", canDelete: false },
        ],
      },
      emailMismatches: { available: true, count: 1, sample: [{ userId: "u2", profileEmail: "a@x.com", authEmail: "b@x.com" }] },
      tenantsWithoutOwner: { available: true, count: 1, sample: [{ tenantId: "t2", name: "Sin dueño", slug: "sd", status: "ACTIVE" }] },
      expiredInvitations: {
        available: true,
        count: 1,
        sample: [{ invitationId: "i1", tenantId: "t3", tenantName: "C3", email: "inv@x.com", role: "ASSISTANT", expiresAt: "2026-10-01T12:00:00.000Z" }],
      },
      stalledOnboarding: { available: true, count: 1, sample: [{ tenantId: "t4", name: "Trabado", slug: "tr", createdAt: "2026-09-01T12:00:00.000Z" }] },
    });
    expect(healthRows("clinicalWithoutPractitioner", r)[0].action).toEqual({ kind: "createPractitioner", tenantId: "t1", userId: "u1" });
    const orphans = healthRows("authOrphans", r);
    expect(orphans[0].action).toEqual({ kind: "deleteAuthOrphan", authUserId: "a1", email: "o@x.com" });
    expect(orphans[1].action.kind).toBe("none");
    expect(healthRows("emailMismatches", r)[0].action).toMatchObject({ kind: "syncEmail", userId: "u2" });
    expect(healthRows("tenantsWithoutOwner", r)[0].action).toEqual({ kind: "link", href: "/plataforma/consultorios/t2/equipo", label: "Ver equipo" });
    expect(healthRows("expiredInvitations", r)[0].action).toMatchObject({ kind: "link", href: "/plataforma/consultorios/t3" });
    expect(healthRows("stalledOnboarding", r)[0].action).toMatchObject({ kind: "link", href: "/plataforma/consultorios/t4" });
  });
});
