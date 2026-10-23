/**
 * QA-M (T6+T7, plan §26.8) · matriz de routing por plan: 4 planes SaaS × 2 verticales × roles, con el Actor REAL armado
 * por la base (`getActor`/`buildActor` sin mockear; solo la sesión de Supabase, la cookie y `next/cache`, como el resto de
 * la integración). Corre en los dos roles de DB (`test:integration` = kinesoft_app con RLS, `:owner` = BYPASSRLS = prod).
 *
 * Oráculo (§26.8): la expectativa se DERIVA de `modulesFor` / `minimumPlanFor` (`lib/tenant-modules.ts`), de
 * `capabilitiesForMember` (`lib/capabilities.ts`) y de los cupos de `PLAN_DEFAULTS` (`lib/saas-plans-logic.ts`); no se
 * copia la matriz a mano. Lo que se ejecuta es el símbolo de prod: el `layout.tsx` de cada segmento (que llama a
 * `moduleWall`), `navFor` + `shellNavCaps` como los usa `app/(app)/layout.tsx`, `getSeatUsageInTx` + `canAddSeat` (lo que
 * frena una invitación), `runWithRls`/`createClinicalNote`/`getPatientTimeline` con `TENANT_ACCESS_ENFORCEMENT=enforce`,
 * `resolveDisplaySession` de `/tv` y el escritor único de entitlements (source `platform`) para los overrides.
 * Además se fijan 8 casos literales críticos, para que un oráculo roto no arrastre a la matriz entera.
 *
 * Por qué se llama al layout y no solo a `moduleWall`: el bug que importa es «una ruta sin muro» (un layout que pierde el
 * guard o que mira el módulo equivocado). Llamando al layout real, un segmento sin muro da "ok" donde el oráculo dice
 * upsell/redirect y la fila falla.
 *
 * Fuera de alcance acá (los cubre otro archivo): las pestañas de Configuración por rol (`visibleConfigTabs` necesita lo que
 * arma el loader de la página; ver `pl3a-*` / `configuracion-*`) y el turnero (es un switch, no depende del plan).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Fragment, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { cookies } from "next/headers";
import type { PrismaClient, Role, SaasPlan, TenantVertical } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getActor, getSessionBlock, tryGetActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { moduleWall, type ModuleWallResult } from "@/lib/module-wall";
import { navFor, shellNavCaps } from "@/lib/nav";
import { mpConnectMode } from "@/lib/env";
import { capabilitiesForMember, type Capability } from "@/lib/capabilities";
import {
  MODULE_REVOKED_COPY,
  SAAS_PLAN_LABEL,
  isModuleOverridable,
  minimumPlanFor,
  modulesFor,
  planRank,
  type TenantEntitlements,
  type TenantModule,
} from "@/lib/tenant-modules";
import { PLAN_DEFAULTS, SAAS_PLANS } from "@/lib/saas-plans-logic";
import { canAddSeat } from "@/lib/plan-catalog";
import { getSeatUsageInTx } from "@/lib/team-internal";
import { READ_ONLY_MESSAGE, ReadOnlyModeError, PAST_DUE_GRACE_DAYS, TRIAL_GRACE_DAYS } from "@/lib/tenant-access";
import { createClinicalNote } from "@/lib/clinical-notes";
import { getPatientTimeline } from "@/lib/clinical-notes-read";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { resolveDisplaySession } from "@/lib/display-device-internal";
import { hashDeviceSecret, makeDisplayCookie, newDeviceSecret } from "@/lib/display-pairing-internal";
import { DISPLAY_COOKIE } from "@/lib/reception-displays-types";
import { toARDateKey } from "@/lib/datetime-ar";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { AccessWall, accessWallDisabledTitle, accessWallTitle } from "@/components/ui/access-wall";
import { GET as exportTenant } from "@/app/api/consultorio/export/route";
import CobrosPage from "@/app/(app)/cobros/page";
import PlanesLayout from "@/app/(app)/planes/layout";
import SeguimientoLayout from "@/app/(app)/seguimiento/layout";
import DiagnosticoLayout from "@/app/(app)/diagnostico/layout";
import BibliotecaLayout from "@/app/(app)/biblioteca/layout";
import TerapiaManualLayout from "@/app/(app)/terapia-manual/layout";
import ReportesLayout from "@/app/(app)/reportes/layout";
import SalaLayout from "@/app/(app)/sala/layout";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  addPatient,
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;
const VERTICALS: readonly TenantVertical[] = ["GENERAL", "KINESIOLOGY"];

// ── Roles ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type RoleKey = "OWNER_CLIN" | "OWNER_NOCLIN" | "ADMIN" | "ASSISTANT" | "PRACTITIONER" | "BILLING";

/**
 * La membresía que arma cada rol, en la forma que lee `capabilitiesForMember` (el oráculo de capacidades). ADMIN entra
 * con «Configuración» y «Planes y pagos», como lo deja `grantsOnEnterRole` (ROLE_ENTRY_GRANTS) al invitarlo hoy.
 */
