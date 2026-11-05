/**
 * INF-S · núcleo de `scripts/qa-tenants.ts` (plan §26.8, decisión 3 de Martin del 22-oct): los 8 consultorios del QA
 * por plan (Individual / Consultorio / Clínica / Libre × General / Kinesiología), idempotente, con su `--state`, su
 * `--sample-data` y su `--cleanup`.
 *
 * Por qué existe: hasta T5 todo el E2E y el QA manual corrían con UN consultorio Kine + Individual + Titular, y los
 * bloqueos, muros y menús de cada plan solo se veían armando consultorios a mano desde /plataforma (8 altas, 36
 * invitaciones, cupos, salas). Eso no se repite igual dos veces, y un QA que no se repite no encuentra regresiones.
 *
 * Reglas (todas buscadas):
 *  - Alta por los caminos de la app, no por INSERT sueltos: `bootstrapTenant` (único camino de alta, AUDIT §5.26) y
 *    el escritor único de entitlements (`applyTenantEntitlementsInTx`, source `platform`, con su audit doble). Las
 *    membresías del equipo se arman como `joinTenantInTx` (invitación aceptada): mismos permisos de entrada
 *    (`grantsOnEnterRole` con el Titular que invita), `Practitioner` + agenda solo para quien atiende (§20.17).
 *  - Auth por el puerto (`AuthAdminPort`, C-IAM3): `createUser` con `emailConfirm` (no manda mails). Las llamadas de
 *    red van FUERA de la transacción de la base (un GoTrue lento no deja la tx abierta con el Tenant lockeado).
 *  - Contraseña y emails salen del entorno (`QA_PASSWORD`, `QA_EMAIL_BASE` con plus-addressing): nunca en el repo ni
 *    en un log. La tabla de accesos dice «la de QA_PASSWORD».
 *  - Solo toca slugs `qa-` (los 8 canónicos del prefijo): `--state` y `--cleanup` rechazan cualquier otro, y el
 *    cleanup solo borra cuentas de Auth cuyo email es de QA (`+<slug>-`). Un consultorio real con slug `qa-algo` que no
 *    sea uno de los 8 no se toca.
 *  - Re-correr la creación NO pisa el estado de acceso elegido con `--state` (solo lo fija al CREAR): así se puede
 *    sumar `--sample-data` a un consultorio que está probando «solo lectura» sin desarmar la prueba.
 *
 * Sin `server-only` acá; sí lo arrastra `lib/tenant-entitlements-internal.ts`: el CLI corre con
 * `tsx --conditions=react-server` (mismo patrón que `scripts/saas-reanchor.ts`).
 */
import type { Prisma, PrismaClient, Role, SaasPlan, TenantVertical } from "@prisma/client";
import type { AuthAdminPort } from "../../lib/identity/auth-admin";
import { bootstrapTenant } from "../../lib/tenant-bootstrap";
import { starterServicesFor } from "../../lib/tenant-starter-services";
import { provisionPractitionerAgenda, ensurePrimaryLocation } from "../../lib/agenda-defaults";
import { applyTenantEntitlementsInTx, type EntitlementPatchFor } from "../../lib/tenant-entitlements-internal";
import { tenantAccessFor, TRIAL_GRACE_DAYS, TENANT_ACCESS_SELECT, type TenantAccess } from "../../lib/tenant-access";
import { PLAN_DEFAULTS } from "../../lib/saas-plans-logic";
import { localToARIso, toARDateKey, toARDow } from "../../lib/datetime-ar";
import { deleteTenantDeep } from "../../tests/helpers/tenant-factory";
import { assertSafeTarget, describeTarget, type TargetDescription } from "./assert-safe-target";

type Tx = Prisma.TransactionClient;

export const QA_PLANS: readonly SaasPlan[] = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"];
export const QA_VERTICALS: readonly TenantVertical[] = ["GENERAL", "KINESIOLOGY"];
export const QA_STATES = ["trial", "trial-expired", "read-only", "past-due", "suspended", "active"] as const;
export type QaState = (typeof QA_STATES)[number];

