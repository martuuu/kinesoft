/**
 * EV-C1 (EV0) — guards de módulo sobre el `getActor()` real.
 *
 * `Actor.entitlements` sale de la fila de tenant que `buildActor` ya lee
 * (C-EV3) y `lib/authz.ts` (C-EV4) decide con `modulesFor`. Solo se mockea la
 * sesión de Supabase (`asUser`) y las APIs de request de Next
 * (integration-setup); `cache()` de React es pass-through en vitest, así que
 * cada llamada vuelve a resolver el actor contra la base, igual que un request
 * nuevo en prod.
 *
 * Controles contra el falso verde: el mismo guard pasa en KINE, y un cambio de
 * vertical en la base se ve en la próxima resolución (no hay entitlements
 * congelados en otro lado).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getActor, ForbiddenError } from "@/lib/session";
import {
  assertModule,
  requireModule,
  getTenantModules,
  guardModuleSegment,
} from "@/lib/authz";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { getPatientEvaScores, recordEvaScore } from "@/lib/patients";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** `redirect()` de Next tira un error con `digest = "NEXT_REDIRECT;<tipo>;<url>;<status>"`. */
async function redirectTarget(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? "";
    throw e;
  }
}

describe.skipIf(!RUN)("EV-C1 · guards de módulo", () => {
  let db: PrismaClient;
  let G: EphemeralTenant;
  let K: EphemeralTenant;
  let KFree: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    KFree = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
  });

  afterAll(async () => {
    asAnonymous();
    await G?.cleanup();
    await K?.cleanup();
    await KFree?.cleanup();
    await db?.$disconnect();
  });

  it("getActor() trae entitlements desde la fila del tenant", async () => {
    asUser(G.userId);
    expect((await getActor()).entitlements).toEqual({
      vertical: "GENERAL",
      plan: "PRO",
      publicBookingEnabled: false,
    });
    asUser(K.userId);
    expect((await getActor()).entitlements).toEqual({
      vertical: "KINESIOLOGY",
      plan: "PRO",
      publicBookingEnabled: true,
    });
  });

  it("GENERAL → requireModule('planes') tira ForbiddenError con el copy del módulo", async () => {
    asUser(G.userId);
    const err = await requireModule("planes").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as Error).message).toBe(MODULE_DENIED_COPY.planes);
    // Mensaje propio del caller.
    await expect(requireModule("diagnostico", "No va")).rejects.toThrow("No va");
    // Lo común sí está.
    const actor = await requireModule("agenda");
    expect(actor.tenantId).toBe(G.tenantId);
    // El turnero está apagado en G.
    await expect(requireModule("turneroPublico")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("KINE PRO → requireModule('planes') devuelve el actor; FREE no tiene ejerciciosGlobales", async () => {
    asUser(K.userId);
    const actor = await requireModule("planes");
    expect(actor.tenantId).toBe(K.tenantId);
    expect(() => assertModule(actor, "ejerciciosGlobales")).not.toThrow();
    expect((await getTenantModules()).has("turneroPublico")).toBe(true);

    asUser(KFree.userId);
    const free = await getActor();
    expect(() => assertModule(free, "planes")).not.toThrow();
    expect(() => assertModule(free, "ejerciciosGlobales")).toThrow(ForbiddenError);
    expect(() => assertModule(free, "plantillas")).toThrow(MODULE_DENIED_COPY.plantillas);
  });

  it("getTenantModules(): GENERAL sin módulos Kine", async () => {
    asUser(G.userId);
    const m = await getTenantModules();
    expect(m.has("agenda")).toBe(true);
    expect(m.has("salaEspera")).toBe(true);
    for (const k of ["planes", "sesiones", "diagnostico", "ejercicios", "reportes"] as const)
      expect(m.has(k)).toBe(false);
  });

  it("cambiar la vertical en la base se ve en la próxima resolución", async () => {
    const T = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "STARTER" });
    try {
      asUser(T.userId);
      await expect(requireModule("planes")).resolves.toMatchObject({ tenantId: T.tenantId });
      await db.tenant.update({ where: { id: T.tenantId }, data: { vertical: "GENERAL" } });
      await expect(requireModule("planes")).rejects.toBeInstanceOf(ForbiddenError);
      await db.tenant.update({ where: { id: T.tenantId }, data: { vertical: "KINESIOLOGY" } });
      await expect(requireModule("planes")).resolves.toMatchObject({ tenantId: T.tenantId });
    } finally {
      await T.cleanup();
    }
  });

  it("[P3-S22b] EVA exige `evaluaciones`: GENERAL lee [] y no escribe; KINE sí", async () => {
    const gPatient = await addPatient(db, G);
    const kPatient = await addPatient(db, K);

    asUser(G.userId);
    const err = await recordEvaScore({ patientId: gPatient, value: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(await db.evaScore.count({ where: { patientId: gPatient } })).toBe(0);
    // Una EVA cargada por otro camino (p. ej. el tenant era Kine antes) no sale.
    await db.evaScore.create({ data: { patientId: gPatient, value: 7 } });
    expect(await getPatientEvaScores(gPatient)).toEqual([]);

    // Control contra el falso verde: el mismo camino en KINE escribe y lee.
    asUser(K.userId);
    const ok = await recordEvaScore({ patientId: kPatient, value: 4 });
    expect(ok.ok).toBe(true);
    expect((await getPatientEvaScores(kPatient)).map((e) => e.value)).toEqual([4]);
  });

  it("guardModuleSegment: GENERAL redirige a /dashboard; KINE pasa; sin sesión no-op", async () => {
    asUser(G.userId);
    expect(await redirectTarget(guardModuleSegment("diagnostico"))).toBe("/dashboard");
    expect(await redirectTarget(guardModuleSegment("agenda"))).toBeNull();

    asUser(K.userId);
    expect(await redirectTarget(guardModuleSegment("diagnostico"))).toBeNull();

    asAnonymous();
    expect(await redirectTarget(guardModuleSegment("diagnostico"))).toBeNull();
  });
});