const MEMBER_SPEC: Record<RoleKey, { role: Role; clinical: boolean; grantSettings: boolean; grantBilling: boolean }> = {
  OWNER_CLIN: { role: "OWNER", clinical: true, grantSettings: false, grantBilling: false },
  OWNER_NOCLIN: { role: "OWNER", clinical: false, grantSettings: false, grantBilling: false },
  ADMIN: { role: "ADMIN", clinical: false, grantSettings: true, grantBilling: true },
  ASSISTANT: { role: "ASSISTANT", clinical: false, grantSettings: false, grantBilling: false },
  PRACTITIONER: { role: "PRACTITIONER", clinical: true, grantSettings: false, grantBilling: false },
  BILLING: { role: "BILLING", clinical: false, grantSettings: false, grantBilling: false },
};

/**
 * «Donde el plan lo permita» (§26.8 y el armado de `qa-tenants`): Individual = Titular (clínico o no: un Titular que no
 * atiende es posible en cualquier plan); Consultorio = Titular + Admin + Secretaría + Profesional; Clínica y Libre suman
 * Facturación. Los miembros se crean directo por la factory (sin el chequeo de cupo): los muros y el menú no dependen de
 * cuántos haya; los cupos se prueban aparte, con consultorios propios.
 */
const ROLES_BY_PLAN: Record<SaasPlan, readonly RoleKey[]> = {
  INDIVIDUAL: ["OWNER_CLIN", "OWNER_NOCLIN"],
  CONSULTORIO: ["OWNER_CLIN", "OWNER_NOCLIN", "ADMIN", "ASSISTANT", "PRACTITIONER"],
  CLINICA: ["OWNER_CLIN", "OWNER_NOCLIN", "ADMIN", "ASSISTANT", "PRACTITIONER", "BILLING"],
  LIBRE: ["OWNER_CLIN", "OWNER_NOCLIN", "ADMIN", "ASSISTANT", "PRACTITIONER", "BILLING"],
};

// ── Segmentos con muro ─────────────────────────────────────────────────────────────────────────────────────────────

type Layout = (p: { children: ReactNode }) => Promise<ReactElement>;

/**
 * Segmento → (layout real, módulo que DEBE exigir). El módulo esperado es el del contrato (nav + §26.8), no el que lee
 * el layout: si un layout pasara a mirar otro módulo, la fila se rompe acá.
 */
const SEGMENTS: ReadonlyArray<{ seg: string; module: TenantModule; layout: Layout }> = [
  { seg: "planes", module: "planes", layout: PlanesLayout as Layout },
  { seg: "seguimiento", module: "sesiones", layout: SeguimientoLayout as Layout },
  { seg: "diagnostico", module: "diagnostico", layout: DiagnosticoLayout as Layout },
  { seg: "biblioteca", module: "ejercicios", layout: BibliotecaLayout as Layout },
  { seg: "terapia-manual", module: "ejercicios", layout: TerapiaManualLayout as Layout },
  { seg: "reportes", module: "reportes", layout: ReportesLayout as Layout },
  { seg: "sala", module: "salaEspera", layout: SalaLayout as Layout },
];

type WallClass = "ok" | "redirect" | { plan: SaasPlan; canBuy: boolean; title: string } | { disabled: true; title: string };

/** Corre el layout real y clasifica: children tal cual → ok; `redirect()` → redirect; `<AccessWall>` → upsell/disabled. */
async function runLayout(layout: Layout): Promise<WallClass> {
  const marker = createElement("span", { "data-marker": "children" });
  let out: ReactElement;
  try {
    out = await layout({ children: marker });
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      // El muro solo redirige a /dashboard (D-VX20); otro destino sería otro bug.
      expect(digest).toContain(";/dashboard;");
      return "redirect";
    }
    throw e;
  }
  expect(isValidElement(out)).toBe(true);
  if (out.type === Fragment) {
    expect((out.props as { children: unknown }).children).toBe(marker);
    return "ok";
  }
  expect(out.type).toBe(AccessWall);
  const p = out.props as { module: TenantModule; plan?: SaasPlan; canBuy?: boolean; disabled?: true };
  if (p.disabled) return { disabled: true, title: accessWallDisabledTitle(p.module) };
  return { plan: p.plan as SaasPlan, canBuy: p.canBuy === true, title: accessWallTitle(p.module, p.plan as SaasPlan) };
}

