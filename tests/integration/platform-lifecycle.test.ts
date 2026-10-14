/**
 * BO2-D · ciclo de vida del consultorio desde /plataforma (plan §19.5 fila BO2-D), contra Postgres real y con los
 * dos roles (`test:integration` = kinesoft_app; `:owner` = BYPASSRLS = prod). Las actions corren por el canal
 * service, así que el rol de DATABASE_URL no cambia su camino: lo que se prueba en los dos es que la barrera
 * (`requirePlatformAdmin`) y el CAS valen igual.
 *
 * Se fija:
 *   - un OWNER que no es superadmin rebota (Forbidden) en las 6 actions, sin cambios ni audit;
 *   - suspender / dar de baja exigen motivo; las transiciones válidas y las que no; reactivar limpia el motivo;
 *   - el audit doble (`AuditEvent` del consultorio + `PlatformAuditEvent`) en la MISMA tx; `statusReason` va como
 *     CLAVE, nunca el texto de la nota (handoff BO1-B);
 *   - la baja no borra nada (HC intacta, Ley 26.529);
 *   - CAS stale → sin cambios; strict → sin cambios;
 *   - editar nombre/razón social/CUIT/contacto (revisa EV-D6) y el núcleo compartido con Configuración;
 *   - forzar fin del alta (no-op si ya terminó);
 *   - el DTO del detalle/lista con estado, motivo, cupo, acceso calculado y alias (lista cerrada, sin PHI).
 *
 * Símbolos reales; solo se mockea la sesión de Supabase, `next/headers` y `next/cache` (integration-setup.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  suspendPlatformTenant,
  closePlatformTenant,
  reactivatePlatformTenant,
  updatePlatformTenantProfile,
  changePlatformTenantSlug,
  forcePlatformTenantOnboardingComplete,
} from "@/lib/platform-tenant-lifecycle";
import { getPlatformTenantDetail, listPlatformTenants } from "@/lib/platform-tenants-read";
import { updateTenantBasics } from "@/lib/tenant-settings";
import { ForbiddenError } from "@/lib/session";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { parseStatusReason, encodeStatusReason } from "@/lib/platform-tenants-schemas";
import { revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const STALE = "Otro cambio se guardó antes. Recargá y revisá.";
const PHI_MARK = "Zqxlifecyclephi";
const NOTE_MARK = "Notasecretadelsuperadmin";

describe("parseStatusReason / encodeStatusReason (puras)", () => {
  it("ida y vuelta, y tolerante con texto suelto", () => {
    expect(encodeStatusReason("NONPAYMENT", "  debe 3 meses ")).toBe("NONPAYMENT: debe 3 meses");
    expect(encodeStatusReason("TEST", "")).toBe("TEST");
    expect(parseStatusReason("NONPAYMENT: debe 3 meses")).toEqual({ code: "NONPAYMENT", note: "debe 3 meses" });
    expect(parseStatusReason("TEST")).toEqual({ code: "TEST", note: null });
    expect(parseStatusReason("escrito a mano")).toEqual({ code: null, note: "escrito a mano" });
    expect(parseStatusReason("FOO: bar")).toEqual({ code: null, note: "FOO: bar" });
    expect(parseStatusReason(null)).toBeNull();
    expect(parseStatusReason("  ")).toBeNull();
  });
});

describe.skipIf(!RUN)("BO2-D · ciclo de vida del consultorio", () => {
  let db: PrismaClient;
  /** Superadmin (su home). */
  let S: EphemeralTenant;
  /** OWNER sin superadmin. */
  let A: EphemeralTenant;
  /** Consultorio afectado. */
  let B: EphemeralTenant;
  let phiPatientId: string;

  const row = (id: string) =>
    db.tenant.findUniqueOrThrow({
      where: { id },
      select: {
        name: true,
        legalName: true,
        taxId: true,
        phone: true,
        whatsapp: true,
        publicEmail: true,
        slug: true,
        status: true,
        statusReason: true,
        statusChangedAt: true,
        onboardingCompletedAt: true,
        vertical: true,
        plan: true,
        updatedAt: true,
      },
    });
  const audits = (tenantId: string) =>
    db.auditEvent.findMany({
      where: { tenantId, action: { startsWith: "platform." } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  const globalAudits = (tenantId: string) =>
    db.platformAuditEvent.findMany({ where: { tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const v = async (id: string) => (await row(id)).updatedAt.toISOString();

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    phiPatientId = await addPatient(db, B, { firstName: PHI_MARK, lastName: PHI_MARK, notes: `${PHI_MARK} notas` });
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    revalidateTagSpy.mockClear();
    revalidatePathSpy.mockClear();
  });

  it("OWNER no superadmin: Forbidden en las 6 actions, sin cambios ni audit", async () => {
    const before = await row(B.tenantId);
    const expectedUpdatedAt = before.updatedAt.toISOString();
    asUser(A.userId);
    const calls: [string, () => Promise<unknown>][] = [
      ["suspend", () => suspendPlatformTenant({ tenantId: B.tenantId, expectedUpdatedAt, reasonCode: "ABUSE" })],
      ["close", () => closePlatformTenant({ tenantId: B.tenantId, expectedUpdatedAt, reasonCode: "ABUSE" })],
      ["reactivate", () => reactivatePlatformTenant({ tenantId: B.tenantId, expectedUpdatedAt })],
      ["profile", () => updatePlatformTenantProfile({ tenantId: B.tenantId, expectedUpdatedAt, name: "Hackeado" })],
      ["slug", () => changePlatformTenantSlug({ tenantId: B.tenantId, expectedUpdatedAt, slug: `hack-${uniqueSuffix()}` })],
      ["onboarding", () => forcePlatformTenantOnboardingComplete({ tenantId: B.tenantId, expectedUpdatedAt })],
    ];
    for (const [name, call] of calls) {
      const err = await call().then(
        () => null,
        (e) => e
      );
      expect(err, name).toBeInstanceOf(ForbiddenError);
    }
    expect(await row(B.tenantId)).toEqual(before);
    expect(await audits(B.tenantId)).toHaveLength(0);
    expect(await globalAudits(B.tenantId)).toHaveLength(0);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("suspender: motivo obligatorio; ACTIVE → SUSPENDED con motivo, fecha y audit doble con la CLAVE (sin la nota)", async () => {
    asUser(S.userId);
    // Sin motivo / motivo fuera de la lista / nota multilínea → inválido, sin cambios.
    for (const bad of [
      {},
      { reasonCode: "PORQUE_SI" },
      { reasonCode: "OTHER", note: "línea 1\nlínea 2" },
      { reasonCode: "OTHER", note: "x".repeat(201) },
    ]) {
      const r = await suspendPlatformTenant({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId), ...bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await row(B.tenantId)).status).toBe("ACTIVE");

    const res = await suspendPlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: await v(B.tenantId),
      reasonCode: "NONPAYMENT",
      note: `${NOTE_MARK} debe 3 meses`,
    });
    expect(res.ok).toBe(true);
    const after = await row(B.tenantId);
    expect(after.status).toBe("SUSPENDED");
    expect(after.statusReason).toBe(`NONPAYMENT: ${NOTE_MARK} debe 3 meses`);
    expect(after.statusChangedAt).not.toBeNull();
    if (res.ok) expect(res.data.updatedAt).toBe(after.updatedAt.toISOString());

    const local = await audits(B.tenantId);
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ actorId: S.userId, action: "platform.tenant.entitlements", entityId: B.tenantId });
    const payload = local[0].payload as { changed: string[]; before: Record<string, unknown>; after: Record<string, unknown> };
    expect([...payload.changed].sort()).toEqual(["status", "statusReason"]);
    expect(payload.after.status).toBe("SUSPENDED");
    expect(payload.after).not.toHaveProperty("statusReason");
    const global = await globalAudits(B.tenantId);
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({ action: "platform.tenant.entitlements", actorId: S.userId });
    // La nota libre nunca llega al registro (ni al del consultorio ni al global).
    expect(JSON.stringify({ local, global })).not.toContain(NOTE_MARK);
    expect(await audits(S.tenantId)).toHaveLength(0);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/plataforma", "layout");
  });

  it("transiciones inválidas: suspender un suspendido; CAS stale → sin cambios", async () => {
    asUser(S.userId);
    const before = await row(B.tenantId);
    const again = await suspendPlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      reasonCode: "ABUSE",
    });
    expect(again).toMatchObject({ ok: false, error: "Solo se puede suspender un consultorio activo." });
    const stale = await reactivatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: new Date(before.updatedAt.getTime() - 1).toISOString(),
    });
    expect(stale).toMatchObject({ ok: false, error: STALE });
    const missing = await reactivatePlatformTenant({
      tenantId: `no-existe-${uniqueSuffix()}`,
      expectedUpdatedAt: before.updatedAt.toISOString(),
    });
    expect(missing.ok).toBe(false);
    expect(await row(B.tenantId)).toEqual(before);
    expect(await audits(B.tenantId)).toHaveLength(1);
  });

  it("detalle y lista: estado, motivo parseado, acceso calculado y alias, con lista cerrada y sin PHI", async () => {
    asUser(S.userId);
    const d = await getPlatformTenantDetail(B.tenantId);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.status).toBe("SUSPENDED");
    expect(d.statusReason).toEqual({ code: "NONPAYMENT", note: `${NOTE_MARK} debe 3 meses` });
    expect(d.statusChangedAt).toBe((await row(B.tenantId)).statusChangedAt!.toISOString());
    expect(d.seatLimitOverride).toBeNull();
    expect(d.access).toEqual({ mode: "suspended", reason: "tenant_suspended", daysLeft: null });
    // Default `banner`: suspendido se respeta igual (desvío aceptado de BO1-A).
    expect(d.effectiveAccessMode).toBe("suspended");
    expect(d.slugAliases).toEqual([]);

    const page = await listPlatformTenants({ q: B.slug, tenantStatus: "SUSPENDED" });
    expect(page.rows.map((r) => r.id)).toEqual([B.tenantId]);
    expect((await listPlatformTenants({ q: B.slug, tenantStatus: "ACTIVE" })).total).toBe(0);
    expect(JSON.stringify({ d, page })).not.toContain(PHI_MARK);
  });

  it("reactivar: SUSPENDED → ACTIVE y limpia el motivo", async () => {
    asUser(S.userId);
    const res = await reactivatePlatformTenant({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId) });
    expect(res.ok).toBe(true);
    const after = await row(B.tenantId);
    expect(after).toMatchObject({ status: "ACTIVE", statusReason: null });
    const again = await reactivatePlatformTenant({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId) });
    expect(again).toMatchObject({ ok: false, error: "Ese consultorio ya está activo." });
  });

  it("dar de baja: CLOSED sin borrar nada (HC intacta); desde CLOSED no se suspende; se puede reactivar", async () => {
    asUser(S.userId);
    const patientsBefore = await db.patient.count({ where: { tenantId: B.tenantId } });
    const res = await closePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: await v(B.tenantId),
      reasonCode: "OWNER_REQUEST",
    });
    expect(res.ok).toBe(true);
    expect(await row(B.tenantId)).toMatchObject({ status: "CLOSED", statusReason: "OWNER_REQUEST" });
    expect(await db.patient.count({ where: { tenantId: B.tenantId } })).toBe(patientsBefore);
    const p = await db.patient.findUniqueOrThrow({ where: { id: phiPatientId } });
    expect(p.notes).toBe(`${PHI_MARK} notas`);

    const sus = await suspendPlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: await v(B.tenantId),
      reasonCode: "ABUSE",
    });
    expect(sus.ok).toBe(false);
    const closeAgain = await closePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: await v(B.tenantId),
      reasonCode: "OTHER",
    });
    expect(closeAgain).toMatchObject({ ok: false, error: "Ese consultorio ya está dado de baja." });

    const re = await reactivatePlatformTenant({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId) });
    expect(re.ok).toBe(true);
    expect((await row(B.tenantId)).status).toBe("ACTIVE");
  });

  it("editar datos: nombre, razón social, CUIT y contacto con CAS y audit `platform.tenant.profile` (claves)", async () => {
    asUser(S.userId);
    const n = (await audits(B.tenantId)).length;
    const res = await updatePlatformTenantProfile({
      tenantId: B.tenantId,
      expectedUpdatedAt: await v(B.tenantId),
      name: "  Consultorio Renombrado  ",
      legalName: "Razón Social SRL",
      taxId: "30-12345678-9",
      phone: "11 4000-1111",
      whatsapp: "+54 9 11 5000-2222",
      publicEmail: "TURNOS@Consultorio.test",
    });
    expect(res.ok).toBe(true);
    expect(await row(B.tenantId)).toMatchObject({
      name: "Consultorio Renombrado",
      legalName: "Razón Social SRL",
      taxId: "30-12345678-9",
      phone: "11 4000-1111",
      whatsapp: "+54 9 11 5000-2222",
      publicEmail: "turnos@consultorio.test",
    });
    const ev = (await audits(B.tenantId)).slice(n);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ action: "platform.tenant.profile", actorId: S.userId });
    expect([...(ev[0].payload as { changed: string[] }).changed].sort()).toEqual(
      ["legalName", "name", "phone", "publicEmail", "taxId", "whatsapp"].sort()
    );
    expect((await globalAudits(B.tenantId)).some((g) => g.action === "platform.tenant.profile")).toBe(true);

    // Borrar con "" / null; mismo valor = sin audit.
    const clear = await updatePlatformTenantProfile({
      tenantId: B.tenantId,
      expectedUpdatedAt: await v(B.tenantId),
      whatsapp: "",
      publicEmail: null,
      name: "Consultorio Renombrado",
    });
    expect(clear.ok).toBe(true);
    expect(await row(B.tenantId)).toMatchObject({ whatsapp: null, publicEmail: null, name: "Consultorio Renombrado" });
    const last = (await audits(B.tenantId)).at(-1)!;
    expect((last.payload as { changed: string[] }).changed.sort()).toEqual(["publicEmail", "whatsapp"]);

    const before = await row(B.tenantId);
    const noop = await updatePlatformTenantProfile({
      tenantId: B.tenantId,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      name: before.name,
    });
    expect(noop).toEqual({ ok: true, data: { updatedAt: before.updatedAt.toISOString() } });

    // Inválidos y strict: sin cambios.
    for (const bad of [
      { name: "" },
      { publicEmail: "no-es-mail" },
      { phone: "llamame" },
      { slug: "otro-slug" },
      { sharedPatientView: true },
      { vertical: "GENERAL" },
    ]) {
      const r = await updatePlatformTenantProfile({
        tenantId: B.tenantId,
        expectedUpdatedAt: before.updatedAt.toISOString(),
        ...bad,
      });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    const stale = await updatePlatformTenantProfile({
      tenantId: B.tenantId,
      expectedUpdatedAt: new Date(before.updatedAt.getTime() - 1).toISOString(),
      name: "Pisado",
    });
    expect(stale).toMatchObject({ ok: false, error: STALE });
    expect(await row(B.tenantId)).toEqual(before);
  });

  it("núcleo compartido con Configuración: updateTenantBasics con CAS opcional y sin audit si no cambia nada", async () => {
    asUser(B.userId);
    const before = await row(B.tenantId);
    const nBefore = await db.auditEvent.count({ where: { tenantId: B.tenantId, action: "tenant.update" } });

    // Sin cambios reales (el form manda los 3 campos siempre) → ni write ni audit.
    const same = await updateTenantBasics({ name: before.name, legalName: before.legalName, taxId: before.taxId });
    expect(same.ok).toBe(true);
    expect((await row(B.tenantId)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await db.auditEvent.count({ where: { tenantId: B.tenantId, action: "tenant.update" } })).toBe(nBefore);

    // CAS: el superadmin cambió algo en el medio → el OWNER con la versión vieja recibe el error.
    asUser(S.userId);
    await updatePlatformTenantProfile({ tenantId: B.tenantId, expectedUpdatedAt: before.updatedAt.toISOString(), taxId: "20-1" });
    asUser(B.userId);
    const stale = await updateTenantBasics({ name: "Del OWNER", expectedUpdatedAt: before.updatedAt.toISOString() });
    expect(stale).toMatchObject({ ok: false, error: STALE });
    expect((await row(B.tenantId)).name).toBe(before.name);

    const ok = await updateTenantBasics({ name: "Del OWNER", legalName: "", taxId: "20-1" });
    expect(ok.ok).toBe(true);
    expect(await row(B.tenantId)).toMatchObject({ name: "Del OWNER", legalName: null, taxId: "20-1" });
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: B.tenantId, action: "tenant.update" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(ev.actorId).toBe(B.userId);
    expect([...(ev.payload as { changed: string[] }).changed].sort()).toEqual(["legalName", "name"]);
    expect(await updateTenantBasics({ name: "   " })).toMatchObject({ ok: false });
  });

  it("forzar fin del alta: setea onboardingCompletedAt una vez; ya terminado = no-op sin audit", async () => {
    asUser(S.userId);
    await db.tenant.update({ where: { id: B.tenantId }, data: { onboardingCompletedAt: null } });
    const n = (await audits(B.tenantId)).length;
    const res = await forcePlatformTenantOnboardingComplete({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId) });
    expect(res.ok).toBe(true);
    const after = await row(B.tenantId);
    expect(after.onboardingCompletedAt).not.toBeNull();
    const ev = (await audits(B.tenantId)).slice(n);
    expect(ev.map((e) => e.action)).toEqual(["platform.tenant.onboarding_complete"]);

    const again = await forcePlatformTenantOnboardingComplete({
      tenantId: B.tenantId,
      expectedUpdatedAt: after.updatedAt.toISOString(),
    });
    expect(again).toEqual({ ok: true, data: { updatedAt: after.updatedAt.toISOString() } });
    expect((await row(B.tenantId)).onboardingCompletedAt?.getTime()).toBe(after.onboardingCompletedAt!.getTime());
    expect((await audits(B.tenantId)).length).toBe(n + 1);
  });

  it("rate limit por superadmin: la clave `tenant.status.update` corta al 11.º en la ventana", async () => {
    asUser(S.userId);
    // 10 intentos inválidos (zod) consumen el cupo igual: el rate limit va antes de parsear.
    for (let i = 0; i < 10; i++) await reactivatePlatformTenant({});
    const err = await reactivatePlatformTenant({}).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ForbiddenError);
  });
});
