import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { createEphemeralTenant, deleteTenantDeep, uniqueSuffix } from "../../helpers/tenant-factory";
import { E2E_BASE_URL, E2E_PASSWORD, E2E_STATE_DIR } from "./e2e-constants.mjs";
import { blockExternal } from "./plans";

/**
 * PV (§27, ola Q4, sesión E2E) · fixtures de `tickets.spec.ts`, `legal.spec.ts` e `idle.spec.ts`, con la MISMA factory
 * que la integración (nunca seeds). Los arma `global-setup.ts` y los borra `global-teardown.ts`; si una corrida se
 * corta, `sweepOrphanTestTenants` barre los consultorios (slug `test-`) y `sweepPvLeftovers` el resto (perfiles sin
 * consultorio y tickets LEAD, que no cuelgan de ningún tenant).
 *
 *  - `superadmin`: perfil con `isPlatformAdmin` y SIN consultorio (BO1-A: Plataforma no necesita «casa»), sin 2FA
 *    (con `PLATFORM_MFA_ENFORCEMENT` en off, el default, Tickets son acciones low/medium: no piden step-up).
 *  - `suspended`: Individual con `Tenant.status = SUSPENDED` y su Titular (TK: ticket «Consultorio suspendido»).
 *  - `disabled`: perfil con `disabledAt` y sin consultorio (TK: ticket LEAD «Cuenta desactivada»).
 *  - `idle`: consultorio propio para el cierre por inactividad. Propio y no el del fixture principal: el spec hace 4
 *    logins con el mismo email (rate limit por email: 10 / 15', `app/api/auth/sign-in/route.ts`) y avanza el reloj.
 *    Lleva además una invitación PENDIENTE a un email sin cuenta (LG: la activación muestra la casilla).
 *  - `legalGate` (LG-G): Individual cuyo Titular NO aceptó los Términos (`acceptLegal: false`; el resto de los usuarios
 *    de la factory nacen con la aceptación): entra a `/agenda` → `/aceptar-terminos?…&via=app_gate` → tilda → vuelve.
 *  - `leadEmailPrefix`: los leads que manda el spec usan `pv-lead-…@test.local`; el teardown borra esos hilos.
 *
 * Ids a `pv.json` (no a `fixture.json`, cuyo tipo es de otra sesión). Los usuarios se suman al `users.json` del GoTrue
 * falso desde el global-setup.
 */
export const E2E_PV_FILE = resolve(E2E_STATE_DIR, "pv.json");

type User = { id: string; email: string; password: string; fullName: string };

export type PvFixture = {
  superadmin: User;
  suspended: { tenantId: string; tenantName: string; owner: User };
  disabled: User;
  idle: { tenantId: string; owner: User; invite: { token: string; email: string; firstName: string } };
  legalGate: { tenantId: string; owner: User };
  leadEmailPrefix: string;
};

/**
 * Espejo de `hashInviteToken` (lib/invitations-tokens.ts): ese módulo es `server-only` y no se puede importar fuera de
 * Next. Si el hash cambiara allá, el spec de la invitación falla con «No encontramos la invitación» (no en silencio).
 */
const hashInviteToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

const PV_USER_PREFIX = "test-user-pv-";
const LEAD_PREFIX = "pv-lead-";

async function userOf(db: PrismaClient, id: string): Promise<User> {
  const u = await db.userProfile.findUniqueOrThrow({ where: { id }, select: { email: true, fullName: true } });
  return { id, email: u.email, password: E2E_PASSWORD, fullName: u.fullName ?? "E2E" };
}

/** Hilos LEAD de corridas de PV (no tienen tenant: `deleteTenantDeep` no los ve). Notas y mensajes son RESTRICT. */
async function deletePvLeadThreads(db: PrismaClient): Promise<void> {
  const where = {
    kind: "LEAD" as const,
    leadEmail: { endsWith: "@test.local" },
    OR: [{ leadEmail: { startsWith: LEAD_PREFIX } }, { leadEmail: { startsWith: PV_USER_PREFIX } }],
  };
  const ids = (await db.supportThread.findMany({ where, select: { id: true } })).map((t) => t.id);
  if (ids.length === 0) return;
  await db.supportTicketNote.deleteMany({ where: { threadId: { in: ids } } });
  await db.supportMessage.deleteMany({ where: { threadId: { in: ids } } });
  await db.supportThread.deleteMany({ where: { id: { in: ids } } });
}

