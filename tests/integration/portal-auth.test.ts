/**
 * IAM-3c · portal del paciente con magic link por email (además de Google) e invitación al portal por mail
 * propio (plan §19.4 fila 3c, IAM-D5).
 *
 * Antes:
 *  - el portal solo tenía «Ingresar con Google»: un paciente sin cuenta de Google no podía entrar;
 *  - `sendPatientPortalInvite` usaba `inviteUserByEmail` (flujo implícito: link a la Site URL = localhost, plantilla
 *    genérica de Supabase) y a un paciente YA vinculado le volvía a mandar un invite, que GoTrue rechaza con
 *    «already registered»: el reenvío siempre fallaba (§19.1, «reenvío al portal de un paciente vinculado»);
 *  - el vínculo `Patient.userId` solo se hacía si el callback traía `?tenant=<slug>`, y NADIE armaba ese
 *    parámetro (`app/api/auth/google/route.ts` redirige con `?next=` solo): el vínculo nunca ocurría;
 *  - `portal.link.refused` logueaba el email en claro.
 *
 * Acá se fija:
 *  - `requestPortalLink`: email de paciente → UN mail `portal_magic_link` con link a NUESTRO `/auth/confirm`
 *    (`next=/portal` o `/portal/c/<slug>`); email desconocido, de staff o que solo «parece» (`_`) → la MISMA
 *    respuesta, sin mail y SIN llamar a GoTrue (un magiclink a un email sin cuenta CREA la cuenta [S4]);
 *    rate limit por IP y por hash del email;
 *  - `sendPatientPortalInvite`: mail `portal_invite` por `sendEmail`, sin `inviteUserByEmail`, resultado que dice
 *    la verdad (`emailSent`, `transport`, `emailStatus`) y reenvío a un paciente vinculado que funciona;
 *  - el vínculo al iniciar sesión (Google o magic link) sigue AUDIT §5.8 y el callback borra `kine_tenant`
 *    (decisión 6 del 14-oct: en cada login se elige consultorio).
 *
 * Actions y route REALES contra Postgres. Se reemplazan solo las fronteras: el puerto de Auth admin (fake de
 * GoTrue), el despacho del mail (`__setEmailTransportForTests`: validación, sink de EmailLog y log siguen siendo
 * los reales), la red de Supabase del server (sesión y canje del code) y el admin client (para contar
 * `inviteUserByEmail`, que no se tiene que llamar más).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { requestPortalLink } from "@/lib/portal-auth";
import { linkPortalPatientsOnSignIn } from "@/lib/portal-link-internal";
import { sendPatientPortalInvite } from "@/lib/patients";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { emailToHash } from "@/lib/email/log";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant-cookie";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// Sesión de Supabase del server: la usan `getActor()` (sendPatientPortalInvite) y el callback de OAuth.
// Registro a mano (vitest 2.1.9: nada de vi.fn que tire a través de un mock).
const sb = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; email_confirmed_at: string | null; user_metadata?: Record<string, unknown> },
  exchanged: [] as string[],
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: sb.user }, error: null }),
      exchangeCodeForSession: async (code: string) => {
        sb.exchanged.push(code);
        return sb.user
          ? { data: { user: sb.user, session: {} }, error: null }
          : { data: { user: null, session: null }, error: { message: "invalid code" } };
      },
    },
  }),
}));

// El invite al portal ya NO usa el admin client de Supabase: si alguien lo vuelve a llamar, queda contado.
const admin = vi.hoisted(() => ({ invites: 0 }));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    auth: {
      admin: {
        inviteUserByEmail: async () => {
          admin.invites += 1;
          return { data: { user: null }, error: null };
        },
      },
    },
  }),
}));

import { GET as callbackGET } from "@/app/auth/callback/route";

const RUN = process.env.INTEGRATION === "1";
const GENERIC = "Si tu email está registrado en un consultorio, te mandamos un link para entrar. Vence en 1 hora.";
const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;

/** Registro a mano del despacho de mails. */
const mail = {
  sent: [] as SendEmailInput[],
  next: null as SendEmailResult | null,
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    const r = mail.next ?? { ok: true as const, transport: "resend" as const, providerId: `re_${mail.sent.length}` };
    mail.next = null;
    return r;
  },
};