/** Prefijo canónico. Los tests usan otro (`qa-zt…-`) para no tocar los consultorios QA del Docker de Martin. */
export const QA_SLUG_PREFIX = "qa-";
/** Cupos a medida de Libre (`maxUsersOverride` etc. solo valen en Libre, `effectiveLimits`). */
export const QA_LIBRE_OVERRIDES = { maxUsersOverride: 12, maxProfessionalsOverride: 8, maxStaffOverride: 4 } as const;
/** Mínimo propio: la contraseña la comparten 36 cuentas reales de prod demo. */
const QA_PASSWORD_MIN = 12;
const DAY_MS = 86_400_000;
/** Actor de Plataforma sin persona (`userId` null = script, C-BO5). */
const SCRIPT_ACTOR = { userId: null, email: null, homeTenantId: null } as const;

export type QaDeps = {
  /** Conexión owner (BYPASSRLS): el alta corre antes de que exista el GUC del consultorio, como en Plataforma. */
  db: PrismaClient;
  auth: AuthAdminPort;
  now?: Date;
  log?: (m: string) => void;
  slugPrefix?: string;
};

export type QaMemberSpec = { role: Role; tag: string; label: string };
export type QaTenantSpec = { slug: string; plan: SaasPlan; vertical: TenantVertical };
export type QaAccessRow = { slug: string; plan: SaasPlan; vertical: TenantVertical; role: Role; label: string; email: string };

/** Personas por plan (§26.8): Individual = Titular; Consultorio = 5 (el cupo justo); Clínica y Libre = 6. */
export function membersForPlan(plan: SaasPlan): QaMemberSpec[] {
  const owner: QaMemberSpec = { role: "OWNER", tag: "titular", label: "Titular" };
  if (plan === "INDIVIDUAL") return [owner];
  const team: QaMemberSpec[] = [
    owner,
    { role: "ADMIN", tag: "admin", label: "Administración" },
    { role: "ASSISTANT", tag: "secretaria", label: "Secretaría" },
    { role: "PRACTITIONER", tag: "prof1", label: "Profesional 1" },
    { role: "PRACTITIONER", tag: "prof2", label: "Profesional 2" },
  ];
  if (plan === "CONSULTORIO") return team;
  return [...team, { role: "BILLING", tag: "facturacion", label: "Facturación" }];
}

function verticalSlug(v: TenantVertical): string {
  return v === "GENERAL" ? "general" : "kinesiologia";
}
function verticalLabel(v: TenantVertical): string {
  return v === "GENERAL" ? "General" : "Kinesiología";
}

function assertPrefix(prefix: string): void {
  if (!/^qa-[a-z0-9-]*$/.test(prefix)) throw new Error(`[qa-tenants] prefijo inválido «${prefix}»: tiene que empezar con «qa-».`);
}

/** Los 8 consultorios `qa-<plan>-<vertical>`, en orden de plan. */
export function qaSlugs(prefix: string = QA_SLUG_PREFIX): QaTenantSpec[] {
  assertPrefix(prefix);
  return QA_PLANS.flatMap((plan) =>
    QA_VERTICALS.map((vertical) => ({ slug: `${prefix}${plan.toLowerCase()}-${verticalSlug(vertical)}`, plan, vertical }))
  );
}

/** `martin@x.com` + `qa-clinica-general` + `admin` → `martin+qa-clinica-general-admin@x.com`. */
export function qaEmail(base: string, slug: string, tag: string): string {
  const b = base.trim().toLowerCase();
  const m = /^([^\s@+]+)@([^\s@]+\.[^\s@]+)$/.exec(b);
  if (!m) throw new Error("[qa-tenants] QA_EMAIL_BASE tiene que ser un email sin «+» (el script le agrega «+<consultorio>-<rol>»).");
  return `${m[1]}+${slug}-${tag}@${m[2]}`;
}

/** ¿Es una cuenta de QA de alguno de estos consultorios? (Única condición para que el cleanup borre una cuenta de Auth.) */
function isQaEmail(email: string | null | undefined, slugs: readonly string[]): boolean {
  const e = (email ?? "").toLowerCase();
  const local = e.split("@")[0] ?? "";
  return slugs.some((s) => local.includes(`+${s}-`));
}

// ─── destino ────────────────────────────────────────────────────────────────

function supabaseRefOf(url: string): { isLocal: boolean; ref: string | null; host: string } {
  const t = describeTarget(url);
  const m = /^([a-z0-9]{10,})\.supabase\.co$/.exec(t.host);
  return { isLocal: t.isLocal, ref: m ? m[1] : null, host: t.host };
}

