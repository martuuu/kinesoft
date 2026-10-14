/**
 * Stepper de alta del consultorio (A3c-S-signup, 2026-09-30).
 *
 * - sin email verificado no hay tenant;
 * - el paso 2 crea Tenant + Practitioner + OWNER (aceptada) + "Particular" en
 *   una transacción, con el alta sin terminar (`onboardingCompletedAt` null);
 * - re-ejecutar el paso 2 EDITA: no duplica tenant, membresía ni Particular
 *   (tampoco con dos pedidos simultáneos);
 * - staff ≠ paciente: una identidad de portal no crea consultorio;
 * - el paso 7 exige al menos un servicio y es idempotente;
 * - la invitación pendiente se reabre solo para el email invitado;
 * - B5.5 ONB: flujo completo con Sede, Tu horario, práctica y prestadora del
 *   catálogo; el retome (`deriveResumeStep`) sale de datos reales; la sede es
 *   idempotente y se crea si falta; un tenant con el alta cerrada no ve el
 *   stepper.
 *
 * Actions REALES contra Postgres (lib/onboarding.ts, lib/services.ts); solo se
 * mockea el cliente de Supabase (quién es el usuario y si verificó el email).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  saveOnboardingClinic,
  saveOnboardingLocation,
  completeOnboarding,
  openPendingInvitation,
} from "@/lib/onboarding";
import { loadOnboardingContext, type SessionUser } from "@/lib/onboarding-internal";
import { deriveResumeStep, STEP } from "@/lib/onboarding-logic";
import { agendaDefaultIds } from "@/lib/agenda-defaults";
import { createService } from "@/lib/services";
import { addInsurerFromCatalog, updateInsurer } from "@/lib/insurers";
import { setBusinessHours } from "@/lib/tenant-settings";
import { savePractitionerWeek } from "@/lib/practitioner-schedule";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { runWithRls } from "@/lib/rls";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  deleteTenantDeep,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const sb = vi.hoisted(() => ({
  user: null as null | {
    id: string;
    email: string;
    email_confirmed_at: string | null;
    user_metadata: Record<string, unknown>;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: sb.user }, error: null }) },
  }),
}));

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("onboarding · alta del consultorio", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const createdTenants: string[] = [];
  const extraUsers: string[] = [];
  const catalogPayers: string[] = [];
  const catalogPractices: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    // Como el cliente vivo tras el backfill de la migración: alta completa.
    await db.tenant.update({ where: { id: A.tenantId }, data: { onboardingCompletedAt: new Date() } });
  });
  afterAll(async () => {
    // Lo creado por el stepper + lo que haya dejado una corrida anterior caída
    // (todo tenant cuyo OWNER es una identidad `test-user-onb-*`).
    const leaked = await db.membership.findMany({
      where: { userId: { startsWith: "test-user-onb-" }, role: "OWNER" },
      select: { tenantId: true },
    });
    for (const t of new Set([...createdTenants, ...leaked.map((m) => m.tenantId)])) {
      await deleteTenantDeep(db, t);
    }
    // Practitioner de un OWNER cuyo tenant ya se borró cascadea con el tenant.
    await db.userProfile.deleteMany({ where: { id: { startsWith: "test-user-onb-" } } });
    await A?.cleanup();
    // Catálogo global creado por estos tests (Service/Insurer → SET NULL, ya borrados arriba).
    if (catalogPayers.length) await db?.payer.deleteMany({ where: { id: { in: catalogPayers } } });
    if (catalogPractices.length) await db?.practice.deleteMany({ where: { id: { in: catalogPractices } } });
    if (extraUsers.length) {
      await db?.patient.updateMany({ where: { userId: { in: extraUsers } }, data: { userId: null } });
      await db?.userProfile.deleteMany({ where: { id: { in: extraUsers } } });
    }
    await db?.$disconnect();
  });
  beforeEach(() => __rateLimitInternals.reset());

  /** Identidad nueva (sin nada en la DB todavía; /auth/confirm hace el upsert del perfil). */
  const newIdentity = (verified = true) => {
    const id = `test-user-onb-${uniqueSuffix()}`;
    extraUsers.push(id);
    sb.user = {
      id,
      email: `${id}@test.local`,
      email_confirmed_at: verified ? new Date(0).toISOString() : null,
      user_metadata: { full_name: "Camila Rossi" },
    };
    return id;
  };

  const ownedState = async (userId: string) => {
    const ms = await db.membership.findMany({ where: { userId }, include: { tenant: true } });
    const tenantIds = ms.map((m) => m.tenantId);
    return {
      memberships: ms,
      practitioners: await db.practitioner.count({ where: { userId } }),
      particulars: await db.insurer.count({ where: { tenantId: { in: tenantIds }, isParticular: true } }),
    };
  };

  it("sin email verificado no crea tenant", async () => {
    const uid = newIdentity(false);
    const tenantsBefore = await db.tenant.count();
    const r = await saveOnboardingClinic({ name: "Consultorio Sin Verificar" });
    expect(r.ok).toBe(false);
    expect(await db.tenant.count()).toBe(tenantsBefore);
    expect((await ownedState(uid)).memberships).toHaveLength(0);
  });

  it("paso 2 crea Tenant + Practitioner + OWNER + Particular atómico, con el alta abierta", async () => {
    const uid = newIdentity();
    const r = await saveOnboardingClinic({
      name: "Centro Kinésico Onboarding",
      phone: "011 4555-1234",
      whatsapp: "+54 9 11 5555-1234",
      publicEmail: "Turnos@Onb.test",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    createdTenants.push(r.data.tenantId);
    expect(r.data.created).toBe(true);

    const t = await db.tenant.findUniqueOrThrow({ where: { id: r.data.tenantId } });
    expect(t).toMatchObject({
      name: "Centro Kinésico Onboarding",
      phone: "011 4555-1234",
      whatsapp: "+54 9 11 5555-1234",
      publicEmail: "turnos@onb.test",
      onboardingCompletedAt: null,
    });
    expect(t.slug).toMatch(/^centro-kinesico-onboarding(-\d+)?$/);

    const s = await ownedState(uid);
    expect(s.memberships).toHaveLength(1);
    expect(s.memberships[0]).toMatchObject({ role: "OWNER", tenantId: t.id });
    expect(s.memberships[0].acceptedAt).not.toBeNull();
    expect(s.practitioners).toBe(1);
    expect(s.particulars).toBe(1);
    const profile = await db.userProfile.findUniqueOrThrow({ where: { id: uid } });
    expect(profile).toMatchObject({ email: `${uid}@test.local`, fullName: "Camila Rossi" });
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: "tenant.create" } })).toBe(1);
  });

  it("re-ejecutar el paso 2 edita el consultorio: no duplica tenant, membresía ni Particular", async () => {
    const uid = newIdentity();
    const first = await saveOnboardingClinic({ name: "Primero" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    createdTenants.push(first.data.tenantId);
    const tenantsAfterFirst = await db.tenant.count();

    const second = await saveOnboardingClinic({ name: "Nombre Corregido", whatsapp: "11 5555 0000" });
    expect(second).toEqual({ ok: true, data: { tenantId: first.data.tenantId, created: false } });

    expect(await db.tenant.count()).toBe(tenantsAfterFirst);
    const s = await ownedState(uid);
    expect(s.memberships).toHaveLength(1);
    expect(s.practitioners).toBe(1);
    expect(s.particulars).toBe(1);
    const t = await db.tenant.findUniqueOrThrow({ where: { id: first.data.tenantId } });
    expect(t).toMatchObject({ name: "Nombre Corregido", whatsapp: "11 5555 0000" });
  });

  it("dos pedidos simultáneos del paso 2 dejan un solo consultorio", async () => {
    const uid = newIdentity();
    const [a, b] = await Promise.all([
      saveOnboardingClinic({ name: "Doble Click" }),
      saveOnboardingClinic({ name: "Doble Click" }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    createdTenants.push(a.data.tenantId);
    expect(b.data.tenantId).toBe(a.data.tenantId);
    const s = await ownedState(uid);
    expect(s.memberships).toHaveLength(1);
    expect(s.particulars).toBe(1);
  });

  it("una identidad de portal de pacientes no crea consultorio", async () => {
    const uid = newIdentity();
    await db.userProfile.create({ data: { id: uid, email: `${uid}@test.local` } });
    await db.patient.create({
      data: { tenantId: A.tenantId, firstName: "P", lastName: "Portal", email: `${uid}@test.local`, userId: uid, documentId: `DNI-${uid}` },
    });
    const tenantsBefore = await db.tenant.count();
    const r = await saveOnboardingClinic({ name: "No Debería" });
    expect(r.ok).toBe(false);
    expect(await db.tenant.count()).toBe(tenantsBefore);
  });

  it("quien ya es miembro de otro consultorio no crea uno nuevo desde el stepper", async () => {
    sb.user = { id: A.userId, email: `${A.userId}@test.local`, email_confirmed_at: new Date(0).toISOString(), user_metadata: {} };
    const tenantsBefore = await db.tenant.count();
    const r = await saveOnboardingClinic({ name: "Segundo Consultorio" });
    expect(r.ok).toBe(false);
    expect(await db.tenant.count()).toBe(tenantsBefore);
  });

  // IAM-1 (M6): antes, el Practitioner viejo de A (el único global) hacía tirar PractitionerElsewhereError y el
  // stepper respondía «escribinos a soporte» (callejón de §19.1). Ahora puede tener el suyo.
  it("[IAM-1] quien quedó como profesional de otro consultorio sin membresías (lo quitaron) crea el suyo", async () => {
    const uid = newIdentity();
    await db.userProfile.create({ data: { id: uid, email: `${uid}@test.local` } });
    const old = await db.practitioner.create({ data: { tenantId: A.tenantId, userId: uid } });
    try {
      const r = await saveOnboardingClinic({ name: "Mi Propio Consultorio" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      createdTenants.push(r.data.tenantId);
      expect(r.data.created).toBe(true);
      const pracs = await db.practitioner.findMany({ where: { userId: uid }, select: { tenantId: true } });
      expect(pracs.map((p) => p.tenantId).sort()).toEqual([A.tenantId, r.data.tenantId].sort());
      const s = await ownedState(uid);
      expect(s.memberships.map((m) => [m.tenantId, m.role])).toEqual([[r.data.tenantId, "OWNER"]]);
    } finally {
      // Practitioner → UserProfile es RESTRICT: el afterAll borra los perfiles test-user-onb-* antes que A.
      await db.practitioner.delete({ where: { id: old.id } });
    }
  });

  it("paso 7: exige un servicio, marca onboardingCompletedAt y es idempotente", async () => {
    newIdentity();
    const r = await saveOnboardingClinic({ name: "Para Completar" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    createdTenants.push(r.data.tenantId);

    const early = await completeOnboarding();
    expect(early.ok).toBe(false);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: r.data.tenantId } })).onboardingCompletedAt).toBeNull();

    // Paso 4 con la action real de Configuración (el OWNER ya tiene Actor).
    const svc = await createService({ name: "Sesión", durationMin: 45, priceCents: 1_500_000, maxConcurrent: 3 });
    expect(svc.ok).toBe(true);

    const done = await completeOnboarding();
    expect(done.ok).toBe(true);
    const at = (await db.tenant.findUniqueOrThrow({ where: { id: r.data.tenantId } })).onboardingCompletedAt;
    expect(at).not.toBeNull();

    const again = await completeOnboarding();
    expect(again.ok).toBe(true);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: r.data.tenantId } })).onboardingCompletedAt).toEqual(at);

    // Con el alta cerrada, el paso 2 ya no edita (la cuenta "ya pertenece").
    const late = await saveOnboardingClinic({ name: "Tarde" });
    expect(late.ok).toBe(false);
  });

  it("invitación pendiente: se reabre (token rotado) solo para el email invitado", async () => {
    const uid = newIdentity();
    const oldRaw = randomBytes(24).toString("base64url");
    const inv = await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: `${uid}@test.local`,
        firstName: "Inv",
        lastName: "Pendiente",
        token: hashInviteToken(oldRaw),
        invitedById: A.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const r = await openPendingInvitation(inv.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const newRaw = r.data.url.replace("/invite/", "");
    const row = await db.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.token).toBe(hashInviteToken(newRaw));
    expect(row.token).not.toBe(hashInviteToken(oldRaw));

    // Otra identidad no puede reabrir (ni rotar) una invitación ajena.
    newIdentity();
    const other = await openPendingInvitation(inv.id);
    expect(other.ok).toBe(false);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).token).toBe(row.token);
  });

  // ── B5.5 ONB: pasos de agenda ──────────────────────────────────────

  const sessionUser = (): SessionUser => ({
    id: sb.user!.id,
    email: sb.user!.email,
    emailVerified: true,
    fullName: null,
  });

  const stepperCtx = async () => {
    const ctx = await loadOnboardingContext(sessionUser());
    if (ctx.kind !== "stepper") throw new Error(`esperaba stepper, vino ${ctx.kind}`);
    return ctx;
  };

  it("flujo completo: sede → horario → tu horario → servicio con práctica → OS del catálogo → listo", async () => {
    newIdentity();
    const sfx = uniqueSuffix();
    const practice = await db.practice.create({
      data: {
        slug: `onb-practica-${sfx}`,
        name: `Fisiokinesioterapia ONB ${sfx}`,
        matchKey: `fisiokinesioterapia onb ${sfx}`,
        aliases: [],
        defaultDurationMin: 40,
        source: "CURATED",
        sourceDate: new Date("2026-09-01T00:00:00Z"),
      },
    });
    catalogPractices.push(practice.id);
    const payer = await db.payer.create({
      data: {
        slug: `onb-prestadora-${sfx}`,
        name: `Prestadora ONB ${sfx}`,
        kind: "PREPAGA",
        matchKey: `prestadora onb ${sfx}`,
        aliases: [],
        source: "CURATED",
        sourceDate: new Date("2026-09-01T00:00:00Z"),
      },
    });
    catalogPayers.push(payer.id);

    // Consultorio: el bootstrap deja sede "Principal" sin dirección y la plantilla.
    const r = await saveOnboardingClinic({ name: "Agenda Onboarding" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tenantId = r.data.tenantId;
    createdTenants.push(tenantId);
    let ctx = await stepperCtx();
    expect(ctx.location).toMatchObject({ name: "Principal", address: null });
    expect(ctx.schedule?.custom).toBe(false);
    expect(ctx.progress).toMatchObject({ locationReady: false, ownScheduleSaved: false });
    expect(deriveResumeStep(ctx.progress)).toBe(STEP.location);

    // Sede: edita LA principal (no crea otra), y es idempotente.
    const loc = await saveOnboardingLocation({
      name: "Palermo",
      address: "Av. Santa Fe 1234",
      city: "CABA",
      province: "Buenos Aires",
      phone: "",
    });
    expect(loc.ok).toBe(true);
    const again = await saveOnboardingLocation({ name: "Palermo", address: "Av. Santa Fe 1234, 3° B", city: "CABA" });
    expect(again.ok).toBe(true);
    const locs = await db.location.findMany({ where: { tenantId } });
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({
      id: agendaDefaultIds.location(tenantId),
      isPrimary: true,
      name: "Palermo",
      address: "Av. Santa Fe 1234, 3° B",
      city: "CABA",
      // Campo omitido en el segundo guardado: no se toca.
      province: "Buenos Aires",
      phone: null,
    });
    ctx = await stepperCtx();
    expect(ctx.progress.locationReady).toBe(true);
    expect(deriveResumeStep(ctx.progress)).toBe(STEP.hours);

    // Horario del consultorio: arrastra la plantilla del OWNER (sigue siendo plantilla).
    expect((await setBusinessHours({ start: 9, end: 18, slotMinutes: 30 })).ok).toBe(true);
    ctx = await stepperCtx();
    const sched = ctx.schedule!;
    expect(sched.custom).toBe(false);
    expect(sched.view.ranges).toHaveLength(6);
    expect(sched.view.ranges.every((x) => x.startMin === 540 && x.endMin === 1080)).toBe(true);
    expect(sched.view.tenantHours).toEqual({ startMin: 540, endMin: 1080 });
    expect(deriveResumeStep(ctx.progress)).toBe(STEP.hours);

    // Tu horario: lun-vie partido, sábado libre. Reemplazo atómico con lock.
    const week = [1, 2, 3, 4, 5].flatMap((dow) => [
      { dow, startMin: 540, endMin: 780, locationId: locs[0].id },
      { dow, startMin: 840, endMin: 1080, locationId: locs[0].id },
    ]);
    const saved = await savePractitionerWeek(sched.practitionerId, week, sched.view.version);
    expect(saved.ok).toBe(true);
    const rows = await db.practitionerSchedule.findMany({
      where: { tenantId, practitionerId: sched.practitionerId },
      orderBy: [{ dow: "asc" }, { startMin: "asc" }],
    });
    expect(rows.map((x) => [x.dow, x.startMin, x.endMin])).toEqual(week.map((w) => [w.dow, w.startMin, w.endMin]));
    ctx = await stepperCtx();
    expect(ctx.schedule?.custom).toBe(true);
    expect(deriveResumeStep(ctx.progress)).toBe(STEP.services);

    // Servicio con práctica del catálogo: queda vinculado y habilitado para el OWNER.
    const svc = await createService({
      name: "Sesión de kinesio",
      durationMin: practice.defaultDurationMin!,
      priceCents: 2_000_000,
      maxConcurrent: 3,
      practiceId: practice.id,
    });
    expect(svc.ok).toBe(true);
    if (!svc.ok) return;
    expect(await db.service.findUniqueOrThrow({ where: { id: svc.data.id } })).toMatchObject({
      practiceId: practice.id,
      durationMin: 40,
    });
    expect(
      await db.practitionerService.count({ where: { tenantId, serviceId: svc.data.id, practitionerId: sched.practitionerId } })
    ).toBe(1);
    ctx = await stepperCtx();
    expect(ctx.services[0]).toMatchObject({ practiceName: practice.name });
    expect(deriveResumeStep(ctx.progress)).toBe(STEP.insurers);

    // Obra social del catálogo + copago (dos actions, como la UI).
    const ins = await addInsurerFromCatalog(payer.id);
    expect(ins.ok).toBe(true);
    if (!ins.ok || ins.data.status !== "created") throw new Error("esperaba created");
    expect((await updateInsurer(ins.data.insurerId, { copagoCents: 350_000 })).ok).toBe(true);
    expect(await db.insurer.findUniqueOrThrow({ where: { id: ins.data.insurerId } })).toMatchObject({
      tenantId,
      name: payer.name,
      payerId: payer.id,
      copagoCents: 350_000,
      active: true,
    });
    expect(
      await db.practitionerPayer.count({ where: { tenantId, insurerId: ins.data.insurerId, practitionerId: sched.practitionerId } })
    ).toBe(1);
    // Elegirla dos veces no duplica.
    const dup = await addInsurerFromCatalog(payer.id);
    expect(dup.ok && dup.data.status).toBe("exists");
    expect(await db.insurer.count({ where: { tenantId, payerId: payer.id } })).toBe(1);
    ctx = await stepperCtx();
    expect(deriveResumeStep(ctx.progress)).toBe(STEP.team);

    // Listo: cierra el alta y el stepper ya no se muestra.
    expect((await completeOnboarding()).ok).toBe(true);
    expect((await loadOnboardingContext(sessionUser())).kind).toBe("done");
    // Lo cargado en el alta sigue intacto.
    expect(await db.practitionerSchedule.count({ where: { tenantId } })).toBe(10);
  });

  it("sede: sin dirección no escribe; si falta la principal, la crea (mismo id que el alta)", async () => {
    newIdentity();
    const r = await saveOnboardingClinic({ name: "Sede Faltante" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tenantId = r.data.tenantId;
    createdTenants.push(tenantId);

    const bad = await saveOnboardingLocation({ name: "Principal", address: "   " });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fieldErrors?.address?.[0]).toBeTruthy();
    expect((await db.location.findFirstOrThrow({ where: { tenantId } })).address).toBeNull();

    // Alta abierta antes de B2.3: sin sede (y por ende sin franjas).
    await db.practitionerSchedule.deleteMany({ where: { tenantId } });
    await db.location.deleteMany({ where: { tenantId } });
    let ctx = await stepperCtx();
    expect(ctx.location).toBeNull();
    expect(ctx.schedule?.view.isFallback).toBe(true);

    const ok = await saveOnboardingLocation({ name: "Centro", address: "Calle 7 nro 800", city: "La Plata" });
    expect(ok.ok).toBe(true);
    const locs = await db.location.findMany({ where: { tenantId } });
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({
      id: agendaDefaultIds.location(tenantId),
      isPrimary: true,
      active: true,
      name: "Centro",
      address: "Calle 7 nro 800",
    });
    ctx = await stepperCtx();
    expect(ctx.progress.locationReady).toBe(true);
  });

  it("un tenant con el alta cerrada nunca ve el stepper", async () => {
    sb.user = { id: A.userId, email: `${A.userId}@test.local`, email_confirmed_at: new Date(0).toISOString(), user_metadata: {} };
    const ctx = await loadOnboardingContext({ id: A.userId, email: `${A.userId}@test.local`, emailVerified: true, fullName: null });
    expect(ctx.kind).toBe("done");
  });

  // ── EV0 · EV-O: tipo de consultorio en el alta (plan §15.4, EV-D2, EV-D5) ──
  describe("EV-O · vertical en el alta", () => {
    it("alta con vertical GENERAL guarda GENERAL y el turnero nace apagado", async () => {
      newIdentity();
      const r = await saveOnboardingClinic({ name: "Consultorio General Onb", vertical: "GENERAL" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      createdTenants.push(r.data.tenantId);
      const t = await db.tenant.findUniqueOrThrow({ where: { id: r.data.tenantId } });
      expect(t).toMatchObject({ vertical: "GENERAL", publicBookingEnabled: false, onboardingCompletedAt: null });
    });

    it("alta sin vertical → KINESIOLOGY, con el turnero apagado (opt-in, EV-D2)", async () => {
      newIdentity();
      const r = await saveOnboardingClinic({ name: "Kine Por Defecto" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      createdTenants.push(r.data.tenantId);
      const t = await db.tenant.findUniqueOrThrow({ where: { id: r.data.tenantId } });
      expect(t).toMatchObject({ vertical: "KINESIOLOGY", publicBookingEnabled: false });
    });

    it("una vertical fuera del enum no pasa zod ni crea tenant", async () => {
      newIdentity();
      const before = await db.tenant.count();
      const r = await saveOnboardingClinic({ name: "Vertical Rara", vertical: "DENTAL" as never });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fieldErrors?.vertical?.[0]).toBeTruthy();
      expect(await db.tenant.count()).toBe(before);
    });

    it("la vertical se cambia re-entrando al paso 2 con el alta abierta, y no después (onboarding-closed)", async () => {
      const uid = newIdentity();
      const r = await saveOnboardingClinic({ name: "Cambia Vertical", vertical: "KINESIOLOGY" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const tenantId = r.data.tenantId;
      createdTenants.push(tenantId);

      revalidateTagSpy.mockClear();
      const edit = await saveOnboardingClinic({ name: "Cambia Vertical", vertical: "GENERAL" });
      expect(edit).toEqual({ ok: true, data: { tenantId, created: false } });
      expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).vertical).toBe("GENERAL");
      // Escritor único (C-EV5): audit `tenant.entitlements` en el tenant, misma tx.
      const ev = await db.auditEvent.findMany({ where: { tenantId, action: "tenant.entitlements" } });
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ actorId: uid, entity: "Tenant", entityId: tenantId });
      expect(ev[0].payload).toMatchObject({ source: "onboarding", changed: ["vertical"], before: { vertical: "KINESIOLOGY" }, after: { vertical: "GENERAL" } });
      // Cache de módulos invalidada después del commit.
      for (const tag of tenantEntitlementTags(tenantId)) expect(revalidateTagSpy).toHaveBeenCalledWith(tag);

      // Re-entrar sin vertical (o con la misma) no audita de nuevo.
      expect((await saveOnboardingClinic({ name: "Cambia Vertical" })).ok).toBe(true);
      expect((await saveOnboardingClinic({ name: "Cambia Vertical", vertical: "GENERAL" })).ok).toBe(true);
      expect(await db.auditEvent.count({ where: { tenantId, action: "tenant.entitlements" } })).toBe(1);
      expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).vertical).toBe("GENERAL");

      // Cierra el alta.
      expect((await createService({ name: "Consulta", durationMin: 30, priceCents: 1_000_000 })).ok).toBe(true);
      expect((await completeOnboarding()).ok).toBe(true);

      // Después: el paso 2 ya no entra (la cuenta "ya pertenece") …
      const late = await saveOnboardingClinic({ name: "Cambia Vertical", vertical: "KINESIOLOGY" });
      expect(late.ok).toBe(false);
      // … y el escritor único rechaza la source `onboarding` aunque la llame
      // alguien que se saltee ese chequeo (carrera con completeOnboarding).
      const direct = await runWithRls(tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId,
          source: "onboarding",
          patch: { vertical: "KINESIOLOGY" },
          actor: { userId: uid, homeTenantId: tenantId },
        })
      );
      expect(direct).toEqual({ ok: false, reason: "onboarding-closed" });
      expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).vertical).toBe("GENERAL");
      expect(await db.auditEvent.count({ where: { tenantId, action: "tenant.entitlements" } })).toBe(1);
    });
  });
});