/** El primer link `/auth/confirm` del texto del mail, desarmado. */
function confirmLink(m: SendEmailInput | undefined) {
  const hit = m?.text.match(/https?:\/\/\S*\/auth\/confirm\?\S+/);
  if (!hit) return null;
  const u = new URL(hit[0]);
  return { origin: u.origin, path: u.pathname, q: Object.fromEntries(u.searchParams) };
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe.skipIf(!RUN)("IAM-3c · portal con magic link, invitación por mail propio y vínculo al entrar", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let gotrue: GotrueFake;
  const profiles: string[] = [];
  const mailed = new Set<string>();

  const fresh = (tag: string) => `${tag}-${uniqueSuffix()}@test.local`;
  /** UserProfile de una identidad de paciente (sin Membership): el FK de `Patient.userId` lo exige. */
  const patientProfile = async (email: string) => {
    const id = `test-portal-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email } });
    profiles.push(id);
    return id;
  };

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    await db.tenant.update({ where: { id: A.tenantId }, data: { publicEmail: "turnos@consultorio-a.test" } });
  });
  afterAll(async () => {
    if (profiles.length) {
      await db?.patient.updateMany({ where: { userId: { in: profiles } }, data: { userId: null } });
    }
    await A?.cleanup();
    await B?.cleanup();
    if (profiles.length) await db?.userProfile.deleteMany({ where: { id: { in: profiles } } });
    if (mailed.size) await db?.emailLog.deleteMany({ where: { toHash: { in: [...mailed].map(emailToHash) } } });
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    mail.sent.length = 0;
    mail.next = null;
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
    __setEmailTransportForTests(async (i) => {
      mailed.add(i.to);
      return mail.transport(i);
    });
    admin.invites = 0;
    sb.user = null;
    sb.exchanged.length = 0;
  });
  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
    vi.restoreAllMocks();
  });

  // ── requestPortalLink ───────────────────────────────────────────────

  describe("requestPortalLink", () => {
    it("[IAM-3c] email de paciente con slug → 1 mail portal_magic_link con link propio a /auth/confirm y next=/portal/c/<slug>", async () => {
      const to = fresh("pac");
      const patientId = await addPatient(db, A, { email: to.toUpperCase() });
      const r = await requestPortalLink(form({ email: ` ${to} `, slug: A.slug }));
      expect(r).toEqual({ ok: true, data: { message: GENERIC } });

      expect(mail.sent).toHaveLength(1);
      const m = mail.sent[0];
      expect(m.kind).toBe("portal_magic_link");
      expect(m.to).toBe(to);
      expect(m.tenantId).toBe(A.tenantId);
      expect(m.entity).toBe("Patient");
      expect(m.entityId).toBe(patientId);
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { name: true } });
      expect(m.fromName).toBe(tenant.name);
      expect(m.replyTo).toBe("turnos@consultorio-a.test");

      const link = confirmLink(m);
      expect(link).not.toBeNull();
      expect(link!.origin).toBe(ORIGIN);
      expect(link!.path).toBe("/auth/confirm");
      expect(link!.q.next).toBe(`/portal/c/${A.slug}`);
      // [S4] el email no tenía cuenta: GoTrue la crea y el token es de confirmación (signup), nunca recovery.
      expect(link!.q.type).toBe("signup");
      expect(link!.q.token_hash).toBe(gotrue.links[0].hashedToken);
      expect(gotrue.links.map((l) => l.type)).toEqual(["magiclink"]);

      // El sink real dejó la fila de EmailLog (sin el link: solo el host).
      const log = await db.emailLog.findFirst({ where: { toHash: emailToHash(to), kind: "portal_magic_link" } });
      expect(log).toMatchObject({ status: "sent", tenantId: A.tenantId, entityId: patientId });
      expect(log?.linkHost).toBe(new URL(ORIGIN).hostname);
    });

    it("sin slug → next=/portal; con cuenta ya existente el link es magiclink (no crea otra)", async () => {
      const to = fresh("pac-cuenta");
      await addPatient(db, A, { email: to });
      const seeded = await gotrue.createUser({ email: to, emailConfirm: true });
      expect(seeded.ok).toBe(true);
      gotrue.calls.length = 0;

      expect(await requestPortalLink(form({ email: to }))).toEqual({ ok: true, data: { message: GENERIC } });
      expect(mail.sent).toHaveLength(1);
      const link = confirmLink(mail.sent[0]);
      expect(link!.q.next).toBe("/portal");
      expect(link!.q.type).toBe("magiclink");
      expect(gotrue.users.size).toBe(1);
    });

    it("slug de un consultorio donde NO tiene ficha → igual le llega el link, pero a /portal (sin nombrar ese consultorio)", async () => {
      const to = fresh("pac-otro");
      await addPatient(db, A, { email: to });
      await requestPortalLink(form({ email: to, slug: B.slug }));
      expect(mail.sent).toHaveLength(1);
      expect(confirmLink(mail.sent[0])!.q.next).toBe("/portal");
      expect(mail.sent[0].tenantId).toBe(A.tenantId);
    });

    it("[IAM-3c] email desconocido → misma respuesta, sin mail y sin tocar GoTrue (no se crea ninguna cuenta)", async () => {
      const r = await requestPortalLink(form({ email: fresh("nadie"), slug: A.slug }));
      expect(r).toEqual({ ok: true, data: { message: GENERIC } });
      expect(mail.sent).toHaveLength(0);
      expect(gotrue.calls).toHaveLength(0);
      expect(gotrue.users.size).toBe(0);
    });

    it("[IAM-3c] email de staff (Membership en otro consultorio) con ficha → misma respuesta y nada (AUDIT §5.22)", async () => {
      const staffEmail = `${A.userId}@test.local`;
      await addPatient(db, B, { email: staffEmail });
      const r = await requestPortalLink(form({ email: staffEmail, slug: B.slug }));
      expect(r).toEqual({ ok: true, data: { message: GENERIC } });
      expect(mail.sent).toHaveLength(0);
      expect(gotrue.calls).toHaveLength(0);
    });

    it("email que solo «parece» por comodín (`_`) → nada (match exacto, C-IAM4)", async () => {
      const s = uniqueSuffix();
      await addPatient(db, A, { email: `jperez${s}@test.local` });
      const r = await requestPortalLink(form({ email: `jpere_${s}@test.local` }));
      expect(r).toEqual({ ok: true, data: { message: GENERIC } });
      expect(mail.sent).toHaveLength(0);
      expect(gotrue.calls).toHaveLength(0);
    });

    it("email inválido → error de formato, sin mail", async () => {
      const r = await requestPortalLink(form({ email: "no-es-un-email" }));
      expect(r.ok).toBe(false);
      expect(mail.sent).toHaveLength(0);
    });

    it("GoTrue falla → misma respuesta genérica y sin mail", async () => {
      const to = fresh("pac-falla");
      await addPatient(db, A, { email: to });
      gotrue.failNext("error", "generateLink");
      expect(await requestPortalLink(form({ email: to }))).toEqual({ ok: true, data: { message: GENERIC } });
      expect(mail.sent).toHaveLength(0);
    });

    it("rate limit por hash del email: el 4º pedido del mismo email en la hora se frena (exista o no la ficha)", async () => {
      const to = fresh("pac-rl");
      await addPatient(db, A, { email: to });
      for (let i = 0; i < 3; i++) expect((await requestPortalLink(form({ email: to }))).ok).toBe(true);
      expect(mail.sent).toHaveLength(3);
      const fourth = await requestPortalLink(form({ email: to }));
      expect(fourth.ok).toBe(false);
      if (!fourth.ok) expect(fourth.error).toMatch(/Probá de nuevo en/);
      expect(mail.sent).toHaveLength(3);
      // Un email desconocido se frena igual: el límite no distingue (sin oráculo).
      const ghost = fresh("ghost");
      for (let i = 0; i < 3; i++) await requestPortalLink(form({ email: ghost }));
      __rateLimitInternals.reset();
      for (let i = 0; i < 3; i++) await requestPortalLink(form({ email: ghost }));
      expect((await requestPortalLink(form({ email: ghost }))).ok).toBe(false);
    });

    it("rate limit por IP: 5 pedidos cada 10 min (el header de IP es fijo en el harness)", async () => {
      for (let i = 0; i < 5; i++) expect((await requestPortalLink(form({ email: fresh("ip") }))).ok).toBe(true);
      const to = fresh("pac-ip");
      await addPatient(db, A, { email: to });
      const sixth = await requestPortalLink(form({ email: to }));
      expect(sixth.ok).toBe(false);
      expect(mail.sent).toHaveLength(0);
      expect(gotrue.calls).toHaveLength(0);
    });
  });

  // ── sendPatientPortalInvite ─────────────────────────────────────────

  describe("sendPatientPortalInvite", () => {
    beforeEach(() => {
      sb.user = { id: A.userId, email: `${A.userId}@test.local`, email_confirmed_at: new Date(0).toISOString() };
    });

    it("[IAM-3c] primera vez: mail portal_invite propio (sin inviteUserByEmail) con link a /auth/confirm y next=/portal/c/<slug>", async () => {
      const to = fresh("inv");
      const patientId = await addPatient(db, A, { email: to });
      const r = await sendPatientPortalInvite({ patientId });
      expect(r).toMatchObject({ ok: true, data: { emailSent: true, transport: "resend", emailStatus: "sent", emailReason: null } });
      if (r.ok) expect(r.data.portalUrl).toBe(`${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/portal/c/${A.slug}`);
      expect(admin.invites).toBe(0);

      expect(mail.sent).toHaveLength(1);
      const m = mail.sent[0];
      expect(m.kind).toBe("portal_invite");
      expect(m.to).toBe(to);
      expect(m.tenantId).toBe(A.tenantId);
      expect(m.entity).toBe("Patient");
      expect(m.entityId).toBe(patientId);
      expect(m.actorId).toBe(A.userId);
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { name: true } });
      expect(m.fromName).toBe(tenant.name);
      expect(m.subject).toContain(tenant.name);
      const link = confirmLink(m);
      expect(link!.path).toBe("/auth/confirm");
      expect(link!.q.next).toBe(`/portal/c/${A.slug}`);
      expect(gotrue.links.map((l) => l.type)).toEqual(["magiclink"]);

      const ev = await db.auditEvent.findFirst({
        where: { tenantId: A.tenantId, entityId: patientId, action: "patient.portal_invite" },
      });
      expect(ev?.payload).toMatchObject({ emailSent: true, transport: "resend", linked: false });
    });

    it("[IAM-3c] reenviar a un paciente YA vinculado funciona (antes: inviteUserByEmail → «already registered» siempre)", async () => {
      const to = fresh("inv-vinc");
      const patientId = await addPatient(db, A, { email: to });
      const seeded = await gotrue.createUser({ email: to, emailConfirm: true });
      if (!seeded.ok) throw new Error(seeded.code);
      const uid = await patientProfile(to);
      await db.patient.update({ where: { id: patientId }, data: { userId: uid } });

      const r = await sendPatientPortalInvite({ patientId });
      expect(r).toMatchObject({ ok: true, data: { emailSent: true, emailStatus: "sent" } });
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0].kind).toBe("portal_invite");
      expect(confirmLink(mail.sent[0])!.q.type).toBe("magiclink");
      expect(admin.invites).toBe(0);
      // El vínculo no se toca al reenviar.
      expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).userId).toBe(uid);
      const ev = await db.auditEvent.findFirst({
        where: { tenantId: A.tenantId, entityId: patientId, action: "patient.portal_invite.resend" },
      });
      expect(ev?.payload).toMatchObject({ emailSent: true, linked: true });
    });

    it("el resultado dice la verdad: entorno que no manda (log) → emailSent false, emailStatus skipped", async () => {
      const patientId = await addPatient(db, A, { email: fresh("inv-log") });
      mail.next = { ok: false, transport: "log", skipped: true, reason: "log_only" };
      const r = await sendPatientPortalInvite({ patientId });
      expect(r).toMatchObject({
        ok: true,
        data: { emailSent: false, transport: "log", emailStatus: "skipped", emailReason: "log_only" },
      });
    });

    it("GoTrue no emite el link → emailSent false, emailStatus failed y no se manda nada", async () => {
      const patientId = await addPatient(db, A, { email: fresh("inv-gotrue") });
      gotrue.failNext("error", "generateLink");
      const r = await sendPatientPortalInvite({ patientId });
      expect(r).toMatchObject({ ok: true, data: { emailSent: false, transport: null, emailStatus: "failed" } });
      expect(mail.sent).toHaveLength(0);
    });

    it("email de alguien del equipo del MISMO consultorio → rechaza sin emitir link (AUDIT §5.22)", async () => {
      const patientId = await addPatient(db, A, { email: `${A.userId}@test.local` });
      const r = await sendPatientPortalInvite({ patientId });
      expect(r.ok).toBe(false);
      expect(gotrue.calls).toHaveLength(0);
      expect(mail.sent).toHaveLength(0);
    });
  });

  // ── Vínculo Patient.userId al iniciar sesión (AUDIT §5.8) ───────────

  describe("linkPortalPatientsOnSignIn", () => {
    it("next=/portal vincula la ficha en CADA consultorio con ese email exacto", async () => {
      const to = fresh("link-todos");
      const pa = await addPatient(db, A, { email: to.toUpperCase() });
      const pb = await addPatient(db, B, { email: to });
      const uid = await patientProfile(to);
      const r = await linkPortalPatientsOnSignIn({ id: uid, email: to, emailVerified: true }, "/portal");
      expect(r.sort()).toEqual(["linked", "linked"]);
      expect((await db.patient.findUniqueOrThrow({ where: { id: pa } })).userId).toBe(uid);
      expect((await db.patient.findUniqueOrThrow({ where: { id: pb } })).userId).toBe(uid);
      expect(await db.patientTenantLink.count({ where: { patientId: { in: [pa, pb] } } })).toBe(2);
    });

    it("next=/portal/c/<slug> vincula solo ese consultorio", async () => {
      const to = fresh("link-uno");
      const pa = await addPatient(db, A, { email: to });
      const pb = await addPatient(db, B, { email: to });
      const uid = await patientProfile(to);
      await linkPortalPatientsOnSignIn({ id: uid, email: to, emailVerified: true }, `/portal/c/${B.slug}`);
      expect((await db.patient.findUniqueOrThrow({ where: { id: pa } })).userId).toBeNull();
      expect((await db.patient.findUniqueOrThrow({ where: { id: pb } })).userId).toBe(uid);
    });

    it("fuera del portal (staff que entra al dashboard) no vincula nada", async () => {
      const to = fresh("link-dash");
      const pa = await addPatient(db, A, { email: to });
      const uid = await patientProfile(to);
      expect(await linkPortalPatientsOnSignIn({ id: uid, email: to, emailVerified: true }, "/dashboard")).toEqual([]);
      expect((await db.patient.findUniqueOrThrow({ where: { id: pa } })).userId).toBeNull();
    });

    it("sin email verificado no vincula", async () => {
      const to = fresh("link-unverified");
      const pa = await addPatient(db, A, { email: to });
      const uid = await patientProfile(to);
      expect(await linkPortalPatientsOnSignIn({ id: uid, email: to, emailVerified: false }, "/portal")).toEqual([]);
      expect((await db.patient.findUniqueOrThrow({ where: { id: pa } })).userId).toBeNull();
    });

    it("[IAM-3c] nunca re-vincula una ficha de otra identidad, y el log de rechazo no lleva el email", async () => {
      const to = fresh("link-ajena");
      const pa = await addPatient(db, A, { email: to });
      const owner = await patientProfile(to);
      await db.patient.update({ where: { id: pa }, data: { userId: owner } });
      const intruder = await patientProfile(`otro-${uniqueSuffix()}@test.local`);
      const warns: Array<[string, Record<string, unknown> | undefined]> = [];
      vi.spyOn(logger, "warn").mockImplementation((msg: string, ctx?: Record<string, unknown>) => {
        warns.push([msg, ctx]);
      });
      const r = await linkPortalPatientsOnSignIn({ id: intruder, email: to, emailVerified: true }, `/portal/c/${A.slug}`);
      expect(r).toEqual(["linked_elsewhere"]);
      expect((await db.patient.findUniqueOrThrow({ where: { id: pa } })).userId).toBe(owner);
      const refused = warns.filter(([m]) => m === "portal.link.refused");
      expect(refused).toHaveLength(1);
      expect(JSON.stringify(refused[0][1])).not.toContain("@");
    });

    it("dos fichas con el mismo email en un consultorio (familia; el único (tenantId, email) distingue mayúsculas): vincula una sola y no rompe al volver a entrar", async () => {
      const to = fresh("link-familia");
      const p1 = await addPatient(db, A, { email: to });
      const p2 = await addPatient(db, A, { email: to.toUpperCase() });
      const uid = await patientProfile(to);
      expect(await linkPortalPatientsOnSignIn({ id: uid, email: to, emailVerified: true }, "/portal")).toEqual(["linked"]);
      // Segunda entrada: (tenantId, userId) es único → antes podía elegir la otra ficha y tirar P2002.
      expect(await linkPortalPatientsOnSignIn({ id: uid, email: to, emailVerified: true }, "/portal")).toEqual(["linked"]);
      const linked = await db.patient.count({ where: { id: { in: [p1, p2] }, userId: uid } });
      expect(linked).toBe(1);
    });
  });

  // ── Callback de OAuth (Google) ──────────────────────────────────────

  describe("callback de Google", () => {
    it("[IAM-3c] borra kine_tenant (decisión 6) y, con next=/portal, vincula la ficha (antes nunca: nadie mandaba ?tenant=)", async () => {
      const to = fresh("google");
      const pa = await addPatient(db, A, { email: to });
      const uid = `test-portal-${uniqueSuffix()}`;
      profiles.push(uid);
      sb.user = { id: uid, email: to, email_confirmed_at: new Date().toISOString(), user_metadata: { full_name: "Paci Ente" } };
      const res = await callbackGET(new Request(`${ORIGIN}/auth/callback?code=abc&next=/portal`));
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/portal");
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(new RegExp(`${ACTIVE_TENANT_COOKIE}=;`));
      expect(setCookie).toMatch(/Max-Age=0/i);
      expect(setCookie).toMatch(/Path=\//i);
      expect((await db.patient.findUniqueOrThrow({ where: { id: pa } })).userId).toBe(uid);
    });

    it("staff que entra al dashboard también limpia kine_tenant y no se vincula a fichas", async () => {
      const staffEmail = `${A.userId}@test.local`;
      // La ficha de B con el email del OWNER de A puede venir de un test anterior (único (tenantId, email)).
      const pb =
        (await db.patient.findFirst({ where: { tenantId: B.tenantId, email: staffEmail }, select: { id: true } }))?.id ??
        (await addPatient(db, B, { email: staffEmail }));
      sb.user = { id: A.userId, email: staffEmail, email_confirmed_at: new Date().toISOString() };
      const res = await callbackGET(new Request(`${ORIGIN}/auth/callback?code=abc&next=/portal`));
      expect(res.headers.get("set-cookie") ?? "").toMatch(new RegExp(`${ACTIVE_TENANT_COOKIE}=;`));
      expect((await db.patient.findUniqueOrThrow({ where: { id: pb } })).userId).toBeNull();
    });
  });
});