/** Oráculo del muro, desde la matriz (`modulesFor`/`minimumPlanFor`), con el título que el muro tiene que mostrar. */
function expectedWall(e: TenantEntitlements, m: TenantModule, canBuy: boolean): WallClass {
  if (modulesFor(e).has(m)) return "ok";
  if (e.moduleRevokes.includes(m) && isModuleOverridable(m, e.vertical)) {
    return { disabled: true, title: accessWallDisabledTitle(m) };
  }
  const min = minimumPlanFor(m, e.vertical);
  if (min === null || planRank(min) <= planRank(e.plan)) return "redirect";
  return { plan: min, canBuy, title: accessWallTitle(m, min) };
}

/**
 * Oráculo del menú (orden del sidebar). Independiente de `NAV_ITEMS`: es la regla del producto escrita aparte (Sala con
 * `agenda.reception`, Cobros con `billing.collect` y cobros online prendidos, Configuración con `tenant.admin`).
 */
function expectedNav(mods: ReadonlySet<TenantModule>, caps: ReadonlySet<Capability>, onlinePayments: boolean): string[] {
  const out = ["/dashboard"];
  if (mods.has("agenda")) out.push("/agenda");
  if (mods.has("salaEspera") && caps.has("agenda.reception")) out.push("/sala");
  if (mods.has("pacientes")) out.push("/pacientes");
  if (mods.has("planes")) out.push("/planes");
  if (mods.has("diagnostico")) out.push("/diagnostico");
  if (mods.has("sesiones")) out.push("/seguimiento");
  if (mods.has("ejercicios")) out.push("/biblioteca", "/terapia-manual");
  if (onlinePayments && caps.has("billing.collect")) out.push("/cobros");
  if (caps.has("tenant.admin")) out.push("/configuracion");
  return out;
}

/** El menú como lo arma `app/(app)/layout.tsx`: caps del actor → `shellNavCaps` (modo de cobros online) → `navFor`. */
async function realNav(): Promise<string[]> {
  const actor = await getActor();
  const caps = shellNavCaps([...(await capabilitiesForActor(actor))], mpConnectMode() !== "off");
  return navFor(modulesFor(actor.entitlements), new Set(caps)).map((i) => i.href);
}

const ENTS = (vertical: TenantVertical, plan: SaasPlan, o: Partial<TenantEntitlements> = {}): TenantEntitlements => ({
  vertical,
  plan,
  publicBookingEnabled: true,
  moduleGrants: [],
  moduleRevokes: [],
  ...o,
});