/**
 * `--target local|prod` contra la base Y contra Auth. La base sola no alcanza: con la base local y el Auth de prod,
 * el script crearía 36 cuentas reales para consultorios que no existen en prod (y al revés, consultorios de prod con
 * cuentas que nadie puede usar).
 */
export function resolveQaTarget(o: {
  target: string | undefined;
  dbUrl: string | undefined;
  supabaseUrl: string | undefined;
  confirm?: string;
  prodRef?: string;
  log?: (m: string) => void;
}): { db: TargetDescription; supabaseRef: string | null } {
  if (o.target !== "local" && o.target !== "prod") {
    throw new Error("[qa-tenants] Indicá el destino: --target local o --target prod.");
  }
  if (!o.supabaseUrl) throw new Error("[qa-tenants] Falta NEXT_PUBLIC_SUPABASE_URL (el Auth donde se crean las cuentas).");
  const sb = supabaseRefOf(o.supabaseUrl);
  if (o.target === "local") {
    const db = assertSafeTarget({ url: o.dbUrl, allowRemote: false, scriptName: "qa-tenants", log: o.log });
    if (sb.isLocal) return { db, supabaseRef: null };
    const prodRef = o.prodRef?.trim();
    if (!prodRef) {
      throw new Error(
        `[qa-tenants] --target local con un Auth remoto (${sb.host}): definí PROD_SUPABASE_REF para confirmar que no es el de producción.`
      );
    }
    if (sb.ref === prodRef) throw new Error("[qa-tenants] --target local con el Auth de PRODUCCIÓN. Abortado.");
    return { db, supabaseRef: sb.ref };
  }
  const db = assertSafeTarget({ url: o.dbUrl, allowRemote: true, confirm: o.confirm, scriptName: "qa-tenants", log: o.log });
  if (db.isLocal) throw new Error("[qa-tenants] pediste --target prod y la base es local. Abortado.");
  if (!db.projectRef || sb.ref !== db.projectRef) {
    throw new Error(
      `[qa-tenants] la base (${db.projectRef ?? db.host}) y Auth (${sb.ref ?? sb.host}) no son el mismo proyecto de Supabase. Abortado.`
    );
  }
  return { db, supabaseRef: sb.ref };
}

// ─── Auth ───────────────────────────────────────────────────────────────────

async function ensureAuthUser(
  auth: AuthAdminPort,
  p: { email: string; password: string; fullName: string }
): Promise<{ id: string; created: boolean }> {
  const found = await auth.findUserByEmail(p.email);
  if (!found.ok) throw new Error(`[qa-tenants] Auth: no pude buscar ${p.email} (${found.code}).`);
  if (found.data) {
    // Re-correr deja la contraseña en la de QA_PASSWORD: la tabla de accesos tiene que seguir siendo cierta aunque
    // alguien la haya cambiado probando «Olvidé mi contraseña».
    const up = await auth.updateUserById(found.data.id, { password: p.password, emailConfirm: true, fullName: p.fullName });
    if (!up.ok) throw new Error(`[qa-tenants] Auth: no pude actualizar ${p.email} (${up.code}).`);
    return { id: found.data.id, created: false };
  }
  const c = await auth.createUser({ email: p.email, password: p.password, emailConfirm: true, fullName: p.fullName });
  if (!c.ok) throw new Error(`[qa-tenants] Auth: no pude crear ${p.email} (${c.code}).`);
  return { id: c.data.id, created: true };
}

// ─── alta ───────────────────────────────────────────────────────────────────

/** Permisos de entrada por rol: los de `grantsOnEnterRole(rol, sin delegaciones, Titular que invita)` (lib/team-internal.ts). */
function entryGrants(role: Role): { grantSettings: boolean; grantBilling: boolean } {
  // Literal y no import: `lib/team-internal.ts` arrastra `lib/env` entero (URLs de la app) y el script no lo necesita.
  // El test de integración compara esto contra el símbolo real para que no diverjan.
  return role === "ADMIN" ? { grantSettings: true, grantBilling: true } : { grantSettings: false, grantBilling: false };
}

