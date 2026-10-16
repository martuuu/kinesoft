/**
 * IAM-0a · hallazgo [A] «Email con ILIKE sin escapar» (plan §19.1, C-IAM4).
 *
 * Prisma compila `{ email: { equals: x, mode: "insensitive" } }` a `ILIKE x` con
 * el valor tal cual: `_` y `%` son comodines. Una identidad VERIFICADA
 * `<base>_@test.local` (o `<base>%@…`) matcheaba la ficha/invitación de
 * `<base>z@test.local`, que es otra persona. Cada superficie, contra Postgres:
 *
 *   - portal (`getPortalAuth`, `getPortalPlan`): veía fichas, turnos y planes ajenos;
 *   - callback de OAuth (`linkPortalPatientOnCallback`): vinculaba `Patient.userId`
 *     ajeno = toma de ficha;
 *   - turnero (`loadPublicBookingPage` / `findPatientByEmailForPrefill`): precargaba
 *     DNI, nacimiento y cobertura ajenos;
 *   - alta (`loadOnboardingContext`, `openPendingInvitation`): ofrecía la invitación
 *     ajena y, al abrirla, ROTABA su token (el link del mail de la víctima moría);
 *   - falsos positivos que niegan: `isPortalPatientIdentity`, `createInvitation`,
 *     `acceptInvite` (staff ≠ paciente) y `resolvePublicPatient` (descartaba el
 *     email de la ficha nueva como "ya usado").
 *
 * Funciones REALES; solo se mockea la sesión de Supabase (tests/helpers/actor.ts:
 * `asUser(id)` → `<id>@test.local`, verificado). Así el `_`/`%` va en el id.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPortalAuth, getPortalPlan } from "@/lib/portal";
import { linkPortalPatientOnCallback } from "@/lib/portal-link-internal";
import {
  findPatientByEmailForPrefill,
  loadPublicBookingPage,
  resolvePublicPatient,
} from "@/lib/public-booking-internal";
import { loadOnboardingContext, isPortalPatientIdentity } from "@/lib/onboarding-internal";
import { openPendingInvitation } from "@/lib/onboarding";
import { createInvitation } from "@/lib/invitations";
import { acceptInvite } from "@/app/invite/[token]/accept-action";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const email = (id: string) => `${id}@test.local`;

describe.skipIf(!RUN)("IAM-0a · match de email sin comodines", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  const extraUsers: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    // PRO: los casos activan varios profesionales en el mismo consultorio; FREE (1 lugar) los frena (BO2-B).
    A = await createEphemeralTenant(db, { plan: "PRO" });
    B = await createEphemeralTenant(db, { plan: "PRO" });
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (extraUsers.length) await db?.userProfile.deleteMany({ where: { id: { in: extraUsers } } });
    await db?.$disconnect();
  });
  beforeEach(() => __rateLimitInternals.reset());

  /**
   * `victim` es la dueña real del email; `under`/`pct` son identidades verificadas
   * distintas cuyo email, leído como patrón LIKE, matchea el de la víctima.
   */
  const people = () => {
    const base = `test-iam0a-${uniqueSuffix()}`;
    return { victim: `${base}z`, under: `${base}_`, pct: `${base}%` };
  };

  const profile = async (id: string) => {
    extraUsers.push(id);
    await db.userProfile.upsert({ where: { id }, create: { id, email: email(id) }, update: {} });
  };

  const victimWithPlan = async (t: EphemeralTenant, victim: string) => {
    const patientId = await addPatient(db, t, { email: email(victim) });
    await db.treatmentProgram.create({
      data: { tenantId: t.tenantId, patientId, title: "Plan de la víctima", startDate: new Date() },
    });
    return patientId;
  };

  const invitationFor = async (t: EphemeralTenant, to: string) => {
    const raw = randomBytes(24).toString("base64url");
    const inv = await db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email: email(to),
        firstName: "Inv",
        lastName: "Pendiente",
        role: "PRACTITIONER",
        token: hashInviteToken(raw),
        invitedById: t.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { inv, raw };
  };

  // ── Portal ──────────────────────────────────────────────────────────

  it("[IAM-0a] portal: una identidad `_` no ve la ficha ni el plan de otra persona", async () => {
    const { victim, under } = people();
    await victimWithPlan(A, victim);
    asUser(under);
    const auth = await getPortalAuth();
    expect(auth.signedIn).toBe(true);
    if (auth.signedIn) expect(auth.patients).toEqual([]);
    expect(await getPortalPlan(A.slug)).toBeNull();
  });

  it("[IAM-0a] portal: una identidad `%` no ve fichas ajenas", async () => {
    const { victim, pct } = people();
    await victimWithPlan(A, victim);
    asUser(pct);
    const auth = await getPortalAuth();
    if (auth.signedIn) expect(auth.patients).toEqual([]);
    expect(await getPortalPlan(A.slug)).toBeNull();
  });

  it("[ES4 S24a] portal: una ficha con el email exacto pero sin vincular no se ve (el vínculo lo hace el callback)", async () => {
    const { under } = people();
    await addPatient(db, A, { email: email(under).toUpperCase() });
    asUser(under);
    const auth = await getPortalAuth();
    if (auth.signedIn) expect(auth.patients).toEqual([]);
  });

  // ── Callback de OAuth (vínculo Patient.userId) ──────────────────────

  it("[IAM-0a] callback: una identidad `_` no se vincula a la ficha de otra persona", async () => {
    const { victim, under } = people();
    const patientId = await addPatient(db, A, { email: email(victim) });
    await profile(under);
    const r = await linkPortalPatientOnCallback({ id: under, email: email(under), emailVerified: true }, A.slug);
    expect(r).toBe("no_patient");
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).userId).toBeNull();
    expect(await db.patientTenantLink.count({ where: { patientId } })).toBe(0);
  });

  it("[IAM-0a] callback: tampoco con `%`", async () => {
    const { victim, pct } = people();
    const patientId = await addPatient(db, A, { email: email(victim) });
    await profile(pct);
    const r = await linkPortalPatientOnCallback({ id: pct, email: email(pct), emailVerified: true }, A.slug);
    expect(r).toBe("no_patient");
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).userId).toBeNull();
  });

  it("callback: el email exacto (con mayúsculas en la ficha) vincula", async () => {
    const { under } = people();
    const patientId = await addPatient(db, A, { email: email(under).toUpperCase() });
    await profile(under);
    const r = await linkPortalPatientOnCallback({ id: under, email: email(under), emailVerified: true }, A.slug);
    expect(r).toBe("linked");
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).userId).toBe(under);
  });

  // ── Turnero: precarga de PHI y resolución de la ficha ───────────────

  it("[IAM-0a] turnero: la precarga no trae la ficha de otra persona (`_`)", async () => {
    const { victim, under } = people();
    await addPatient(db, A, { email: email(victim), documentId: `DNI-V-${uniqueSuffix()}` });
    asUser(under);
    const page = await loadPublicBookingPage(A.slug);
    expect(page?.state).toBe("open");
    if (page?.state === "open") expect(page.prefill).toBeNull();
  });

  it("[IAM-0a] turnero: la precarga no trae la ficha de otra persona (`%`)", async () => {
    const { victim, pct } = people();
    await addPatient(db, A, { email: email(victim) });
    expect(await findPatientByEmailForPrefill(email(pct), { tenantId: A.tenantId, userId: pct })).toBeNull();
  });

  it("turnero: la precarga con el email literal `_` trae su propia ficha", async () => {
    const { under } = people();
    await addPatient(db, A, { email: email(under), firstName: "Propia" });
    const r = await findPatientByEmailForPrefill(email(under).toUpperCase(), { tenantId: A.tenantId });
    expect(r?.firstName).toBe("Propia");
  });

  it("[IAM-0a] turnero: una ficha nueva con email `_` no lo pierde por la ficha de otra persona", async () => {
    const { victim, under } = people();
    await addPatient(db, A, { email: email(victim) });
    const r = await resolvePublicPatient(
      A.tenantId,
      {
        firstName: "Nueva",
        lastName: "Ficha",
        email: email(under),
        phone: `11${Date.now().toString().slice(-8)}`,
        documentId: `9${Date.now().toString().slice(-7)}`,
        dateOfBirth: new Date("1990-01-01T00:00:00Z"),
      },
      { practitionerId: A.practitionerId }
    );
    expect(r.created).toBe(true);
    expect((await db.patient.findUniqueOrThrow({ where: { id: r.patientId } })).email).toBe(email(under));
  });

  // ── Alta: invitaciones pendientes ───────────────────────────────────

  it("[IAM-0a] alta: una identidad `_` no ve la invitación de otra persona", async () => {
    const { victim, under } = people();
    await invitationFor(A, victim);
    const ctx = await loadOnboardingContext({ id: under, email: email(under), emailVerified: true, fullName: null });
    expect(ctx.kind).toBe("stepper");
  });

  it("[IAM-0a] alta: una identidad `_` no reabre (ni rota) la invitación de otra persona", async () => {
    const { victim, under } = people();
    const { inv } = await invitationFor(A, victim);
    asUser(under);
    const r = await openPendingInvitation(inv.id);
    expect(r.ok).toBe(false);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).token).toBe(inv.token);
  });

  it("[IAM-0a] alta: tampoco con `%`", async () => {
    const { victim, pct } = people();
    const { inv } = await invitationFor(A, victim);
    asUser(pct);
    const r = await openPendingInvitation(inv.id);
    expect(r.ok).toBe(false);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).token).toBe(inv.token);
  });

  it("alta: la invitación con el email literal `_` se ve y se reabre", async () => {
    const { under } = people();
    const { inv } = await invitationFor(A, under);
    const ctx = await loadOnboardingContext({ id: under, email: email(under), emailVerified: true, fullName: null });
    expect(ctx.kind === "invites" && ctx.invites.map((i) => i.id)).toEqual([inv.id]);
    asUser(under);
    expect((await openPendingInvitation(inv.id)).ok).toBe(true);
  });

  // ── Staff ≠ paciente: falsos positivos que niegan ───────────────────

  it("[IAM-0a] staff ≠ paciente: la ficha con portal de otra persona no marca a la identidad `_`", async () => {
    const { victim, under } = people();
    await profile(victim);
    const pid = await addPatient(db, B, { email: email(victim) });
    await db.patient.update({ where: { id: pid }, data: { userId: victim } });
    expect(await isPortalPatientIdentity({ id: under, email: email(under) })).toBe(false);
  });

  it("[IAM-0a] createInvitation: no rechaza un email `_` por el paciente con portal de otra persona", async () => {
    const { victim, under } = people();
    await profile(victim);
    const pid = await addPatient(db, A, { email: email(victim) });
    await db.patient.update({ where: { id: pid }, data: { userId: victim } });
    asUser(A.userId);
    const r = await createInvitation({ email: email(under), firstName: "X", lastName: "Y" });
    expect(r.ok).toBe(true);
  });

  it("[IAM-0a] acceptInvite: no rechaza a la identidad `_` por el paciente con portal de otra persona", async () => {
    const { victim, under } = people();
    await profile(victim);
    extraUsers.push(under); // acceptInvite le crea el UserProfile
    const pid = await addPatient(db, B, { email: email(victim) });
    await db.patient.update({ where: { id: pid }, data: { userId: victim } });
    const { raw } = await invitationFor(A, under);
    asUser(under);
    const r = await acceptInvite(raw);
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await db.membership.count({ where: { userId: under, tenantId: A.tenantId } })).toBe(1);
  });
});
