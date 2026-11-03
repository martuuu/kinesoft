import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { PrismaClient, SaasPlan, TenantVertical } from "@prisma/client";
import { addPatient, addRoom, addStaff, createEphemeralTenant, deleteTenantDeep, ownerClient } from "../../helpers/tenant-factory";
import { modulesFor, type TenantEntitlements, type TenantModule } from "../../../lib/tenant-modules";
import { NAV_ITEMS, navFor } from "../../../lib/nav";
import { capabilitiesForMember } from "../../../lib/capabilities";
import { E2E_BASE_URL, E2E_PASSWORD, E2E_STATE_DIR } from "./e2e-constants.mjs";

/**
 * QA-E (T6+T7, X8; brief §26.8) · fixtures multi-plan de `plans-matrix.spec.ts`, con la MISMA factory que la integración
 * (nunca seeds). Los arma `global-setup.ts` además del consultorio de siempre (Individual · Kinesiología) y los borra
 * `global-teardown.ts`; si una corrida se corta, `sweepOrphanTestTenants` los barre a los 30' (slug `test-`).
 *
 *  - `general`: Consultorio · General, Titular + Secretaría (ASSISTANT, no clínica) y una paciente con un turno de ayer con
 *    $50 de copago sin cobrar (la Secretaría lo cobra con medio).
 *  - `clinica`: Clínica · Kinesiología, Titular + 2 salas en la sede principal.
 *  - `readOnly`: Individual · Kinesiología con la prueba vencida hace 10 días (> `TRIAL_GRACE_DAYS` = 7 → `read_only`,
 *    reason `trial_expired`).
 *
 * Los ids van a un archivo propio (`plans.json`) y no a `fixture.json`: el tipo `E2EFixture` es de otra sesión y las
 * specs de antes no necesitan nada de esto. Los usuarios se suman al `users.json` del GoTrue falso desde el global-setup.
 */
export const E2E_PLANS_FILE = resolve(E2E_STATE_DIR, "plans.json");

type User = { id: string; email: string; password: string; fullName: string };
type PlanTenant = { tenantId: string; slug: string; vertical: TenantVertical; plan: SaasPlan; owner: User };

export type PlansFixture = {
  general: PlanTenant & { assistant: User; patient: { id: string; firstName: string; lastName: string }; payBookingId: string };
  clinica: PlanTenant & { roomIds: string[] };
  readOnly: PlanTenant;
};

const DAY = 86_400_000;

