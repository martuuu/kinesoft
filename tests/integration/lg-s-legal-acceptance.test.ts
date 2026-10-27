/**
 * PV (§27, LG-S) · aceptación de los Términos y la Política de privacidad del lado server.
 *
 * Decisión de Martin (27-oct): «legales con borrador + casilla». La casilla es obligatoria en runtime en las tres
 * puertas por donde alguien entra a usar el producto con datos de pacientes:
 *   - alta por email (`signUpPractitioner`): sin casilla no se crea NADA (ni la cuenta de Auth ni el mail); con
 *     casilla, cuenta nueva → evento `legal.accepted {version, via:"signup"}`. Cuenta existente → sin evento y la MISMA
 *     respuesta (el alta no puede volverse un oráculo de cuentas existentes).
 *   - onboarding (`saveOnboardingClinic`): cubre OAuth y /login→Google, que no pasan por el alta por email. Si la
 *     persona no aceptó la versión vigente, se exige y se registra `via:"onboarding"` en la tx del consultorio.
 *   - invitaciones (`activateInvitation` / `acceptInvite`): el evento va en la tx de `joinTenantInTx`.
 *
 * Símbolos REALES contra Postgres en los dos roles; se reemplazan solo GoTrue (fake), el despacho del mail y la
 * sesión de Supabase (integration-setup + `asUser`). `UserSecurityEvent` es solo inserción (trigger de M8): los
 * eventos de estas identidades (`test-user-lgs-*`, UUID del fake) quedan, como en `two-factor.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { signUpPractitioner } from "@/lib/auth";
import { saveOnboardingClinic } from "@/lib/onboarding";
import { loadOnboardingContext } from "@/lib/onboarding-internal";
import { activateInvitation, joinTenantInTx } from "@/lib/invite-activation-internal";
import { acceptInvite } from "@/app/invite/[token]/accept-action";
import { hasAcceptedCurrentLegal, recordLegalAcceptanceInTx } from "@/lib/legal-acceptance-internal";
import { LEGAL_ACCEPT_ERROR, LEGAL_VERSION } from "@/lib/legal";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { __setAuthAdminForTests, type AuthAdminPort } from "@/lib/identity/auth-admin";
import { __setEmailTransportForTests, type SendEmailInput } from "@/lib/email";
import { emailToHash } from "@/lib/email/log";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  deleteTenantDeep,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const IP = "203.0.113.40";
const PASSWORD = "clave-segura-1";
const SIGNUP_SENT = "Te mandamos un email para confirmar tu cuenta.";

const rawToken = () => randomBytes(24).toString("base64url");

describe.skipIf(!RUN)("LG-S · aceptación de Términos y Privacidad (server)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fake: GotrueFake;
  let sent: SendEmailInput[];
  const mailed = new Set<string>();
  const createdUserIds = new Set<string>();
  const sessionUsers: string[] = [];
  const createdTenants: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    // CLINICA: varios casos suman profesionales al mismo consultorio (con FREE el cupo los frena, BO2-B).
    T = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "CLINICA" });
  });
  afterAll(async () => {
    // Lo creado por el stepper + lo que haya dejado una corrida anterior caída (OWNER `test-user-lgs-*`).
    const leaked = await db.membership.findMany({
      where: { userId: { startsWith: "test-user-lgs-" }, role: "OWNER" },
      select: { tenantId: true },
    });
    for (const t of new Set([...createdTenants, ...leaked.map((m) => m.tenantId)])) await deleteTenantDeep(db, t);
    await T?.cleanup();
    if (db) {
      const ids = [...createdUserIds, ...sessionUsers];
      if (ids.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: ids } } });
        await db.userProfile.deleteMany({ where: { id: { in: ids }, practitioners: { none: {} } } });
      }
      if (mailed.size) await db.emailLog.deleteMany({ where: { toHash: { in: [...mailed].map(emailToHash) } } });
      await db.$disconnect();
    }
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    fake = new GotrueFake();
    __setAuthAdminForTests(trackingPort(fake));
    sent = [];
    __setEmailTransportForTests(async (i) => {
      sent.push(i);
      mailed.add(i.to);
      return { ok: true, transport: "resend", providerId: `lgs-${sent.length}` };
    });
    asAnonymous();
  });
  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
  });

  function trackingPort(inner: GotrueFake): AuthAdminPort {
    return {
      createUser: async (p) => {
        const r = await inner.createUser(p);
        if (r.ok) createdUserIds.add(r.data.id);
        return r;
      },
      deleteUser: (id) => inner.deleteUser(id),
      updateUserById: (id, p) => inner.updateUserById(id, p),
      getUser: (id) => inner.getUser(id),
      findUserByEmail: (e) => inner.findUserByEmail(e),
      listUsers: (p) => inner.listUsers(p),
      generateLink: async (p) => {
        const r = await inner.generateLink(p);
        if (r.ok && r.data.userId) createdUserIds.add(r.data.userId);
        return r;
      },
    };
  }

  const legalEvents = (userId: string) =>
    db.userSecurityEvent.findMany({ where: { userId, kind: "legal.accepted" }, orderBy: { createdAt: "asc" } });

  /** Identidad con sesión (email verificado, por integration-setup) sin nada en la base. */
  const sessionUser = () => {
    const id = `test-user-lgs-${uniqueSuffix()}`;
    sessionUsers.push(id);
    asUser(id);
    return id;
  };

  async function invite(email: string): Promise<{ id: string; raw: string }> {
    const raw = rawToken();
    const row = await db.invitation.create({
      data: {
        tenantId: T.tenantId,
        email,
        firstName: "Lu",
        lastName: "Gómez",
        role: "PRACTITIONER",
        specialty: "Kinesiología",
        token: hashInviteToken(raw),
        invitedById: T.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { id: row.id, raw };
  }

  // ── [LG-4] alta por email ───────────────────────────────────────────────────────────────────────────────────

  describe("[LG-4] alta por email", () => {
    const fresh = (tag: string) => `lgs-${tag}-${uniqueSuffix()}@test.local`;

    it("[LG-4] alta sin aceptar → fieldErrors.acceptLegal y nada creado (ni cuenta de Auth, ni link, ni mail)", async () => {
      for (const acceptLegal of [undefined, false, "off", "", 1] as unknown[]) {
        const email = fresh("sin");
        const r = await signUpPractitioner({ fullName: "Sin Casilla", email, password: "clave1234", acceptLegal } as Parameters<
          typeof signUpPractitioner
        >[0]);
        expect(r.ok).toBe(false);
        if (r.ok) continue;
        expect(r.fieldErrors?.acceptLegal).toEqual([LEGAL_ACCEPT_ERROR]);
        expect(r.error).toBe(LEGAL_ACCEPT_ERROR);
        expect([...fake.users.values()].filter((u) => u.email === email)).toHaveLength(0);
      }
      expect(fake.links).toHaveLength(0);
      expect(fake.calls).toHaveLength(0);
      expect(sent).toHaveLength(0);
    });

    it("[LG-4] alta con aceptar → cuenta nueva + evento {version, via:\"signup\"}", async () => {
      const email = fresh("con");
      const r = await signUpPractitioner({ fullName: "Con Casilla", email, password: "clave1234", acceptLegal: true });
      expect(r).toEqual({ ok: true, data: { email, joining: false, message: SIGNUP_SENT } });
      const user = [...fake.users.values()].find((u) => u.email === email);
      expect(user).toBeDefined();
      const evs = await legalEvents(user!.id);
      expect(evs).toHaveLength(1);
      expect(evs[0].payload).toEqual({ version: LEGAL_VERSION, via: "signup" });
      expect(evs[0].tenantId).toBeNull();
      expect(await hasAcceptedCurrentLegal(user!.id)).toBe(true);
      // Una versión distinta de la aceptada no cuenta (cambiar el texto = volver a pedirla).
      expect(await hasAcceptedCurrentLegal(user!.id, "1999-01-01")).toBe(false);
    });

    it("[LG-4] el checkbox HTML («on») también vale", async () => {
      const email = fresh("on");
      const r = await signUpPractitioner({ fullName: "Form Html", email, password: "clave1234", acceptLegal: "on" });
      expect(r.ok).toBe(true);
      const user = [...fake.users.values()].find((u) => u.email === email);
      expect(await hasAcceptedCurrentLegal(user!.id)).toBe(true);
    });

    it("[LG-4] cuenta existente (confirmada o no) → sin evento, misma respuesta que una nueva", async () => {
      for (const confirmed of [true, false]) {
        const email = fresh(confirmed ? "existe" : "pendiente");
        const seeded = await fake.createUser({ email, password: "vieja1234", emailConfirm: confirmed });
        if (!seeded.ok) throw new Error(seeded.code);
        const r = await signUpPractitioner({ fullName: "Ya Existe", email, password: "clave1234", acceptLegal: true });
        expect(r).toEqual({ ok: true, data: { email, joining: false, message: SIGNUP_SENT } });
        expect(await legalEvents(seeded.data.id)).toHaveLength(0);
      }
    });
  });

  // ── [LG-5] onboarding ───────────────────────────────────────────────────────────────────────────────────────

  describe("[LG-5] onboarding", () => {
    it("[LG-5] onboarding sin aceptación → LEGAL_ACCEPT_ERROR sin consultorio", async () => {
      const uid = sessionUser();
      const ctx = await loadOnboardingContext({ id: uid, email: `${uid}@test.local`, emailVerified: true, fullName: null });
      expect(ctx.kind === "stepper" && ctx.legalAccepted).toBe(false);

      const r = await saveOnboardingClinic({ name: "Sin Aceptar" });
      expect(r).toEqual({ ok: false, error: LEGAL_ACCEPT_ERROR, fieldErrors: { acceptLegal: [LEGAL_ACCEPT_ERROR] } });
      expect(await db.membership.count({ where: { userId: uid } })).toBe(0);
      expect(await legalEvents(uid)).toHaveLength(0);

      // Datos inválidos Y sin casilla: los dos errores juntos, con el mensaje genérico.
      const both = await saveOnboardingClinic({ name: "" });
      expect(both.ok).toBe(false);
      if (!both.ok) {
        expect(both.fieldErrors?.acceptLegal).toEqual([LEGAL_ACCEPT_ERROR]);
        expect(both.fieldErrors?.name).toBeDefined();
      }
    });

    it("[LG-5] con aceptación → consultorio + evento {version, via:\"onboarding\"} con su tenantId", async () => {
      const uid = sessionUser();
      const r = await saveOnboardingClinic({ name: "Con Aceptacion", acceptLegal: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      createdTenants.push(r.data.tenantId);
      expect(r.data.created).toBe(true);
      const evs = await legalEvents(uid);
      expect(evs).toHaveLength(1);
      expect(evs[0].payload).toEqual({ version: LEGAL_VERSION, via: "onboarding" });
      expect(evs[0].tenantId).toBe(r.data.tenantId);

      // Re-entrar al paso 2 (editar) no la vuelve a pedir ni la vuelve a registrar.
      const edit = await saveOnboardingClinic({ name: "Con Aceptacion Editado" });
      expect(edit).toEqual({ ok: true, data: { tenantId: r.data.tenantId, created: false } });
      expect(await legalEvents(uid)).toHaveLength(1);
      const ctx = await loadOnboardingContext({ id: uid, email: `${uid}@test.local`, emailVerified: true, fullName: null });
      expect(ctx.kind === "stepper" && ctx.legalAccepted).toBe(true);
    });

    it("[LG-5] quien ya aceptó (en el alta) no ve casilla: crea sin mandarla y no se duplica el evento", async () => {
      const uid = sessionUser();
      await db.$transaction((tx) => recordLegalAcceptanceInTx(tx, { userId: uid, via: "signup" }));
      const ctx = await loadOnboardingContext({ id: uid, email: `${uid}@test.local`, emailVerified: true, fullName: null });
      expect(ctx.kind === "stepper" && ctx.legalAccepted).toBe(true);

      const r = await saveOnboardingClinic({ name: "Ya Acepto" });
      expect(r.ok).toBe(true);
      if (r.ok) createdTenants.push(r.data.tenantId);
      const evs = await legalEvents(uid);
      expect(evs.map((e) => (e.payload as { via: string }).via)).toEqual(["signup"]);
    });

    it("[LG-5] una aceptación de una versión vieja no cuenta: se vuelve a pedir", async () => {
      const uid = sessionUser();
      await db.userSecurityEvent.create({
        data: { userId: uid, kind: "legal.accepted", payload: { version: "2020-01-01", via: "signup" } },
      });
      expect(await hasAcceptedCurrentLegal(uid)).toBe(false);
      const r = await saveOnboardingClinic({ name: "Version Vieja" });
      expect(r).toMatchObject({ ok: false, error: LEGAL_ACCEPT_ERROR });
      expect(await db.membership.count({ where: { userId: uid } })).toBe(0);
    });
  });

  // ── [LG-6] invitaciones ─────────────────────────────────────────────────────────────────────────────────────

  describe("[LG-6] invitaciones", () => {
    const activation = (token: string, acceptLegal?: unknown) => ({
      token,
      firstName: "Lu",
      lastName: "Gómez",
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      ...(acceptLegal !== undefined ? { acceptLegal } : {}),
    });

    it("[LG-6] activar sin aceptar → invalid_input con fieldErrors.acceptLegal; no se crea la cuenta ni se acepta la invitación", async () => {
      const email = `lgs-act-${uniqueSuffix()}@example.com`;
      const inv = await invite(email);
      const r = await activateInvitation(activation(inv.raw), { ip: IP });
      expect(r).toMatchObject({ ok: false, code: "invalid_input", fieldErrors: { acceptLegal: [LEGAL_ACCEPT_ERROR] } });
      expect(fake.calls.filter((c) => c.method === "createUser")).toHaveLength(0);
      expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();
    });

    it("[LG-6] activar con aceptar → evento {version, via:\"invite_activate\"} con el tenant de la invitación", async () => {
      const email = `lgs-act-${uniqueSuffix()}@example.com`;
      const inv = await invite(email);
      const r = await activateInvitation(activation(inv.raw, true), { ip: IP });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const evs = await legalEvents(r.userId);
      expect(evs).toHaveLength(1);
      expect(evs[0].payload).toEqual({ version: LEGAL_VERSION, via: "invite_activate" });
      expect(evs[0].tenantId).toBe(T.tenantId);
    });

    it("[LG-6] aceptar con sesión la exige si no aceptó la versión vigente; con casilla → evento invite_accept", async () => {
      const uid = sessionUser();
      const inv = await invite(`${uid}@test.local`);
      const no = await acceptInvite(inv.raw);
      expect(no).toEqual({ ok: false, error: LEGAL_ACCEPT_ERROR, fieldErrors: { acceptLegal: [LEGAL_ACCEPT_ERROR] } });
      expect(await db.membership.count({ where: { userId: uid } })).toBe(0);
      expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();

      expect(await acceptInvite(inv.raw, true)).toEqual({ ok: true, data: undefined });
      const evs = await legalEvents(uid);
      expect(evs).toHaveLength(1);
      expect(evs[0].payload).toEqual({ version: LEGAL_VERSION, via: "invite_accept" });
      expect(evs[0].tenantId).toBe(T.tenantId);
    });

    it("[LG-6] quien ya aceptó la versión vigente acepta la invitación sin casilla y sin evento nuevo", async () => {
      const uid = sessionUser();
      await db.$transaction((tx) => recordLegalAcceptanceInTx(tx, { userId: uid, via: "onboarding" }));
      const inv = await invite(`${uid}@test.local`);
      expect(await acceptInvite(inv.raw)).toEqual({ ok: true, data: undefined });
      expect((await legalEvents(uid)).map((e) => (e.payload as { via: string }).via)).toEqual(["onboarding"]);
    });

    it("[LG-6] evento en la misma tx: si la tx de la unión falla, no queda evento", async () => {
      const uid = `test-user-lgs-${uniqueSuffix()}`;
      sessionUsers.push(uid);
      const inv = await invite(`${uid}@test.local`);
      await expect(
        db.$transaction(async (tx) => {
          await joinTenantInTx(tx, {
            invitation: { id: inv.id, tenantId: T.tenantId, role: "PRACTITIONER", specialty: null },
            userId: uid,
            email: `${uid}@test.local`,
            fullName: null,
            now: new Date(),
            via: "session",
            recordLegal: true,
          });
          // Algo que falla DESPUÉS de las filas (como el CAS perdido o el cupo, pero al final): todo se deshace.
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      expect(await legalEvents(uid)).toHaveLength(0);
      expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();
      expect(await db.membership.count({ where: { userId: uid } })).toBe(0);
    });
  });
});