function platformPatch(spec: QaTenantSpec, initial: boolean): EntitlementPatchFor<"platform"> {
  return {
    vertical: spec.vertical,
    saasPlan: spec.plan,
    publicBookingEnabled: true,
    ...(spec.plan === "LIBRE" ? QA_LIBRE_OVERRIDES : {}),
    // El estado de acceso solo al crear: re-correr no desarma un `--state` en curso.
    ...(initial ? { status: "ACTIVE" as const, statusReason: null, subscriptionStatus: "ACTIVE" as const, trialEndsAt: null } : {}),
  };
}

async function ensureMemberInTx(
  tx: Tx,
  p: { tenantId: string; userId: string; email: string; fullName: string; role: Role }
): Promise<void> {
  const email = p.email.toLowerCase();
  await tx.userProfile.upsert({
    where: { id: p.userId },
    create: { id: p.userId, email, fullName: p.fullName },
    update: { email, fullName: p.fullName },
  });
  const clinical = p.role === "PRACTITIONER"; // `invitationClinical`: solo PRACTITIONER atiende (§20.17)
  const grants = entryGrants(p.role);
  await tx.membership.upsert({
    where: { userId_tenantId: { userId: p.userId, tenantId: p.tenantId } },
    create: { userId: p.userId, tenantId: p.tenantId, role: p.role, clinical, ...grants, acceptedAt: new Date() },
    // CF3 ZF5: `grantCoOwner: false` también al re-correr (la spec no tiene co-titulares). Sin esto, un co-titular de una
    // prueba manual lo seguía siendo, y volver a ADMIN a quien se había pasado a Profesional chocaba con el CHECK
    // `Membership_coOwner_role_check` de M23 (23514) y cortaba el script.
    update: { role: p.role, clinical, ...grants, grantCoOwner: false, disabledAt: null, disabledById: null, disabledReason: null },
  });
  if (clinical) {
    const prac = await tx.practitioner.upsert({
      where: { tenantId_userId: { tenantId: p.tenantId, userId: p.userId } },
      // En el turnero desde el alta (como el Titular, PL-Z A1): el QA del turnero necesita verlos.
      create: { tenantId: p.tenantId, userId: p.userId, publicBookingEnabled: true },
      update: { publicBookingEnabled: true },
      select: { id: true },
    });
    await provisionPractitionerAgenda(tx, { tenantId: p.tenantId, practitionerId: prac.id });
  }
}

async function ensureRoomsInTx(tx: Tx, tenantId: string): Promise<void> {
  const locationId = await ensurePrimaryLocation(tx, tenantId);
  for (const [i, name] of ["Consultorio 1", "Consultorio 2"].entries()) {
    const exists = await tx.room.findFirst({ where: { tenantId, name }, select: { id: true } });
    if (!exists) await tx.room.create({ data: { tenantId, locationId, name, kind: "CONSULTORIO", capacity: 1, sortOrder: i } });
  }
}

/** 10 pacientes ficticios y una semana de turnos (lun-sáb), idempotente por nombre y por `idempotencyKey`. */
async function ensureSampleDataInTx(tx: Tx, p: { tenantId: string; slug: string; now: Date }): Promise<{ patients: number; bookings: number }> {
  const { tenantId } = p;
  const pracs = await tx.practitioner.findMany({ where: { tenantId }, select: { id: true }, orderBy: { createdAt: "asc" } });
  const service = await tx.service.findFirst({
    where: { tenantId, practitionerId: null },
    select: { id: true, durationMin: true },
    orderBy: { id: "asc" }, // Service no tiene createdAt; los iniciales se crean en serie (cuid creciente)
  });
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessHoursStart: true } });
  if (pracs.length === 0 || !service) return { patients: 0, bookings: 0 };
  const locationId = await ensurePrimaryLocation(tx, tenantId);

  const patientIds: string[] = [];
  let createdPatients = 0;
  for (let i = 1; i <= 10; i++) {
    const lastName = `Paciente ${String(i).padStart(2, "0")}`;
    const found = await tx.patient.findFirst({ where: { tenantId, firstName: "QA", lastName }, select: { id: true } });
    if (found) {
      patientIds.push(found.id);
      continue;
    }
    // Ficticios a propósito: sin email, teléfono ni DNI (nada que un mail, un WhatsApp o el portal puedan usar).
    const created = await tx.patient.create({
      data: { tenantId, firstName: "QA", lastName, assignedPractitionerId: pracs[(i - 1) % pracs.length].id },
      select: { id: true },
    });
    patientIds.push(created.id);
    createdPatients++;
  }

  // Desde mañana (AR), 7 días sin domingo, dos turnos por día dentro del horario del consultorio.
  const hours = [tenant.businessHoursStart + 1, tenant.businessHoursStart + 4];
  let createdBookings = 0;
  let k = 0;
  for (let d = 1; d <= 7; d++) {
    const day = new Date(p.now.getTime() + d * DAY_MS);
    if (toARDow(day) === 0) continue;
    const dateKey = toARDateKey(day);
    for (const h of hours) {
      const hh = String(h).padStart(2, "0");
      const idempotencyKey = `qa-sample:${p.slug}:${dateKey}:${hh}`;
      const exists = await tx.booking.findUnique({ where: { idempotencyKey }, select: { id: true } });
      k++;
      if (exists) continue;
      await tx.booking.create({
        data: {
          tenantId,
          patientId: patientIds[k % patientIds.length],
          practitionerId: pracs[k % pracs.length].id,
          serviceId: service.id,
          scheduledFor: new Date(localToARIso(`${dateKey}T${hh}:00`)),
          durationMin: service.durationMin,
          status: "CONFIRMED",
          idempotencyKey,
          locationId,
        },
      });
      createdBookings++;
    }
  }
  return { patients: createdPatients, bookings: createdBookings };
}