/** Ayer a las 11:00 de Argentina (UTC−3 fijo). El host puede estar en cualquier TZ. */
function arYesterdayAt11(): Date {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const d = new Date(`${today}T14:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

async function userOf(db: PrismaClient, id: string): Promise<User> {
  const u = await db.userProfile.findUniqueOrThrow({ where: { id }, select: { email: true, fullName: true } });
  return { id, email: u.email, password: E2E_PASSWORD, fullName: u.fullName ?? "E2E" };
}

export async function createPlansFixtures(db: PrismaClient): Promise<PlansFixture> {
  // (A) Consultorio · General con Secretaría.
  const g = await createEphemeralTenant(db, { role: "OWNER", saasPlan: "CONSULTORIO", vertical: "GENERAL" });
  const gLocation = await db.location.create({ data: { tenantId: g.tenantId, name: "Principal", isPrimary: true } });
  const sec = await addStaff(db, g, "ASSISTANT");
  const gPatient = { firstName: "Rocío", lastName: "Secretaría E2E" };
  const gPatientId = await addPatient(db, g, gPatient);
  const pay = await db.booking.create({
    data: {
      tenantId: g.tenantId,
      patientId: gPatientId,
      practitionerId: g.practitionerId,
      serviceId: g.serviceId,
      locationId: gLocation.id,
      scheduledFor: arYesterdayAt11(),
      durationMin: 45,
      status: "CONFIRMED",
      copagoCents: 5000,
      idempotencyKey: `e2e-qa-pay-${g.tenantId}`,
    },
    select: { id: true },
  });

  // (B) Clínica · Kinesiología con 2 salas.
  const c = await createEphemeralTenant(db, { role: "OWNER", saasPlan: "CLINICA", vertical: "KINESIOLOGY" });
  const r1 = await addRoom(db, c, { name: "Box 1" });
  const r2 = await addRoom(db, c, { name: "Box 2", locationId: r1.locationId });

  // (C) Individual · Kinesiología con la prueba vencida hace 10 días: `tenantAccessFor` → read_only / trial_expired.
  const ro = await createEphemeralTenant(db, { role: "OWNER", saasPlan: "INDIVIDUAL", vertical: "KINESIOLOGY" });
  await db.tenant.update({
    where: { id: ro.tenantId },
    data: { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 10 * DAY), subscriptionStatusChangedAt: new Date(Date.now() - 24 * DAY) },
  });

  const fx: PlansFixture = {
    general: {
      tenantId: g.tenantId,
      slug: g.slug,
      vertical: "GENERAL",
      plan: "CONSULTORIO",
      owner: await userOf(db, g.userId),
      assistant: await userOf(db, sec.userId),
      patient: { id: gPatientId, ...gPatient },
      payBookingId: pay.id,
    },
    clinica: { tenantId: c.tenantId, slug: c.slug, vertical: "KINESIOLOGY", plan: "CLINICA", owner: await userOf(db, c.userId), roomIds: [r1.roomId, r2.roomId] },
    readOnly: { tenantId: ro.tenantId, slug: ro.slug, vertical: "KINESIOLOGY", plan: "INDIVIDUAL", owner: await userOf(db, ro.userId) },
  };
  writeFileSync(E2E_PLANS_FILE, JSON.stringify(fx, null, 2));
  return fx;
}

/** Usuarios para el `users.json` del GoTrue falso. */
export function plansUsers(fx: PlansFixture): User[] {
  return [fx.general.owner, fx.general.assistant, fx.clinica.owner, fx.readOnly.owner];
}

export async function deletePlansFixtures(db: PrismaClient): Promise<void> {
  if (!existsSync(E2E_PLANS_FILE)) return;
  const fx = readPlansFixture();
  for (const t of [fx.general, fx.clinica, fx.readOnly]) await deleteTenantDeep(db, t.tenantId);
}

export function readPlansFixture(): PlansFixture {
  return JSON.parse(readFileSync(E2E_PLANS_FILE, "utf8")) as PlansFixture;
}

// ── Sesiones ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Todo lo que no sea el server local se aborta (fuentes, YouTube, Meta, MP real…): nada sale de la máquina. */
export async function blockExternal(ctx: BrowserContext): Promise<void> {
  const origin = new URL(E2E_BASE_URL).origin;
  await ctx.route(
    (url) => url.origin !== origin,
    (route) => route.abort()
  );
}

/**
 * Contexto nuevo SIN la sesión del Titular del fixture, logueado por el form REAL de /login (como `auth.setup.ts`) con
 * otro usuario del GoTrue falso.
 */
export async function loginAs(browser: Browser, u: User): Promise<{ ctx: BrowserContext; page: Page }> {
  // UNA vez por usuario y por corrida: el login tiene rate limit por IP (10/min, lib/rate-limit.ts) y en la suite entera
  // los logins de otras specs más los de acá lo pasaban (`/login?error=rate_limited`). La sesión se guarda en `.state`
  // (la borra el teardown) y las siguientes la reusan; el refresh token del GoTrue falso la renueva si hiciera falta.
  const statePath = resolve(E2E_STATE_DIR, `qa-session-${u.id}.json`);
  const cached = existsSync(statePath);
  const ctx = await browser.newContext({
    baseURL: E2E_BASE_URL,
    storageState: cached ? statePath : { cookies: [], origins: [] },
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    viewport: { width: 1366, height: 768 },
  });
  await blockExternal(ctx);
  const page = await ctx.newPage();
  if (cached) {
    await page.goto("/dashboard");
    if (!/\/login/.test(new URL(page.url()).pathname)) return { ctx, page };
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill(u.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(u.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/dashboard") || url.searchParams.has("error"));
  expect(new URL(page.url()).searchParams.get("error"), `login de ${u.email}`).toBeNull();
  await ctx.storageState({ path: statePath });
  return { ctx, page };
}

/** Las sesiones guardadas por `loginAs` (las borra el teardown con el resto del estado de la corrida). */
export function plansSessionFiles(fx: PlansFixture): string[] {
  return plansUsers(fx).map((u) => resolve(E2E_STATE_DIR, `qa-session-${u.id}.json`));
}

// ── Oráculo del menú (§26.8: se deriva, no se copia a mano) ────────────────────────────────────────────────────────

/**
 * El menú que el layout `(app)` tiene que mostrar para ESTE usuario en ESTE consultorio: entitlements y membresía leídos
 * de la base local → `modulesFor` + `capabilitiesForMember` → `navFor` con `onlinePayments: true` (cobros online prendidos: el E2E corre con
 * `MP_CONNECT_MODE=fake`). Es lo mismo que arma `app/(app)/layout.tsx`, desde las funciones puras.
 */
export async function expectedNavFor(tenantId: string, userId: string): Promise<string[]> {
  const db = ownerClient();
  try {
    const t = await db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { vertical: true, saasPlan: true, publicBookingEnabled: true, moduleGrants: true, moduleRevokes: true },
    });
    const m = await db.membership.findFirstOrThrow({
      where: { tenantId, userId },
      select: { role: true, clinical: true, grantSettings: true, grantBilling: true },
    });
    const ents: TenantEntitlements = {
      vertical: t.vertical,
      plan: t.saasPlan,
      publicBookingEnabled: t.publicBookingEnabled,
      moduleGrants: t.moduleGrants as TenantModule[],
      moduleRevokes: t.moduleRevokes as TenantModule[],
    };
    return navFor(modulesFor(ents), capabilitiesForMember(m), { onlinePayments: true }).map((i) => i.href);
  } finally {
    await db.$disconnect();
  }
}

const NAV_HREFS = new Set(NAV_ITEMS.map((i) => i.href));

/** Los destinos del sidebar de escritorio (secciones + Configuración del pie), en orden y sin repetidos. */
export async function sidebarHrefs(page: Page): Promise<string[]> {
  const aside = page.getByRole("complementary", { name: "Navegación principal" });
  await expect(aside.getByRole("navigation", { name: "Secciones" })).toBeVisible();
  const hrefs = await aside.locator("a[href]").evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
  return [...new Set(hrefs.filter((h) => NAV_HREFS.has(h)))];
}
