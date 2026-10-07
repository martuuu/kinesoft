/**
 * EV0 · EV-K — switch del turnero público desde Configuración
 * (`setPublicBookingEnabled`, `lib/tenant-settings.ts`).
 *
 * Por qué importa: el turnero nace apagado (EV-D2, opt-in) y el consultorio lo
 * prende desde Configuración. La columna `publicBookingEnabled` la escribe SOLO
 * `applyTenantEntitlementsInTx` (C-EV5) con `source: "tenant-settings"`; acá se
 * fija que la action real:
 *   - deja a OWNER y ADMIN cambiarlo, con audit `tenant.entitlements` en SU tenant;
 *   - rechaza a PRACTITIONER y ASSISTANT (Forbidden) sin escribir nada;
 *   - es idempotente: mismo valor → sin write, sin audit, sin revalidar caches;
 *   - no toca otro consultorio;
 *   - funciona bajo RLS (`test:integration` = kinesoft_app) y con BYPASSRLS
 *     (`:owner` = prod).
 * No hay CAS (sin `expectedUpdatedAt`): el switch es un booleano absoluto y el
 * último que guarda gana, igual que `setSharedPatientView`.
 *
 * Action REAL con la sesión mockeada (`asUser`); efecto observable leído con
 * una conexión owner aparte.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { setPublicBookingEnabled, getTenantSettings } from "@/lib/tenant-settings";
import { ForbiddenError } from "@/lib/session";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("setPublicBookingEnabled — turnero desde Configuración (EV-K)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  /** Otro consultorio: nunca se toca. */
  let B: EphemeralTenant;
  let adminA: { userId: string };
  let practA: { userId: string };
  let assistantA: { userId: string };

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { publicBookingEnabled: false, vertical: "KINESIOLOGY", plan: "PRO" });
    B = await createEphemeralTenant(db, { publicBookingEnabled: false });
    adminA = await addPractitioner(db, A, "ADMIN");
    practA = await addPractitioner(db, A, "PRACTITIONER");
    assistantA = await addPractitioner(db, A, "ASSISTANT");
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    revalidateTagSpy.mockClear();
  });

  const flag = async (tenantId: string) =>
    (await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { publicBookingEnabled: true } }))
      .publicBookingEnabled;
  const audits = (tenantId: string) =>
    db.auditEvent.findMany({
      where: { tenantId, action: "tenant.entitlements" },
      orderBy: { createdAt: "asc" },
    });

  it("getTenantSettings expone slug, vertical, plan y publicBookingEnabled", async () => {
    asUser(A.userId);
    const s = await getTenantSettings();
    expect(s).toMatchObject({
      slug: A.slug,
      vertical: "KINESIOLOGY",
      plan: "PRO",
      publicBookingEnabled: false,
    });
  });

  it("OWNER lo prende: fila en true, audit tenant.entitlements (tenant-settings) en A y caches revalidadas", async () => {
    asUser(A.userId);
    expect(await setPublicBookingEnabled(true)).toEqual({ ok: true, data: undefined });
    expect(await flag(A.tenantId)).toBe(true);

    const ev = await audits(A.tenantId);
    expect(ev).toHaveLength(1);
    expect(ev[0].actorId).toBe(A.userId);
    expect(ev[0].entityId).toBe(A.tenantId);
    expect(ev[0].payload).toMatchObject({
      source: "tenant-settings",
      changed: ["publicBookingEnabled"],
      before: { publicBookingEnabled: false },
      after: { publicBookingEnabled: true },
    });
    const tagged = revalidateTagSpy.mock.calls.map((c) => c[0]);
    for (const t of tenantEntitlementTags(A.tenantId)) expect(tagged).toContain(t);

    // B intacto.
    expect(await flag(B.tenantId)).toBe(false);
    expect(await audits(B.tenantId)).toHaveLength(0);
  });

  it("mismo valor otra vez → ok, sin audit nuevo y sin revalidar", async () => {
    asUser(A.userId);
    expect(await setPublicBookingEnabled(true)).toEqual({ ok: true, data: undefined });
    expect(await flag(A.tenantId)).toBe(true);
    expect(await audits(A.tenantId)).toHaveLength(1);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("ADMIN lo apaga: audit con su actorId", async () => {
    asUser(adminA.userId);
    expect(await setPublicBookingEnabled(false)).toEqual({ ok: true, data: undefined });
    expect(await flag(A.tenantId)).toBe(false);
    const ev = await audits(A.tenantId);
    expect(ev).toHaveLength(2);
    expect(ev[1].actorId).toBe(adminA.userId);
    expect(ev[1].payload).toMatchObject({ after: { publicBookingEnabled: false } });
  });

  it("PRACTITIONER y ASSISTANT → Forbidden, sin cambios ni audit", async () => {
    for (const u of [practA, assistantA]) {
      asUser(u.userId);
      await expect(setPublicBookingEnabled(true)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await flag(A.tenantId)).toBe(false);
    expect(await audits(A.tenantId)).toHaveLength(2);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("input que no es boolean → error de validación, nada escrito", async () => {
    asUser(A.userId);
    const r = await setPublicBookingEnabled("true" as unknown as boolean);
    expect(r.ok).toBe(false);
    expect(await flag(A.tenantId)).toBe(false);
    expect(await audits(A.tenantId)).toHaveLength(2);
  });
});
