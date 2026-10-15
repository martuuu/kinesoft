import "server-only";
/**
 * Jobs diarios de Vercel Cron (BO5-A, plan §19.5): invitaciones vencidas, recordatorios de prueba y resumen de
 * salud. Los llaman las rutas `app/api/cron/<job>/route.ts` (ver `runCronRoute`).
 *
 * Superficie SIN Actor (nadie inició sesión: el que llama es Vercel con `CRON_SECRET`) y que cruza consultorios:
 * por eso `prismaService` (AGENTS.md §4). No lee PHI: ni `Patient` ni nada clínico; los mails llevan solo nombre del
 * consultorio (al OWNER) o conteos (a los superadmins), y los logs solo ids y conteos.
 *
 * Contrato de cada job:
 *  - **idempotente**: se puede correr dos veces el mismo día (reintento de Vercel, disparo a mano) sin reenviar
 *    nada. La «reserva» es una fila de `PlatformAuditEvent` con `idempotencyKey` UNIQUE (ON CONFLICT DO NOTHING,
 *    `auditPlatformGlobalInTx`), escrita ANTES de mandar: dos corridas simultáneas no pueden mandar las dos (la
 *    segunda espera el commit de la primera y recibe `inserted: false`). Se eligió eso y no «buscar en EmailLog
 *    antes de mandar» porque EmailLog no tiene una clave única: buscar-y-mandar tiene carrera.
 *    Costo aceptado: si el envío falla después de reservar, ese recordatorio no se reintenta (queda el
 *    `EmailLog` con `status=failed` y la fila del registro dice a quién se intentó).
 *  - **acotado**: cada consulta tiene ventana o `take`.
 *  - **nunca tira**: un consultorio que falla se cuenta en `errors` y se sigue con el siguiente; el wrapper de la
 *    ruta convierte cualquier otra excepción en un 500 con JSON.
 */