/**
 * Crea (o completa) los 8 consultorios. Idempotente: un consultorio que ya existe se re-alinea (plan, vertical,
 * turnero, cupos de Libre, equipo, salas) sin duplicar nada y sin tocar su estado de acceso.
 */
export async function ensureQaTenants(
  deps: QaDeps,
  o: { emailBase: string; password: string; sampleData?: boolean }
): Promise<{ rows: QaAccessRow[]; tenantsCreated: number; usersCreated: number }> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? new Date();
  if (!o.password || o.password.length < QA_PASSWORD_MIN) {
    throw new Error(`[qa-tenants] QA_PASSWORD tiene que tener al menos ${QA_PASSWORD_MIN} caracteres.`);
  }
  const specs = qaSlugs(deps.slugPrefix ?? QA_SLUG_PREFIX);
  const rows: QaAccessRow[] = [];
  let tenantsCreated = 0;
  let usersCreated = 0;

  for (const spec of specs) {
    const planLabel = PLAN_DEFAULTS[spec.plan].label;
    const members = membersForPlan(spec.plan).map((m) => ({
      ...m,
      email: qaEmail(o.emailBase, spec.slug, m.tag),
      fullName: `QA ${m.label} (${planLabel} ${verticalLabel(spec.vertical)})`,
    }));
    // 1) Auth, fuera de la tx.
    const ids = new Map<string, string>();
    for (const m of members) {
      const u = await ensureAuthUser(deps.auth, { email: m.email, password: o.password, fullName: m.fullName });
      ids.set(m.tag, u.id);
      if (u.created) usersCreated++;
    }
    const ownerId = ids.get("titular")!;

    // 2) Base, en UNA tx por consultorio (todo o nada).
    const created = await deps.db.$transaction(
      async (tx) => {
        let tenant = await tx.tenant.findUnique({ where: { slug: spec.slug }, select: { id: true } });
        let isNew = false;
        if (tenant) {
          // El slug existe: tiene que ser NUESTRO (su Titular es la cuenta QA). Si no, no se toca nada.
          const owner = await tx.membership.findFirst({ where: { tenantId: tenant.id, role: "OWNER", userId: ownerId }, select: { id: true } });
          if (!owner) throw new Error(`[qa-tenants] el slug ${spec.slug} existe y su Titular no es la cuenta QA: no lo toco.`);
        } else {
          const b = await bootstrapTenant(tx, {
            userId: ownerId,
            email: members[0].email,
            fullName: members[0].fullName,
            clinicName: `QA ${planLabel} · ${verticalLabel(spec.vertical)}`,
            slug: spec.slug,
            onboardingCompleted: true,
            vertical: spec.vertical,
            starterServices: starterServicesFor(spec.vertical),
            source: "scripts/qa-tenants.ts",
          });
          tenant = { id: b.tenantId };
          isNew = true;
        }
        const r = await applyTenantEntitlementsInTx(tx, {
          tenantId: tenant.id,
          source: "platform",
          patch: platformPatch(spec, isNew),
          actor: SCRIPT_ACTOR,
        });
        if (!r.ok) throw new Error(`[qa-tenants] entitlements de ${spec.slug}: ${r.reason}`);
        for (const m of members) {
          if (m.role === "OWNER") continue;
          await ensureMemberInTx(tx, { tenantId: tenant.id, userId: ids.get(m.tag)!, email: m.email, fullName: m.fullName, role: m.role });
        }
        if (spec.plan === "CLINICA" || spec.plan === "LIBRE") await ensureRoomsInTx(tx, tenant.id);
        if (o.sampleData) {
          const s = await ensureSampleDataInTx(tx, { tenantId: tenant.id, slug: spec.slug, now });
          log(`[qa-tenants] ${spec.slug}: datos de muestra +${s.patients} pacientes, +${s.bookings} turnos`);
        }
        return isNew;
      },
      { maxWait: 15_000, timeout: 120_000 }
    );
    if (created) tenantsCreated++;
    log(`[qa-tenants] ${spec.slug}: ${created ? "creado" : "ya existía (re-alineado)"} · ${members.length} persona(s)`);
    for (const m of members) {
      rows.push({ slug: spec.slug, plan: spec.plan, vertical: spec.vertical, role: m.role, label: m.label, email: m.email });
    }
  }
  return { rows, tenantsCreated, usersCreated };
}