/** Perfiles de PV sin consultorio (superadmin, deshabilitado) que quedaron de una corrida cortada. */
async function deletePvLooseProfiles(db: PrismaClient, ids?: string[]): Promise<void> {
  const loose = await db.userProfile.findMany({
    where: { id: ids ? { in: ids } : { startsWith: PV_USER_PREFIX }, memberships: { none: {} }, practitioners: { none: {} } },
    select: { id: true },
  });
  const removable = loose.map((u) => u.id);
  if (removable.length === 0) return;
  await db.supportSession.deleteMany({ where: { superadminId: { in: removable } } });
  await db.userPreferences.deleteMany({ where: { userId: { in: removable } } });
  await db.userProfile.deleteMany({ where: { id: { in: removable } } });
}

export async function sweepPvLeftovers(db: PrismaClient): Promise<void> {
  await deletePvLeadThreads(db);
  await deletePvLooseProfiles(db);
}

export async function createPvFixtures(db: PrismaClient): Promise<PvFixture> {
  const s = uniqueSuffix();

  const superadminId = `${PV_USER_PREFIX}sa-${s}`;
  await db.userProfile.create({
    data: { id: superadminId, email: `${superadminId}@test.local`, fullName: "Sofía Plataforma E2E", isPlatformAdmin: true },
  });

  const disabledId = `${PV_USER_PREFIX}off-${s}`;
  await db.userProfile.create({
    data: { id: disabledId, email: `${disabledId}@test.local`, fullName: "Diego Desactivado E2E", disabledAt: new Date() },
  });

  const sus = await createEphemeralTenant(db, { role: "OWNER", saasPlan: "INDIVIDUAL", vertical: "KINESIOLOGY" });
  const susTenant = await db.tenant.update({
    where: { id: sus.tenantId },
    data: { status: "SUSPENDED" },
    select: { name: true },
  });

  const idle = await createEphemeralTenant(db, { role: "OWNER", saasPlan: "INDIVIDUAL", vertical: "KINESIOLOGY" });
  // Token con la forma de `TOKEN_SHAPE` (lib/invitations-internal.ts); en la base va solo el hash, como en prod.
  const token = randomBytes(24).toString("base64url");
  const inviteEmail = `${PV_USER_PREFIX}inv-${s}@test.local`;
  await db.invitation.create({
    data: {
      tenantId: idle.tenantId,
      email: inviteEmail,
      firstName: "Inés",
      lastName: "Invitada E2E",
      role: "PRACTITIONER",
      token: hashInviteToken(token),
      invitedById: idle.userId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });

  const legal = await createEphemeralTenant(db, {
    role: "OWNER",
    saasPlan: "INDIVIDUAL",
    vertical: "KINESIOLOGY",
    acceptLegal: false,
  });

  const fx: PvFixture = {
    superadmin: await userOf(db, superadminId),
    suspended: { tenantId: sus.tenantId, tenantName: susTenant.name, owner: await userOf(db, sus.userId) },
    disabled: await userOf(db, disabledId),
    idle: { tenantId: idle.tenantId, owner: await userOf(db, idle.userId), invite: { token, email: inviteEmail, firstName: "Inés" } },
    legalGate: { tenantId: legal.tenantId, owner: await userOf(db, legal.userId) },
    leadEmailPrefix: LEAD_PREFIX,
  };
  writeFileSync(E2E_PV_FILE, JSON.stringify(fx, null, 2));
  return fx;
}

export function pvUsers(fx: PvFixture): User[] {
  return [fx.superadmin, fx.suspended.owner, fx.disabled, fx.idle.owner, ...(fx.legalGate ? [fx.legalGate.owner] : [])];
}

export function readPvFixture(): PvFixture {
  return JSON.parse(readFileSync(E2E_PV_FILE, "utf8")) as PvFixture;
}

export async function deletePvFixtures(db: PrismaClient): Promise<void> {
  await deletePvLeadThreads(db);
  if (!existsSync(E2E_PV_FILE)) return;
  const fx = readPvFixture();
  // `legalGate` puede faltar en un `pv.json` de una corrida de antes de LG-G (el sweep de huérfanos igual lo barre).
  for (const id of [fx.suspended.tenantId, fx.idle.tenantId, fx.legalGate?.tenantId]) if (id) await deleteTenantDeep(db, id);
  await deletePvLooseProfiles(db, [fx.superadmin.id, fx.disabled.id]);
  for (const u of pvUsers(fx)) rmSync(pvSessionFile(u), { force: true });
  rmSync(E2E_PV_FILE, { force: true });
}

// ── Sesiones ───────────────────────────────────────────────────────────────────────────────────────────────────────

function pvSessionFile(u: User): string {
  return resolve(E2E_STATE_DIR, `pv-session-${u.id}.json`);
}

/**
 * IP propia por contexto (`X-Forwarded-For`, que lee `lib/client-ip.ts`). El login tiene rate limit por IP (10/min,
 * `app/api/auth/sign-in/route.ts`), en memoria del único server de la suite: sin esto, los 8 logins de estas specs
 * (4 del cierre por inactividad) más los de `login`/`plans-matrix`/`portal` pasaban el cupo y esas specs terminaban en
 * `/login?error=rate_limited` (medido en la primera corrida completa). Cada contexto es «otra compu»; el cupo por email
 * (10 / 15') sigue valiendo. Rango privado 10.27.x.y: nunca una IP real.
 */
let ipSeq = 0;
function contextOptions(storageState: string | { cookies: []; origins: [] }) {
  ipSeq += 1;
  return {
    baseURL: E2E_BASE_URL,
    storageState,
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { "x-forwarded-for": `10.27.${(process.pid % 250) + 1}.${(ipSeq % 250) + 1}` },
  };
}

/** Contexto limpio (sin la sesión del Titular del fixture), en hora AR y sin red fuera del server local. */
export async function freshContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext(contextOptions({ cookies: [], origins: [] }));
  await blockExternal(ctx);
  return ctx;
}