describe.skipIf(!RUN)("[QA-M] matriz de routing por plan × vertical × rol", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;
  const prevMp = process.env.MP_CONNECT_MODE;

  type Cell = { plan: SaasPlan; vertical: TenantVertical; t: EphemeralTenant; users: Partial<Record<RoleKey, string>> };
  const cells: Cell[] = [];

  async function tenant(opts: Parameters<typeof createEphemeralTenant>[1] = {}): Promise<EphemeralTenant> {
    const t = await createEphemeralTenant(db, opts);
    tenants.push(t);
    return t;
  }

  async function addRole(t: EphemeralTenant, k: RoleKey): Promise<string> {
    if (k === "OWNER_CLIN") return t.userId;
    if (k === "PRACTITIONER") return (await addPractitioner(db, t, "PRACTITIONER")).userId;
    const s = MEMBER_SPEC[k];
    return (await addStaff(db, t, s.role, { grantSettings: s.grantSettings, grantBilling: s.grantBilling })).userId;
  }

  /** Pantalla de sala ya vinculada (como la deja `pairDisplay`) con su cookie en el jar de la integración. */
  async function pairTv(t: EphemeralTenant): Promise<void> {
    const secret = newDeviceSecret();
    const d = await db.receptionDisplay.create({
      data: {
        tenantId: t.tenantId,
        name: `TV ${uniqueSuffix()}`,
        createdByUserId: t.userId,
        deviceSecretHash: hashDeviceSecret(secret),
        pairedAt: new Date(),
      },
      select: { id: true },
    });
    cookies().set(DISPLAY_COOKIE, makeDisplayCookie(d.id, secret, toARDateKey(new Date())));
  }

  const platformActor = () => ({ userId: tenants[0].userId, email: null, homeTenantId: tenants[0].tenantId });
  /** Grant/revoke como /plataforma: escritor único, source `platform`, por el canal service. */
  async function writeModules(tenantId: string, patch: { moduleGrants?: TenantModule[]; moduleRevokes?: TenantModule[] }) {
    const r = await prismaService.$transaction((tx) =>
      applyTenantEntitlementsInTx(tx, { tenantId, source: "platform", patch, actor: platformActor() })
    );
    expect(r.ok).toBe(true);
  }

  beforeAll(async () => {
    db = ownerClient();
    await tenant(); // home del superadmin de los overrides (tenants[0])
    for (const plan of SAAS_PLANS) {
      for (const vertical of VERTICALS) {
        const t = await tenant({ saasPlan: plan, vertical });
        const users: Partial<Record<RoleKey, string>> = {};
        for (const k of ROLES_BY_PLAN[plan]) users[k] = await addRole(t, k);
        cells.push({ plan, vertical, t, users });
      }
    }
  });

  afterAll(async () => {
    asAnonymous();
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    cookies().delete("kine_tenant");
    cookies().delete(DISPLAY_COOKIE);
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    process.env.MP_CONNECT_MODE = "sandbox";
  });

  afterEach(() => {
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
    if (prevMp === undefined) delete process.env.MP_CONNECT_MODE;
    else process.env.MP_CONNECT_MODE = prevMp;
  });

  const cell = (plan: SaasPlan, vertical: TenantVertical) => cells.find((c) => c.plan === plan && c.vertical === vertical)!;

  // ── (a) muros por segmento, la matriz completa contra el oráculo ──────────────────────────────────────────────────

  it("[QA-M] cada segmento con muro tiene un layout que llama a moduleWall con su módulo; /agenda/ocupacion no lo necesita", () => {
    for (const s of SEGMENTS) {
      const src = readFileSync(resolve(process.cwd(), `app/(app)/${s.seg}/layout.tsx`), "utf8");
      expect(src, s.seg).toContain(`moduleWall("${s.module}")`);
    }
    // Ocupación cuelga de /agenda, que es núcleo (todos los planes y verticales): no hay layout con muro.
    expect(existsSync(resolve(process.cwd(), "app/(app)/agenda/layout.tsx"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "app/(app)/agenda/ocupacion/layout.tsx"))).toBe(false);
    for (const plan of SAAS_PLANS) for (const v of VERTICALS) expect(modulesFor(ENTS(v, plan)).has("agenda")).toBe(true);
  });

  for (const plan of SAAS_PLANS) {
    for (const vertical of VERTICALS) {
      it(`[QA-M] muros ${plan} × ${vertical}: cada rol, cada segmento = oráculo (y el actor tiene las caps del oráculo)`, async () => {
        const c = cell(plan, vertical);
        const ents = ENTS(vertical, plan);
        const got: Record<string, unknown> = {};
        const want: Record<string, unknown> = {};
        for (const k of ROLES_BY_PLAN[plan]) {
          asUser(c.users[k]!);
          cookies().delete("kine_tenant");
          const actor = await getActor();
          expect(actor.tenantId).toBe(c.t.tenantId);
          const caps = await capabilitiesForActor(actor);
          // Si la factory armara mal un rol, todo lo demás se compararía contra otro miembro.
          expect([...caps].sort(), k).toEqual([...capabilitiesForMember(MEMBER_SPEC[k])].sort());
          const canBuy = caps.has("account.billing");
          for (const s of SEGMENTS) {
            got[`${k} /${s.seg}`] = await runLayout(s.layout);
            want[`${k} /${s.seg}`] = expectedWall(ents, s.module, canBuy);
          }
          got[`${k} /agenda/ocupacion`] = await moduleWall("agenda");
          want[`${k} /agenda/ocupacion`] = "ok";
        }
        expect(got).toEqual(want);
      });
    }
  }

  // ── (a) casos literales críticos (no dependen del oráculo) ────────────────────────────────────────────────────────

  async function wallAs(plan: SaasPlan, vertical: TenantVertical, k: RoleKey, layout: Layout): Promise<WallClass> {
    asUser(cell(plan, vertical).users[k]!);
    return runLayout(layout);
  }

  it("[QA-M] literal 1: Individual Kine no tiene /sala → upsell «Sala de espera está en el plan Clínica» (el Titular compra)", async () => {
    expect(await wallAs("INDIVIDUAL", "KINESIOLOGY", "OWNER_CLIN", SalaLayout as Layout)).toEqual({
      plan: "CLINICA",
      canBuy: true,
      title: "Sala de espera está en el plan Clínica",
    });
  });

  it("[QA-M] literal 2: General nunca tiene /diagnostico (redirect, sin upsell) en ningún plan", async () => {
    for (const plan of SAAS_PLANS) {
      expect(await wallAs(plan, "GENERAL", "OWNER_CLIN", DiagnosticoLayout as Layout), plan).toBe("redirect");
    }
  });

  it("[QA-M] literal 3: Clínica General sí tiene /sala; Libre General también", async () => {
    expect(await wallAs("CLINICA", "GENERAL", "OWNER_CLIN", SalaLayout as Layout)).toBe("ok");
    expect(await wallAs("LIBRE", "GENERAL", "ASSISTANT", SalaLayout as Layout)).toBe("ok");
  });

  it("[QA-M] literal 4: Individual Kine tiene planes, seguimiento, diagnóstico, biblioteca y terapia manual", async () => {
    for (const l of [PlanesLayout, SeguimientoLayout, DiagnosticoLayout, BibliotecaLayout, TerapiaManualLayout]) {
      expect(await wallAs("INDIVIDUAL", "KINESIOLOGY", "OWNER_CLIN", l as Layout)).toBe("ok");
    }
  });

  it("[QA-M] literal 5: Libre General no tiene /planes ni /biblioteca (no se le vende Kine a un General)", async () => {
    expect(await wallAs("LIBRE", "GENERAL", "OWNER_CLIN", PlanesLayout as Layout)).toBe("redirect");
    expect(await wallAs("LIBRE", "GENERAL", "OWNER_CLIN", BibliotecaLayout as Layout)).toBe("redirect");
  });

  it("[QA-M] literal 6: Consultorio Kine, la Secretaría ve el muro de /sala sin «Ver planes»; el Admin con «Planes y pagos» sí", async () => {
    expect(await wallAs("CONSULTORIO", "KINESIOLOGY", "ASSISTANT", SalaLayout as Layout)).toMatchObject({
      plan: "CLINICA",
      canBuy: false,
    });
    expect(await wallAs("CONSULTORIO", "KINESIOLOGY", "ADMIN", SalaLayout as Layout)).toMatchObject({
      plan: "CLINICA",
      canBuy: true,
    });
  });

  it("[QA-M] literal 7: menú de Facturación en Clínica Kine: sin Sala (no recepciona), con Cobros, sin Configuración", async () => {
    asUser(cell("CLINICA", "KINESIOLOGY").users.BILLING!);
    expect(await realNav()).toEqual([
      "/dashboard",
      "/agenda",
      "/pacientes",
      "/planes",
      "/diagnostico",
      "/seguimiento",
      "/biblioteca",
      "/terapia-manual",
      "/cobros",
    ]);
  });

  it("[QA-M] literal 8: menú del Titular en Individual General: solo el núcleo + Cobros + Configuración; sin cobros online, sin Cobros", async () => {
    asUser(cell("INDIVIDUAL", "GENERAL").users.OWNER_CLIN!);
    expect(await realNav()).toEqual(["/dashboard", "/agenda", "/pacientes", "/cobros", "/configuracion"]);
    process.env.MP_CONNECT_MODE = "off";
    expect(await realNav()).toEqual(["/dashboard", "/agenda", "/pacientes", "/configuracion"]);
  });

  // ── (b) menú, la matriz completa, con y sin cobros online ─────────────────────────────────────────────────────────

  for (const mode of ["sandbox", "off"] as const) {
    it(`[QA-M] menú (navFor) por plan × vertical × rol = oráculo, con MP_CONNECT_MODE=${mode}`, async () => {
      process.env.MP_CONNECT_MODE = mode;
      const got: Record<string, string[]> = {};
      const want: Record<string, string[]> = {};
      for (const c of cells) {
        for (const k of ROLES_BY_PLAN[c.plan]) {
          asUser(c.users[k]!);
          const key = `${c.plan}/${c.vertical}/${k}`;
          got[key] = await realNav();
          want[key] = expectedNav(modulesFor(ENTS(c.vertical, c.plan)), capabilitiesForMember(MEMBER_SPEC[k]), mode !== "off");
        }
      }
      expect(got).toEqual(want);
    });
  }

  it("[QA-M] /cobros con MP_CONNECT_MODE=off no existe (redirect a /dashboard) aunque el actor tenga billing.collect", async () => {
    process.env.MP_CONNECT_MODE = "off";
    asUser(cell("CLINICA", "KINESIOLOGY").users.OWNER_CLIN!);
    await expect(CobrosPage({ searchParams: {} })).rejects.toMatchObject({
      digest: expect.stringContaining(";/dashboard;"),
    });
  });

  // ── /tv (pantalla de sala): módulo salaEspera del consultorio de la pantalla ──────────────────────────────────────

  it("[QA-M] /tv por plan × vertical: vinculada solo donde el oráculo da salaEspera; si no, unavailable/no_module", async () => {
    asAnonymous(); // la TV no tiene Actor: la identidad es la cookie del dispositivo
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const c of cells) {
      await pairTv(c.t);
      const s = await resolveDisplaySession();
      const key = `${c.plan}/${c.vertical}`;
      got[key] = s.state === "unavailable" ? `unavailable:${s.reason}` : s.state;
      want[key] = modulesFor(ENTS(c.vertical, c.plan)).has("salaEspera") ? "paired" : "unavailable:no_module";
    }
    expect(got).toEqual(want);
    // Literal: Individual y Consultorio nunca; Clínica y Libre siempre, en las dos verticales.
    expect(got["INDIVIDUAL/KINESIOLOGY"]).toBe("unavailable:no_module");
    expect(got["CONSULTORIO/GENERAL"]).toBe("unavailable:no_module");
    expect(got["CLINICA/GENERAL"]).toBe("paired");
    expect(got["LIBRE/KINESIOLOGY"]).toBe("paired");
  });

  // ── (c) cupos ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** ¿Entra una persona más de ese tipo? Mismo conteo que frena la invitación (`requireFreeSeatInTx`). */
  async function seatFree(t: EphemeralTenant, kind: "professional" | "staff"): Promise<boolean> {
    const u = await runWithRls(t.tenantId, (tx) => getSeatUsageInTx(tx, t.tenantId, { now: new Date() }));
    expect(u).not.toBeNull();
    return canAddSeat(u!, kind);
  }

  async function addAssistants(t: EphemeralTenant, n: number) {
    for (let i = 0; i < n; i++) await addStaff(db, t, "ASSISTANT");
  }

  it("[QA-M] los topes de SaasPlanConfig en la base son los de PLAN_DEFAULTS (el oráculo de cupos)", async () => {
    const rows = await db.saasPlanConfig.findMany({ select: { plan: true, maxUsers: true, maxProfessionals: true, maxStaff: true } });
    const byPlan = Object.fromEntries(rows.map((r) => [r.plan, { maxUsers: r.maxUsers, maxProfessionals: r.maxProfessionals, maxStaff: r.maxStaff }]));
    for (const plan of SAAS_PLANS) if (byPlan[plan]) expect(byPlan[plan], plan).toEqual(PLAN_DEFAULTS[plan].limits);
    expect(PLAN_DEFAULTS.INDIVIDUAL.limits.maxUsers).toBe(1);
    expect(PLAN_DEFAULTS.CONSULTORIO.limits.maxUsers).toBe(5);
    expect(PLAN_DEFAULTS.CLINICA.limits.maxUsers).toBe(10);
    expect(PLAN_DEFAULTS.LIBRE.limits.maxUsers).toBeNull();
  });

  it("[QA-M] Individual: con el Titular solo, el 2.º usuario (de cualquier tipo) queda bloqueado", async () => {
    const t = await tenant({ saasPlan: "INDIVIDUAL" });
    expect(await seatFree(t, "professional")).toBe(false);
    expect(await seatFree(t, "staff")).toBe(false);
  });

  it("[QA-M] Consultorio: entra el 5.º, el 6.º queda bloqueado (una invitación pendiente reserva lugar)", async () => {
    const t = await tenant({ saasPlan: "CONSULTORIO" });
    await addAssistants(t, 3); // 4 en total
    expect(await seatFree(t, "staff")).toBe(true);
    expect(await seatFree(t, "professional")).toBe(true);
    await db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email: `qa-m-${uniqueSuffix()}@test.local`,
        firstName: "QA",
        lastName: "Invitada",
        role: "PRACTITIONER",
        token: `tok-${uniqueSuffix()}`,
        invitedById: t.userId,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    // 4 miembros + 1 invitación = 5: el 6.º no entra, de ningún tipo.
    expect(await seatFree(t, "staff")).toBe(false);
    expect(await seatFree(t, "professional")).toBe(false);
  });

  it("[QA-M] Clínica: entra el 10.º, el 11.º queda bloqueado", async () => {
    const t = await tenant({ saasPlan: "CLINICA" });
    await addAssistants(t, 8); // 9
    expect(await seatFree(t, "professional")).toBe(true);
    await addPractitioner(db, t); // 10
    expect(await seatFree(t, "professional")).toBe(false);
    expect(await seatFree(t, "staff")).toBe(false);
  });

  it("[QA-M] Libre: sin override no hay tope; con override de usuarios o de profesionales rige el override", async () => {
    const free = await tenant({ saasPlan: "LIBRE" });
    await addAssistants(free, 11); // 12
    expect(await seatFree(free, "professional")).toBe(true);
    expect(await seatFree(free, "staff")).toBe(true);

    const capped = await tenant({ saasPlan: "LIBRE" });
    await db.tenant.update({ where: { id: capped.tenantId }, data: { maxUsersOverride: 3 } });
    await addAssistants(capped, 1); // 2
    expect(await seatFree(capped, "staff")).toBe(true);
    await addAssistants(capped, 1); // 3
    expect(await seatFree(capped, "staff")).toBe(false);

    const pros = await tenant({ saasPlan: "LIBRE" });
    await db.tenant.update({ where: { id: pros.tenantId }, data: { maxProfessionalsOverride: 2 } });
    await addPractitioner(db, pros); // Titular clínico + 1 = 2 profesionales
    expect(await seatFree(pros, "professional")).toBe(false);
    expect(await seatFree(pros, "staff")).toBe(true);
  });

  it("[QA-M] un override de cupo fuera de Libre es inerte: Consultorio con maxUsersOverride=20 sigue topeado en 5", async () => {
    const t = await tenant({ saasPlan: "CONSULTORIO" });
    await db.tenant.update({ where: { id: t.tenantId }, data: { maxUsersOverride: 20 } });
    await addAssistants(t, 4); // 5
    expect(await seatFree(t, "staff")).toBe(false);
  });

  // ── (d) estados de acceso ─────────────────────────────────────────────────────────────────────────────────────────

  /** Consultorio Kine con un paciente y una nota de HC sembrada (autor = el Titular clínico). */
  async function withHc(): Promise<{ t: EphemeralTenant; patientId: string; noteId: string }> {
    const t = await tenant({ saasPlan: "CONSULTORIO", vertical: "KINESIOLOGY" });
    const patientId = await addPatient(db, t);
    const noteId = `qa-m-${uniqueSuffix()}`;
    await db.clinicalNote.create({
      data: {
        id: noteId,
        tenantId: t.tenantId,
        patientId,
        body: "Nota QA-M",
        occurredAt: new Date(),
        authorUserId: t.userId,
        authorPractitionerId: t.practitionerId,
        authorName: "Kine QA",
        idempotencyKey: randomUUID(),
      },
    });
    return { t, patientId, noteId };
  }

  const newService = (tenantId: string) => ({ tenantId, name: `QA-M ${uniqueSuffix()}`, durationMin: 30, priceCents: 1000 });

  async function hcReadable(patientId: string, noteId: string): Promise<void> {
    const page = await getPatientTimeline({ patientId });
    expect(page).not.toBeNull();
    expect(JSON.stringify(page)).toContain(noteId);
  }

  it("[QA-M] prueba vigente → vencida en gracia (escribe) → vencida del todo: read_only, escritura rechazada y HC legible", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    const { t, patientId, noteId } = await withHc();
    const setTrialEnd = (ms: number) =>
      db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + ms) } });
    asUser(t.userId);

    await setTrialEnd(3 * DAY);
    expect((await getActor()).access).toMatchObject({ mode: "full", reason: "trial_ending" });

    await setTrialEnd(-2 * DAY);
    expect((await getActor()).access).toEqual({ mode: "grace", reason: "trial_grace", daysLeft: TRIAL_GRACE_DAYS - 2 + 1 });
    await expect(runWithRls(t.tenantId, (tx) => tx.service.create({ data: newService(t.tenantId), select: { id: true } }))).resolves.toBeTruthy();

    await setTrialEnd(-(TRIAL_GRACE_DAYS + 1) * DAY);
    expect((await getActor()).access).toEqual({ mode: "read_only", reason: "trial_expired", daysLeft: null });
    const before = await db.service.count({ where: { tenantId: t.tenantId } });
    await expect(runWithRls(t.tenantId, (tx) => tx.service.create({ data: newService(t.tenantId) }))).rejects.toBeInstanceOf(
      ReadOnlyModeError
    );
    const r = await createClinicalNote({ patientId, body: "No tiene que entrar", idempotencyKey: randomUUID() });
    expect(r).toEqual({ ok: false, error: READ_ONLY_MESSAGE });
    expect(await db.service.count({ where: { tenantId: t.tenantId } })).toBe(before);
    expect(await db.clinicalNote.count({ where: { patientId } })).toBe(1);
    // Ley 26.529: la HC se sigue leyendo en solo lectura.
    await hcReadable(patientId, noteId);
    // Y el menú y los muros no cambian por el modo (solo lectura no esconde módulos).
    expect(await runLayout(PlanesLayout as Layout)).toBe("ok");
  });

  it(`[QA-M] past_due: gracia de ${PAST_DUE_GRACE_DAYS} días (escribe), después read_only`, async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    const { t, patientId, noteId } = await withHc();
    const setPastDue = (agoDays: number) =>
      db.tenant.update({
        where: { id: t.tenantId },
        data: { subscriptionStatus: "PAST_DUE", subscriptionStatusChangedAt: new Date(Date.now() - agoDays * DAY) },
      });
    asUser(t.userId);

    await setPastDue(PAST_DUE_GRACE_DAYS);
    expect((await getActor()).access).toEqual({ mode: "grace", reason: "past_due_grace", daysLeft: 1 });
    await expect(runWithRls(t.tenantId, (tx) => tx.service.create({ data: newService(t.tenantId), select: { id: true } }))).resolves.toBeTruthy();

    await setPastDue(PAST_DUE_GRACE_DAYS + 1);
    expect((await getActor()).access).toEqual({ mode: "read_only", reason: "past_due", daysLeft: null });
    await expect(runWithRls(t.tenantId, (tx) => tx.service.create({ data: newService(t.tenantId) }))).rejects.toBeInstanceOf(
      ReadOnlyModeError
    );
    await hcReadable(patientId, noteId);
  });

  for (const status of ["SUSPENDED", "CLOSED"] as const) {
    it(`[QA-M] ${status}: sin Actor (bloqueo de sesión) y el Titular igual se lleva la HC por el export (Ley 26.529)`, async () => {
      const { t, noteId } = await withHc();
      await db.tenant.update({ where: { id: t.tenantId }, data: { status, statusChangedAt: new Date() } });
      asUser(t.userId);
      expect(await tryGetActor()).toBeNull();
      expect((await getSessionBlock())?.kind).toBe(status === "SUSPENDED" ? "tenant_suspended" : "tenant_closed");
      // Sin Actor el muro es no-op (lo resuelve el layout de (app) mandando a /suspendido): no abre nada.
      expect(await moduleWall("planes")).toBe("ok");
      __rateLimitInternals.reset();
      const res = await exportTenant(new Request("http://localhost/api/consultorio/export"));
      expect(res.status).toBe(200);
      const json = JSON.parse(await res.text()) as { data: Record<string, Array<{ id: string }>> };
      expect(json.data.clinicalNotes.map((n) => n.id)).toContain(noteId);
    });
  }

  // ── (e) overrides de Plataforma ───────────────────────────────────────────────────────────────────────────────────

  it("[QA-M] grant de salaEspera a un Consultorio → /sala y /tv habilitados y «Sala de espera» en el menú; revoke → «no está habilitado»", async () => {
    const t = await tenant({ saasPlan: "CONSULTORIO", vertical: "KINESIOLOGY" });
    const assistant = (await addStaff(db, t, "ASSISTANT")).userId;
    asUser(t.userId);
    expect(await runLayout(SalaLayout as Layout)).toMatchObject({ plan: "CLINICA", canBuy: true });
    expect(await realNav()).not.toContain("/sala");

    await writeModules(t.tenantId, { moduleGrants: ["salaEspera"] });
    for (const u of [t.userId, assistant]) {
      asUser(u);
      expect(await runLayout(SalaLayout as Layout)).toBe("ok");
      expect(await realNav()).toContain("/sala");
    }
    asAnonymous();
    await pairTv(t);
    expect((await resolveDisplaySession()).state).toBe("paired");

    await writeModules(t.tenantId, { moduleGrants: [], moduleRevokes: ["salaEspera"] });
    asUser(t.userId);
    const wall = await runLayout(SalaLayout as Layout);
    expect(wall).toEqual({ disabled: true, title: "Sala de espera no está habilitado" });
    expect(wall).toEqual(
      expectedWall(ENTS("KINESIOLOGY", "CONSULTORIO", { moduleRevokes: ["salaEspera"] }), "salaEspera", true)
    );
    expect(MODULE_REVOKED_COPY).toMatch(/no está habilitado/);
    expect(await realNav()).not.toContain("/sala");
    asAnonymous();
    expect(await resolveDisplaySession()).toEqual({ state: "unavailable", reason: "no_module" });
  });

  it("[QA-M] revoke de salaEspera a una Clínica: el muro es «no está habilitado» (sin upsell) y la TV se cae", async () => {
    const t = await tenant({ saasPlan: "CLINICA", vertical: "GENERAL" });
    asUser(t.userId);
    expect(await runLayout(SalaLayout as Layout)).toBe("ok");
    await writeModules(t.tenantId, { moduleRevokes: ["salaEspera"] });
    expect(await runLayout(SalaLayout as Layout)).toEqual({ disabled: true, title: "Sala de espera no está habilitado" });
    asAnonymous();
    await pairTv(t);
    expect(await resolveDisplaySession()).toEqual({ state: "unavailable", reason: "no_module" });
  });

  it("[QA-M] un grant de Kine a un General no abre nada (isModuleOverridable): /diagnostico sigue en redirect", async () => {
    const t = await tenant({ saasPlan: "LIBRE", vertical: "GENERAL" });
    // El escritor lo rechaza (tira: bug del caller); se fuerza la fila a mano como haría un dato tocado.
    await db.tenant.update({ where: { id: t.tenantId }, data: { moduleGrants: ["diagnostico"] } });
    asUser(t.userId);
    expect(await runLayout(DiagnosticoLayout as Layout)).toBe("redirect");
    expect(await realNav()).not.toContain("/diagnostico");
  });

  it("[QA-M] copy del upsell: todo muro de plan dice «… está en el plan <plan>»", () => {
    for (const plan of SAAS_PLANS) {
      expect(accessWallTitle("salaEspera", plan)).toBe(`Sala de espera está en el plan ${SAAS_PLAN_LABEL[plan]}`);
    }
  });
});