// ─── --state ────────────────────────────────────────────────────────────────

/** Patch de acceso por estado (C-BO1, `tenantAccessFor`). Las fechas relativas a `now`. */
export function qaStatePatch(state: QaState, now: Date): EntitlementPatchFor<"platform"> {
  const active = { status: "ACTIVE" as const, statusReason: null };
  switch (state) {
    case "active":
      return { ...active, subscriptionStatus: "ACTIVE", trialEndsAt: null };
    case "trial":
      return { ...active, subscriptionStatus: "TRIALING", trialEndsAt: new Date(now.getTime() + 14 * DAY_MS) };
    case "trial-expired":
      // Vencida hace 3 días: dentro de la gracia (escribe, con banda).
      return { ...active, subscriptionStatus: "TRIALING", trialEndsAt: new Date(now.getTime() - 3 * DAY_MS) };
    case "read-only":
      // Vencida y fuera de la gracia: solo lectura (las escrituras rebotan; la HC se sigue leyendo, Ley 26.529).
      return { ...active, subscriptionStatus: "TRIALING", trialEndsAt: new Date(now.getTime() - (TRIAL_GRACE_DAYS + 3) * DAY_MS) };
    case "past-due":
      // El escritor estampa `subscriptionStatusChangedAt` = ahora: arranca la gracia de 10 días.
      return { ...active, subscriptionStatus: "PAST_DUE", trialEndsAt: null };
    case "suspended":
      // `encodeStatusReason("TEST", …)` (lib/platform-tenants-schemas.ts): el código TEST existe para esto.
      return { status: "SUSPENDED", statusReason: "TEST: consultorio de QA" };
  }
}

export async function setQaTenantState(deps: QaDeps, slug: string, state: QaState): Promise<{ access: TenantAccess }> {
  const specs = qaSlugs(deps.slugPrefix ?? QA_SLUG_PREFIX);
  if (!slug.startsWith("qa-") || !specs.some((s) => s.slug === slug)) {
    throw new Error(`[qa-tenants] --state solo para los consultorios qa- (${specs.map((s) => s.slug).join(", ")}).`);
  }
  if (!(QA_STATES as readonly string[]).includes(state)) {
    throw new Error(`[qa-tenants] estado desconocido «${state}»: ${QA_STATES.join(" | ")}.`);
  }
  const now = deps.now ?? new Date();
  return deps.db.$transaction(async (tx) => {
    const t = await tx.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (!t) throw new Error(`[qa-tenants] ${slug} no existe: corré el script sin --state primero.`);
    const r = await applyTenantEntitlementsInTx(tx, { tenantId: t.id, source: "platform", patch: qaStatePatch(state, now), actor: SCRIPT_ACTOR });
    if (!r.ok) throw new Error(`[qa-tenants] ${slug}: ${r.reason}`);
    const row = await tx.tenant.findUniqueOrThrow({ where: { id: t.id }, select: TENANT_ACCESS_SELECT });
    return { access: tenantAccessFor(row, now) };
  });
}