/**
 * Login por el form REAL de /login. `remember: false` destilda «Mantenerme conectado» (sesión de navegador →
 * cierre por inactividad). `next` va en la URL del login (la ruta lo valida con `safeNext`). Espera a salir de /login.
 */
export async function submitLogin(page: Page, u: User, opts: { remember?: boolean; next?: string } = {}): Promise<void> {
  if (!/\/login/.test(new URL(page.url()).pathname)) {
    await page.goto(opts.next ? `/login?next=${encodeURIComponent(opts.next)}` : "/login");
  }
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(u.password);
  const remember = page.getByLabel("Mantenerme conectado");
  if (opts.remember === false) await remember.uncheck();
  else await remember.check();
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login") || url.searchParams.has("error"));
  expect(new URL(page.url()).searchParams.get("error"), `login de ${u.email}`).toBeNull();
}

/**
 * Contexto logueado con `u`. La sesión se guarda en `.state` y se reusa en la corrida (el login tiene rate limit por IP,
 * 10/min, y en la suite entera se suman los de todas las specs). `probe` = ruta para comprobar que la sesión guardada
 * sigue viva (si rebota a /login, se vuelve a loguear).
 */
export async function pvLoginAs(browser: Browser, u: User, probe: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const statePath = pvSessionFile(u);
  const cached = existsSync(statePath);
  const ctx = cached
    ? await browser.newContext(contextOptions(statePath))
    : await freshContext(browser);
  if (cached) await blockExternal(ctx);
  const page = await ctx.newPage();
  if (cached) {
    await page.goto(probe);
    if (!/\/login/.test(new URL(page.url()).pathname)) return { ctx, page };
  }
  await page.goto(`/login?next=${encodeURIComponent(probe)}`);
  await submitLogin(page, u);
  await ctx.storageState({ path: statePath });
  return { ctx, page };
}
