/**
 * [AS-1k1] C-AS1 en `lib/authz.ts`: `requireTenantSensitive` y el soporte en `memberCapabilitiesForActor`.
 *
 * Se mockea solo la sesión (de dónde sale el Actor) y la DB (`runWithRls`, que no se llega a usar: el Actor trae su
 * `membership`, el camino de prod desde PL-1e). `requireTenantSensitive`, `memberCapabilitiesForActor` y
 * `capabilitiesForMember` son los reales.
 *
 * Por qué el soporte: `memberCapabilitiesForActor` le daba al soporte `capabilitiesFor("ASSISTANT")` («vale como la
 * Secretaria» en las lecturas). Desde T3 la Secretaria trae `billing.collect` y `patients.editAdmin`; sin el filtro,
 * soporte heredaría el cobro y la edición de pacientes por la puerta de las lecturas (C-AS1: soporte sin `billing.*`
 * ni `editAdmin`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberAccess } from "@/lib/saas-plans-types";

const ref = vi.hoisted(() => ({ actor: null as unknown }));
vi.mock("@/lib/session", () => {
  class ForbiddenError extends Error {}
  return { ForbiddenError, getActor: async () => ref.actor };
});
// `cache` de React solo existe en el runtime de RSC; en node es identidad (cachea por request, acá no hay request).
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(f: T) => f }));
vi.mock("@/lib/rls", () => ({
  runWithRls: async () => {
    throw new Error("no debería leer la DB: el Actor trae membership");
  },
}));

import { memberCapabilitiesForActor, requireTenantSensitive } from "@/lib/authz";
import { ForbiddenError } from "@/lib/session";

const member = (role: MemberAccess["role"], o: Partial<MemberAccess> = {}) => ({
  tenantId: "t1",
  userId: "u1",
  practitionerId: null,
  support: null,
  membership: { role, clinical: true, grantSettings: false, grantBilling: false, ...o },
});

describe("[AS-1k1] requireTenantSensitive", () => {
  beforeEach(() => {
    ref.actor = null;
  });

  it("[AS-1k1] Titular, Admin con «Configuración» y profesional con «Configuración» pasan; devuelve el Actor", async () => {
    for (const a of [member("OWNER"), member("ADMIN", { grantSettings: true }), member("PRACTITIONER", { grantSettings: true })]) {
      ref.actor = a;
      await expect(requireTenantSensitive()).resolves.toBe(a);
    }
  });

  it("[AS-1k1] Secretaria y Facturación con «Configuración», Admin sin ella: ForbiddenError con el mensaje dado o el default", async () => {
    for (const a of [
      member("ASSISTANT", { grantSettings: true, grantBilling: true }),
      member("BILLING", { grantSettings: true }),
      member("ADMIN"),
      member("PRACTITIONER"),
    ]) {
      ref.actor = a;
      const err = await requireTenantSensitive("Mensaje propio.").catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.message).toBe("Mensaje propio.");
    }
    ref.actor = member("ASSISTANT", { grantSettings: true });
    await expect(requireTenantSensitive()).rejects.toThrow(
      "Solo el titular o el administrador (o un profesional con «Configuración») puede cambiar esto."
    );
  });

  it("[AS-1k1] soporte la tiene (SUPPORT_CAPS): su barrera de escritura es SUPPORT_WRITABLE_ACTIONS", async () => {
    ref.actor = { ...member("ASSISTANT"), membership: null, support: { sessionId: "s1" } };
    await expect(requireTenantSensitive()).resolves.toBe(ref.actor);
  });
});

describe("[AS-1k1] memberCapabilitiesForActor: soporte vale como la Secretaria, sin cobrar ni editar pacientes", () => {
  it("[AS-1k1] sin billing.* ni patients.editAdmin, y sin clínico", async () => {
    const caps = await memberCapabilitiesForActor({ ...member("ASSISTANT"), membership: null, support: { sessionId: "s1" } } as never);
    expect([...caps].filter((c) => c.startsWith("billing."))).toEqual([]);
    expect(caps.has("patients.editAdmin")).toBe(false);
    expect(caps.has("clinical.read")).toBe(false);
    expect(caps.has("agenda.operateAll")).toBe(true);
  });

  it("[AS-1k1] un miembro sigue siendo capabilitiesForMember (la Secretaria real sí cobra)", async () => {
    const caps = await memberCapabilitiesForActor(member("ASSISTANT") as never);
    expect(caps.has("billing.collect")).toBe(true);
    expect(caps.has("patients.editAdmin")).toBe(true);
  });
});