// ─── --cleanup ──────────────────────────────────────────────────────────────

/**
 * Borra los 8 consultorios QA (`deleteTenantDeep`, el mismo teardown ordenado de los tests) y después sus perfiles y
 * cuentas de Auth. La base primero: si Auth falla a la mitad quedan cuentas huérfanas que la próxima corrida encuentra
 * por email (`emailBase`); al revés quedarían consultorios con cuentas borradas.
 */
export async function cleanupQaTenants(
  deps: QaDeps,
  o: { emailBase?: string }
): Promise<{ tenants: string[]; authUsersDeleted: number; profilesDeleted: number }> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const specs = qaSlugs(deps.slugPrefix ?? QA_SLUG_PREFIX);
  const slugs = specs.map((s) => s.slug);
  const { db } = deps;
  const tenants = await db.tenant.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } });
  const candidates = new Set<string>();
  const done: string[] = [];
  for (const t of tenants) {
    if (!t.slug.startsWith("qa-")) continue; // redundante con `qaSlugs`; segunda red a propósito
    const members = await db.membership.findMany({ where: { tenantId: t.id }, select: { userId: true, user: { select: { email: true } } } });
    for (const m of members) if (isQaEmail(m.user.email, slugs)) candidates.add(m.userId);
    await deleteTenantDeep(db, t.id);
    done.push(t.slug);
    log(`[qa-tenants] ${t.slug}: borrado`);
  }

  // Perfiles de QA que quedaron sin consultorio (deleteTenantDeep solo borra los `test-user-`).
  let profilesDeleted = 0;
  const ids = [...candidates];
  if (ids.length) {
    const removable = (
      await db.userProfile.findMany({
        where: { id: { in: ids }, memberships: { none: {} }, practitioners: { none: {} } },
        select: { id: true, email: true },
      })
    )
      .filter((u) => isQaEmail(u.email, slugs))
      .map((u) => u.id);
    if (removable.length) {
      await db.userPreferences.deleteMany({ where: { userId: { in: removable } } });
      // UserSecurityEvent es solo inserción (trigger): mismo modo réplica LOCAL que el teardown de los tests.
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRaw`DELETE FROM "UserSecurityEvent" WHERE "userId" = ANY(${removable})`,
      ]);
      const r = await db.userProfile.deleteMany({ where: { id: { in: removable } } });
      profilesDeleted = r.count;
    }
  }

  // Auth: los miembros de arriba + (con emailBase) las cuentas canónicas que hayan quedado huérfanas.
  const authIds = new Set(candidates);
  if (o.emailBase) {
    for (const spec of specs) {
      for (const m of membersForPlan(spec.plan)) {
        const f = await deps.auth.findUserByEmail(qaEmail(o.emailBase, spec.slug, m.tag));
        if (f.ok && f.data && isQaEmail(f.data.email, slugs)) authIds.add(f.data.id);
      }
    }
  }
  let authUsersDeleted = 0;
  for (const id of authIds) {
    // Nunca una cuenta que sigue siendo de alguien (perfil vivo con membresías en otro consultorio).
    const alive = await db.membership.count({ where: { userId: id } });
    if (alive > 0) continue;
    const r = await deps.auth.deleteUser(id);
    if (r.ok) authUsersDeleted++;
    else if (r.code !== "not_found") throw new Error(`[qa-tenants] Auth: no pude borrar la cuenta ${id} (${r.code}).`);
  }
  return { tenants: done, authUsersDeleted, profilesDeleted };
}

// ─── salida ─────────────────────────────────────────────────────────────────

/** Tabla de accesos (una vez, al final). Sin la contraseña. */
export function formatAccessTable(rows: readonly QaAccessRow[], appUrl?: string): string {
  const head = ["Consultorio", "Plan", "Tipo", "Rol", "Email"];
  const body = rows.map((r) => [r.slug, PLAN_DEFAULTS[r.plan].label, verticalLabel(r.vertical), r.label, r.email]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i])).join("  ");
  return [
    line(head),
    w.map((n) => "─".repeat(n)).join("  "),
    ...body.map(line),
    "",
    `Contraseña de todas las cuentas: la de QA_PASSWORD (no se imprime).${appUrl ? ` Entrar en ${appUrl.replace(/\/$/, "")}/login` : ""}`,
  ].join("\n");
}