import type { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { auditPlatformGlobalInTx, type PlatformActorRef } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import "@/lib/email/log";
import { platformHealthDigestEmail, trialReminderEmail } from "@/lib/email/templates";
import { authAdmin, type AuthUserLite } from "@/lib/identity/auth-admin";
import { authOrphansFrom, emailMismatchesFrom, stalledOnboardingCutoff } from "@/lib/platform-health-logic";
import { TENANT_ACCESS_SELECT } from "@/lib/tenant-access";
import { toARDateKey } from "@/lib/datetime-ar";
import { checkCronAuth } from "@/lib/cron-auth";
import { maintenanceMode } from "@/lib/maintenance";
import {
  healthDigestFindings,
  healthDigestKey,
  healthDigestUnavailable,
  trialReminderFor,
  trialReminderKey,
  trialReminderWindow,
  type HealthDigestCounts,
} from "@/lib/cron-jobs-logic";

/** El cron no es una persona: el registro de plataforma lo guarda con actor nulo (`actorEmail` null). */
const CRON_ACTOR: PlatformActorRef = { userId: null, email: null, homeTenantId: null };

const DAY_MS = 86_400_000;

/** Techo de consultorios por corrida de recordatorios (hoy son decenas; con más, el resto sale al día siguiente). */
const TRIAL_SCAN_LIMIT = 500;

function appUrl(path: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${path}`;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

// ── Ruta ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type CronJobName = "invitations-expire" | "trial-reminders" | "health-digest";

const NO_STORE = { "cache-control": "no-store, max-age=0" };

/**
 * El cuerpo común de las tres rutas: autoriza (`lib/cron-auth.ts`), corre el job con `now` y responde JSON.
 * El secreto y el entorno se leen de `process.env` en CADA request (no de `lib/env`, que se congela al importar):
 * los tests lo cambian con `vi.stubEnv`.
 */
export async function runCronRoute(
  req: Request,
  job: CronJobName,
  run: (now: Date) => Promise<Record<string, unknown>>
): Promise<Response> {
  const auth = checkCronAuth({
    authorization: req.headers.get("authorization"),
    secret: process.env.CRON_SECRET,
    production: process.env.VERCEL_ENV === "production",
  });
  if (!auth.ok) {
    // Sin el header: si alguien probó un secreto, no queremos ese valor en los logs de Vercel.
    const log = auth.status === 503 ? logger.error : logger.warn;
    log(`cron.${auth.reason}`, { job });
    return Response.json({ ok: false }, { status: auth.status, headers: NO_STORE });
  }
  // BO5-B deja pasar `/api/cron/**` en mantenimiento («el cron decide por su cuenta»): acá se decide no correr.
  // Un mantenimiento suele ser una migración en curso; mandar recordatorios o un resumen con la base a medio
  // migrar daría conteos falsos. 200 (no 503) para que Vercel no lo marque como falla: no corrió a propósito.
  if (maintenanceMode(process.env.MAINTENANCE_MODE) === "on") {
    logger.info("cron.skipped_maintenance", { job });
    return Response.json({ ok: true, job, skipped: "maintenance" }, { headers: NO_STORE });
  }
  const startedAt = Date.now();
  try {
    const result = await run(new Date());
    logger.info("cron.done", { job, ms: Date.now() - startedAt, ...result });
    return Response.json({ ok: true, job, ...result }, { headers: NO_STORE });
  } catch (err) {
    logger.error("cron.failed", { job, ms: Date.now() - startedAt, error: errName(err) });
    return Response.json({ ok: false, job }, { status: 500, headers: NO_STORE });
  }
}

// ── 1. Invitaciones vencidas ──────────────────────────────────────────────────────────────────────────────────

const NOT_CLOSED: Prisma.TenantWhereInput = { status: { not: "CLOSED" } };

export type InvitationsExpireResult = { written: 0; expiredPending: number; expiredLast24h: number };

/**
 * Decisión (BO5-A): este job NO escribe. `Invitation` no tiene una columna de estado: «vencida» se DERIVA de
 * `expiresAt` (`invitationStatus` en lib/access-logic.ts) y la aceptación ya la rechaza por fecha
 * (lib/invitations*.ts). Escribir `revokedAt` mentiría (nadie la anuló: la UI mostraría «anulada» en vez de
 * «vencida») y sumar una columna sería una migración para un dato que ya se calcula. El job queda como contador
 * diario en los logs (`cron.done`) para ver la tendencia; la lista y el «anular» siguen en /plataforma/salud.
 * Mismo criterio que el detector `expiredInvitations` (pendiente, vencida, consultorio no dado de baja).
 */
export async function runInvitationsExpire(now: Date): Promise<InvitationsExpireResult> {
  const pending: Prisma.InvitationWhereInput = { acceptedAt: null, revokedAt: null, tenant: NOT_CLOSED };
  const [expiredPending, expiredLast24h] = await Promise.all([
    prismaService.invitation.count({ where: { ...pending, expiresAt: { lte: now } } }),
    prismaService.invitation.count({ where: { ...pending, expiresAt: { lte: now, gt: new Date(now.getTime() - DAY_MS) } } }),
  ]);
  return { written: 0, expiredPending, expiredLast24h };
}

// ── 2. Recordatorios de prueba ────────────────────────────────────────────────────────────────────────────────

export type TrialRemindersResult = {
  scanned: number;
  due: number;
  claimed: number;
  alreadySent: number;
  noOwner: number;
  mailsSent: number;
  mailsNotSent: number;
  errors: number;
};

/**
 * A los OWNER activos de consultorios ACTIVE en TRIALING con 7/3/1 días de prueba o recién vencida
 * (`trialReminderFor`). SUSPENDED/CLOSED quedan afuera desde la consulta (y `tenantAccessFor` lo vuelve a cortar).
 * Sin OWNER activo no se reserva: si aparece uno, el recordatorio sale en la próxima corrida.
 */
export async function runTrialReminders(now: Date): Promise<TrialRemindersResult> {
  const r: TrialRemindersResult = {
    scanned: 0,
    due: 0,
    claimed: 0,
    alreadySent: 0,
    noOwner: 0,
    mailsSent: 0,
    mailsNotSent: 0,
    errors: 0,
  };
  const win = trialReminderWindow(now);
  const tenants = await prismaService.tenant.findMany({
    where: { status: "ACTIVE", subscriptionStatus: "TRIALING", trialEndsAt: { gte: win.from, lte: win.to } },
    select: { id: true, name: true, ...TENANT_ACCESS_SELECT },
    orderBy: [{ trialEndsAt: "asc" }, { id: "asc" }],
    take: TRIAL_SCAN_LIMIT,
  });
  r.scanned = tenants.length;

  for (const t of tenants) {
    try {
      const due = trialReminderFor(t, now);
      const endsAt = t.trialEndsAt;
      if (!due || !endsAt) continue;
      r.due++;
      const owners = await prismaService.membership.findMany({
        where: { tenantId: t.id, role: "OWNER", acceptedAt: { not: null }, disabledAt: null, user: { disabledAt: null } },
        select: { userId: true, user: { select: { email: true } } },
        orderBy: { userId: "asc" },
      });
      if (owners.length === 0) {
        r.noOwner++;
        continue;
      }
      const claim = await prismaService.$transaction((tx) =>
        auditPlatformGlobalInTx(tx, {
          actor: CRON_ACTOR,
          action: "platform.cron.trial_reminder",
          entity: "Tenant",
          entityId: t.id,
          tenantId: t.id,
          payload: { stage: due.stage, daysLeft: due.daysLeft, trialEndsOn: toARDateKey(endsAt), recipients: owners.length },
          idempotencyKey: trialReminderKey(t.id, due.stage, endsAt),
        })
      );
      if (!claim.inserted) {
        r.alreadySent++;
        continue;
      }
      r.claimed++;
      const mail = trialReminderEmail({
        tenantName: t.name,
        daysLeft: due.daysLeft,
        expired: due.stage === "expired",
        url: appUrl("/configuracion?tab=plan"),
      });
      for (const o of owners) {
        // `sendEmail` nunca tira; EmailLog guarda el intento con el consultorio.
        const res = await sendEmail({ ...mail, kind: "trial_reminder", to: o.user.email, tenantId: t.id, entity: "Tenant", entityId: t.id });
        if (res.ok) r.mailsSent++;
        else r.mailsNotSent++;
      }
    } catch (err) {
      r.errors++;
      logger.warn("cron.trial_reminders.tenant_failed", { tenantId: t.id, error: errName(err) });
    }
  }
  return r;
}

// ── 3. Resumen de salud ───────────────────────────────────────────────────────────────────────────────────────

const LIST_PER_PAGE = 1000;
const LIST_MAX_PAGES = 100;

/** Igual que `lib/platform-health-read.ts`: todo el padrón de Auth o null (nunca una lista parcial). */
async function listAllAuthUsers(): Promise<AuthUserLite[] | null> {
  const port = authAdmin();
  const out: AuthUserLite[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const res = await port.listUsers({ page, perPage: LIST_PER_PAGE });
    if (!res.ok) return null;
    out.push(...res.data.users);
    if (res.data.users.length < LIST_PER_PAGE) return out;
  }
  return null;
}

async function authCounts(): Promise<{ authOrphans: number | null; emailMismatches: number | null }> {
  try {
    const users = await listAllAuthUsers();
    if (!users) return { authOrphans: null, emailMismatches: null };
    const ids = users.map((u) => u.id);
    const profiles = ids.length
      ? await prismaService.userProfile.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
      : [];
    return {
      authOrphans: authOrphansFrom(users, new Set(profiles.map((p) => p.id))).length,
      emailMismatches: emailMismatchesFrom(profiles, users).length,
    };
  } catch {
    return { authOrphans: null, emailMismatches: null };
  }
}

/**
 * Núcleo SIN guard de los detectores de `/plataforma/salud`, solo CONTEOS. Por qué acá y no reusando
 * `getPlatformHealth()`: ese export exige `requirePlatformAdmin` (sesión de un superadmin) y el cron no tiene
 * sesión; y un export sin guard dentro de `lib/platform-*` rompería el invariante del gate de BO («un
 * `requirePlatformAdmin` por export de `lib/platform-*`»). Los `where` son COPIA de los de
 * `lib/platform-health-read.ts` (BO2-C): si cambia un criterio allá, se cambia acá (handoff de BO5-A para
 * moverlos a `lib/platform-health-logic.ts` y que lo usen los dos).
 */
export async function healthCountsCore(now: Date): Promise<HealthDigestCounts> {
  const [auth, clinical, pracNoMember, profilesWithoutAccess, tenantsWithoutOwner, expiredInvitations, stalledOnboarding] =
    await Promise.all([
      authCounts(),
      prismaService.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n
        FROM "Membership" m
        JOIN "Tenant" t ON t."id" = m."tenantId"
        JOIN "UserProfile" u ON u."id" = m."userId"
        WHERE m."acceptedAt" IS NOT NULL
          AND m."disabledAt" IS NULL
          -- PL-1d: miembro clínico = isClinicalMember (un Titular que no atiende no necesita Practitioner).
          AND (m."role" = 'PRACTITIONER' OR (m."role" IN ('OWNER', 'ADMIN') AND m."clinical"))
          AND t."status" <> 'CLOSED'
          AND NOT EXISTS (SELECT 1 FROM "Practitioner" p WHERE p."tenantId" = m."tenantId" AND p."userId" = m."userId")`,
      prismaService.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n
        FROM "Practitioner" p
        JOIN "Tenant" t ON t."id" = p."tenantId"
        JOIN "UserProfile" u ON u."id" = p."userId"
        WHERE t."status" <> 'CLOSED'
          AND NOT EXISTS (SELECT 1 FROM "Membership" m WHERE m."tenantId" = p."tenantId" AND m."userId" = p."userId")`,
      prismaService.userProfile.count({ where: { memberships: { none: {} }, patients: { none: {} }, isPlatformAdmin: false } }),
      prismaService.tenant.count({
        where: {
          ...NOT_CLOSED,
          memberships: { none: { role: "OWNER", acceptedAt: { not: null }, disabledAt: null, user: { disabledAt: null } } },
        },
      }),
      prismaService.invitation.count({
        where: { acceptedAt: null, revokedAt: null, expiresAt: { lte: now }, tenant: NOT_CLOSED },
      }),
      prismaService.tenant.count({
        where: { ...NOT_CLOSED, onboardingCompletedAt: null, createdAt: { lt: stalledOnboardingCutoff(now) } },
      }),
    ]);
  return {
    authOrphans: auth.authOrphans,
    emailMismatches: auth.emailMismatches,
    profilesWithoutAccess,
    clinicalWithoutPractitioner: Number(clinical[0]?.n ?? 0),
    practitionersWithoutMembership: Number(pracNoMember[0]?.n ?? 0),
    tenantsWithoutOwner,
    expiredInvitations,
    stalledOnboarding,
  };
}

export type HealthDigestResult = {
  day: string;
  alreadyRan: boolean;
  counts: HealthDigestCounts;
  findings: number;
  recipients: number;
  mailsSent: number;
  mailsNotSent: number;
};

/**
 * Corre los detectores y deja SIEMPRE una fila `platform.cron.health_digest` con los conteos (también en cero:
 * «corrió y estaba todo bien» es información). Manda el mail a los superadmins activos solo si algún conteo es
 * > 0. Una vez por día AR (`healthDigestKey`): la segunda corrida no escribe ni manda.
 */
export async function runHealthDigest(now: Date): Promise<HealthDigestResult> {
  const day = toARDateKey(now);
  const counts = await healthCountsCore(now);
  const findings = healthDigestFindings(counts);
  const unavailable = healthDigestUnavailable(counts);
  const admins = findings.length
    ? await prismaService.userProfile.findMany({
        where: { isPlatformAdmin: true, disabledAt: null },
        select: { id: true, email: true },
        orderBy: { id: "asc" },
        take: 50,
      })
    : [];
  const base: HealthDigestResult = {
    day,
    alreadyRan: false,
    counts,
    findings: findings.length,
    recipients: admins.length,
    mailsSent: 0,
    mailsNotSent: 0,
  };

  const claim = await prismaService.$transaction((tx) =>
    auditPlatformGlobalInTx(tx, {
      actor: CRON_ACTOR,
      action: "platform.cron.health_digest",
      entity: "PlatformHealth",
      entityId: day,
      payload: { day, counts, unavailable: unavailable.length, notify: findings.length > 0, recipients: admins.length },
      idempotencyKey: healthDigestKey(now),
    })
  );
  if (!claim.inserted) return { ...base, alreadyRan: true, recipients: 0 };
  if (!findings.length) return base;

  const mail = platformHealthDigestEmail({
    dateKey: day,
    lines: findings,
    unavailable,
    url: appUrl("/plataforma/salud"),
  });
  for (const a of admins) {
    const res = await sendEmail({
      ...mail,
      kind: "platform_health_digest",
      to: a.email,
      tenantId: null,
      entity: "PlatformAuditEvent",
      entityId: claim.platformEventId,
    });
    if (res.ok) base.mailsSent++;
    else base.mailsNotSent++;
  }
  return base;
}
