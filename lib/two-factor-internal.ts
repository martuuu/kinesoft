import "server-only";
/**
 * Núcleo de la 2FA por usuario (PL-2a, contrato C-PL6, plan §20.5.5). Server-only.
 *
 * Es el ÚNICO módulo que escribe `TwoFactorChallenge`, `TwoFactorRecoveryCode`, `UserSecurityEvent` y los flags
 * `UserProfile.twoFactorTotp/twoFactorEmail/twoFactorUpdatedAt` (M8). Las cuatro cosas son SERVICE_ONLY (ENABLE +
 * FORCE sin policies): van por `prismaService`. Lo llaman las actions de `lib/two-factor.ts` y el reset del
 * superadmin (`lib/platform-users.ts`).
 *
 * Código por email (PL-D12):
 *  - 6 dígitos de `randomInt` (CSPRNG). En la base solo el HMAC del código, ligado a usuario + propósito + sesión: la
 *    tabla filtrada no dice el código y un hash de una sesión no sirve en otra. El código vive en memoria hasta el
 *    mail y nunca se loguea (el mail tampoco lo deja en `EmailLog`: ver `lib/email/templates-account.ts`).
 *  - TTL 10 min (`EMAIL_CODE_TTL_S`), 5 intentos (`EMAIL_CODE_MAX_ATTEMPTS`; al quinto error se cierra `LOCKED`).
 *  - Reenvío: uno cada 60 s por usuario + propósito + sesión, y 5 por hora por usuario (todas las sesiones y
 *    propósitos: es un tope de mails a una casilla, que no se esquiva abriendo sesiones nuevas).
 *  - A lo sumo UNO abierto por usuario + propósito + sesión (índice parcial `TwoFactorChallenge_one_open`): pedir
 *    otro cierra el anterior con `REPLACED` en la misma tx. Las dos cosas van bajo `FOR UPDATE` de la fila del
 *    `UserProfile`: dos pedidos simultáneos se serializan (el segundo ve el primero y cae en «esperá 60 s»), en vez
 *    de que uno reviente con 23505.
 *  - Verificar también bloquea el desafío (`FOR UPDATE`): dos intentos simultáneos no pueden gastar el mismo
 *    contador ni verificar dos veces el mismo código.
 *
 * Códigos de recuperación: 10, de un uso, 10 caracteres de un alfabeto sin ambiguos (~49 bits). En la base el HMAC
 * (único por usuario: es como se buscan). Regenerar borra TODOS los anteriores (usados o no) en la misma tx.
 *
 * Clave de los HMAC: derivada de `SUPABASE_SERVICE_ROLE_KEY` con etiqueta propia (distinta de las cookies de
 * `lib/two-factor-cookie.ts` y de platform-reauth). Sin service key (dev local), aleatoria por proceso: reiniciar el
 * server invalida los códigos pendientes y los de recuperación de dev (aceptable: dev).
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import type { Prisma, TwoFactorPurpose } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { env } from "@/lib/env";
import { clientIp } from "@/lib/client-ip";
import { EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_S, type TwoFactorMethods } from "@/lib/two-factor-logic";

export const EMAIL_CODE_RESEND_S = 60;
export const EMAIL_CODE_HOURLY_LIMIT = 5;
export const RECOVERY_CODE_COUNT = 10;
/** Sin 0/o, 1/l/i: se dictan y se copian de un papel. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RECOVERY_LEN = 10;

/** Clases de evento del registro de seguridad de la cuenta (CHECK de M8: 1..80 caracteres). */
export type UserSecurityEventKind =
  | "two_factor.totp_enabled"
  | "two_factor.totp_disabled"
  | "two_factor.email_enabled"
  | "two_factor.email_disabled"
  | "two_factor.recovery_generated"
  | "two_factor.recovery_used"
  | "two_factor.email_code_locked"
  | "two_factor.reset_by_platform";

type Tx = Prisma.TransactionClient;

// ── HMAC ──────────────────────────────────────────────────────────────────────

let devKey: Buffer | null = null;
function hmacKey(): Buffer {
  const base = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base) return createHmac("sha256", base).update("kinesoft:two-factor-codes:v1").digest();
  devKey ??= randomBytes(32);
  return devKey;
}

function hmac(value: string): string {
  return createHmac("sha256", hmacKey()).update(value).digest("hex");
}

/** HMAC del código de email, ligado a usuario + propósito + sesión. Exportado para el test (nunca el código). */
export function emailCodeHash(userId: string, purpose: TwoFactorPurpose, sessionId: string, code: string): string {
  return hmac(`email.${userId}.${purpose}.${sessionId}.${code}`);
}

function recoveryHash(userId: string, normalized: string): string {
  return hmac(`recovery.${userId}.${normalized}`);
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

// ── Formatos (puros) ──────────────────────────────────────────────────────────

/** 6 dígitos con ceros a la izquierda. */
export function generateEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** «123 456», «123-456», « 123456 » → «123456». Cualquier otra cosa → null. */
export function normalizeEmailCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(v) ? v : null;
}

/** «abcde-fghjk» (como se muestra). */
export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    let s = "";
    for (let i = 0; i < RECOVERY_LEN; i++) s += RECOVERY_ALPHABET[randomInt(0, RECOVERY_ALPHABET.length)];
    out.add(`${s.slice(0, 5)}-${s.slice(5)}`);
  }
  return [...out];
}

/** Sin guiones ni espacios, en minúsculas; null si no tiene la forma de un código de recuperación. */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.toLowerCase().replace(/[\s-]/g, "");
  if (v.length !== RECOVERY_LEN) return null;
  for (const ch of v) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return v;
}

// ── Registro de seguridad ─────────────────────────────────────────────────────

function requestMeta(): { ip: string | null; userAgent: string | null } {
  try {
    const h = headers();
    return { ip: clientIp(h, null), userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
  } catch {
    return { ip: null, userAgent: null }; // fuera de un request (cron, script)
  }
}

/**
 * Una fila en `UserSecurityEvent` (solo inserción: el trigger de M8 rechaza UPDATE/DELETE). Payload sin secretos:
 * nunca un código, un hash ni un id de factor.
 */
export async function recordUserSecurityEventInTx(
  tx: Tx,
  p: { userId: string; kind: UserSecurityEventKind; payload?: Prisma.InputJsonValue; tenantId?: string | null }
): Promise<void> {
  const meta = requestMeta();
  await tx.userSecurityEvent.create({
    data: {
      userId: p.userId,
      tenantId: p.tenantId ?? null,
      kind: p.kind,
      ...(p.payload !== undefined ? { payload: p.payload } : {}),
      ip: meta.ip,
      userAgent: meta.userAgent,
    },
    select: { id: true },
  });
}

// ── Flags de métodos ──────────────────────────────────────────────────────────

/** Prende/apaga un método y deja el evento. Idempotente: si ya estaba así, no escribe nada y devuelve false. */
export async function setTwoFactorMethodInTx(
  tx: Tx,
  p: { userId: string; method: keyof TwoFactorMethods; on: boolean; now?: Date }
): Promise<boolean> {
  const at = p.now ?? new Date();
  const r =
    p.method === "totp"
      ? await tx.userProfile.updateMany({
          where: { id: p.userId, twoFactorTotp: !p.on },
          data: { twoFactorTotp: p.on, twoFactorUpdatedAt: at },
        })
      : await tx.userProfile.updateMany({
          where: { id: p.userId, twoFactorEmail: !p.on },
          data: { twoFactorEmail: p.on, twoFactorUpdatedAt: at },
        });
  if (r.count === 0) return false;
  await recordUserSecurityEventInTx(tx, {
    userId: p.userId,
    kind: `two_factor.${p.method}_${p.on ? "enabled" : "disabled"}` as UserSecurityEventKind,
  });
  return true;
}

// ── Código por email ──────────────────────────────────────────────────────────

export type EmailChallengeIssue =
  | { kind: "issued"; code: string; expiresAt: Date }
  | { kind: "too_soon"; retryAfterS: number }
  | { kind: "hourly_limit"; retryAfterS: number };

/** Serializa todo lo de 2FA de un usuario dentro de la tx (ver cabecera). */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "UserProfile" WHERE "id" = ${userId} FOR UPDATE`;
}

/**
 * Emite un código nuevo: cierra el abierto de la misma sesión y propósito (`REPLACED`) y crea otro. Devuelve el
 * código EN CLARO para el mail (solo en memoria). No manda el mail: eso va después del commit, en la action.
 */
export async function issueEmailChallenge(p: {
  userId: string;
  purpose: TwoFactorPurpose;
  sessionId: string;
  now?: Date;
}): Promise<EmailChallengeIssue> {
  const now = p.now ?? new Date();
  return prismaService.$transaction(async (tx) => {
    await lockUser(tx, p.userId);
    const last = await tx.twoFactorChallenge.findFirst({
      where: { userId: p.userId, purpose: p.purpose, sessionId: p.sessionId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last) {
      const elapsedS = (now.getTime() - last.createdAt.getTime()) / 1000;
      if (elapsedS < EMAIL_CODE_RESEND_S) return { kind: "too_soon", retryAfterS: Math.ceil(EMAIL_CODE_RESEND_S - elapsedS) };
    }
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const recent = await tx.twoFactorChallenge.findMany({
      where: { userId: p.userId, createdAt: { gt: hourAgo } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    if (recent.length >= EMAIL_CODE_HOURLY_LIMIT) {
      const freeAt = recent[recent.length - EMAIL_CODE_HOURLY_LIMIT].createdAt.getTime() + 3_600_000;
      return { kind: "hourly_limit", retryAfterS: Math.max(1, Math.ceil((freeAt - now.getTime()) / 1000)) };
    }
    await tx.twoFactorChallenge.updateMany({
      where: { userId: p.userId, purpose: p.purpose, sessionId: p.sessionId, closedAt: null },
      data: { closedAt: now, closedReason: "REPLACED" },
    });
    const code = generateEmailCode();
    const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL_S * 1000);
    await tx.twoFactorChallenge.create({
      data: {
        userId: p.userId,
        purpose: p.purpose,
        sessionId: p.sessionId,
        codeHash: emailCodeHash(p.userId, p.purpose, p.sessionId, code),
        expiresAt,
        createdAt: now,
      },
      select: { id: true },
    });
    return { kind: "issued", code, expiresAt };
  });
}

export type EmailChallengeCheck =
  | { kind: "ok" }
  | { kind: "bad_code"; attemptsLeft: number }
  | { kind: "locked" }
  | { kind: "expired" }
  | { kind: "none" };

/**
 * Verifica el código contra el desafío ABIERTO de esta sesión y propósito. Un código de otra sesión no encuentra
 * desafío (`none`). Cada error suma un intento y se commitea (no se tira: un rollback devolvería el intento).
 */
export async function verifyEmailChallenge(p: {
  userId: string;
  purpose: TwoFactorPurpose;
  sessionId: string;
  code: string;
  now?: Date;
}): Promise<EmailChallengeCheck> {
  const now = p.now ?? new Date();
  return prismaService.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; codeHash: string; expiresAt: Date; attempts: number }>>`
      SELECT "id", "codeHash", "expiresAt", "attempts" FROM "TwoFactorChallenge"
      WHERE "userId" = ${p.userId} AND "purpose" = ${p.purpose}::"TwoFactorPurpose" AND "sessionId" = ${p.sessionId}
        AND "closedAt" IS NULL
      FOR UPDATE`;
    const ch = rows[0];
    if (!ch) return { kind: "none" };
    if (ch.expiresAt.getTime() <= now.getTime()) {
      await tx.twoFactorChallenge.update({ where: { id: ch.id }, data: { closedAt: now, closedReason: "EXPIRED" } });
      return { kind: "expired" };
    }
    if (sameHex(ch.codeHash, emailCodeHash(p.userId, p.purpose, p.sessionId, p.code))) {
      await tx.twoFactorChallenge.update({ where: { id: ch.id }, data: { closedAt: now, closedReason: "VERIFIED" } });
      return { kind: "ok" };
    }
    const attempts = ch.attempts + 1;
    if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      await tx.twoFactorChallenge.update({
        where: { id: ch.id },
        data: { attempts, closedAt: now, closedReason: "LOCKED" },
      });
      await recordUserSecurityEventInTx(tx, {
        userId: p.userId,
        kind: "two_factor.email_code_locked",
        payload: { purpose: p.purpose },
      });
      return { kind: "locked" };
    }
    await tx.twoFactorChallenge.update({ where: { id: ch.id }, data: { attempts } });
    return { kind: "bad_code", attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - attempts };
  });
}

// ── Códigos de recuperación ───────────────────────────────────────────────────

/** Borra los anteriores (usados o no) y crea 10 nuevos. Devuelve los códigos EN CLARO para mostrarlos una vez. */
export async function replaceRecoveryCodesInTx(tx: Tx, userId: string): Promise<string[]> {
  // PL-Z (a2#5): bajo el lock del usuario, como el resto del núcleo. Sin él, dos regeneraciones simultáneas (dos
  // pestañas) intercalaban deleteMany/createMany y quedaban 20 códigos válidos, de los que la persona vio 10.
  await lockUser(tx, userId);
  const codes = generateRecoveryCodes();
  await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
  await tx.twoFactorRecoveryCode.createMany({
    data: codes.map((c) => ({ userId, codeHash: recoveryHash(userId, normalizeRecoveryCode(c) as string) })),
  });
  await recordUserSecurityEventInTx(tx, { userId, kind: "two_factor.recovery_generated" });
  return codes;
}

/**
 * Códigos para mostrar si la persona no tiene ninguno sin usar (al prender el primer método). null = ya tenía.
 * PL-Z (a2#5): el conteo va bajo el lock: dos enrolamientos a la vez (app y email en dos pestañas) veían los dos «0
 * sin usar» y generaban dos juegos; el primero que se mostró quedaba inválido sin aviso.
 */
export async function ensureRecoveryCodesInTx(tx: Tx, userId: string): Promise<string[] | null> {
  await lockUser(tx, userId);
  const left = await countRecoveryCodesLeft(userId, tx);
  return left > 0 ? null : replaceRecoveryCodesInTx(tx, userId);
}

export async function countRecoveryCodesLeft(userId: string, tx: Tx | typeof prismaService = prismaService): Promise<number> {
  return tx.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } });
}

/**
 * Gasta un código (un uso). El `updateMany … usedAt: null` es atómico: dos usos simultáneos del mismo código → uno
 * solo cuenta. Devuelve cuántos quedan.
 */
export async function consumeRecoveryCode(p: {
  userId: string;
  code: string;
  now?: Date;
}): Promise<{ ok: true; remaining: number } | { ok: false }> {
  const normalized = normalizeRecoveryCode(p.code);
  if (!normalized) return { ok: false };
  const now = p.now ?? new Date();
  return prismaService.$transaction(async (tx) => {
    const r = await tx.twoFactorRecoveryCode.updateMany({
      where: { userId: p.userId, codeHash: recoveryHash(p.userId, normalized), usedAt: null },
      data: { usedAt: now },
    });
    if (r.count !== 1) return { ok: false as const };
    const remaining = await countRecoveryCodesLeft(p.userId, tx);
    await recordUserSecurityEventInTx(tx, { userId: p.userId, kind: "two_factor.recovery_used", payload: { remaining } });
    return { ok: true as const, remaining };
  });
}

// ── Reset (superadmin) y apagado total ────────────────────────────────────────

/**
 * Sin ningún método: borra los códigos de recuperación y cierra los desafíos abiertos (un código pedido antes ya no
 * sirve para nada). Lo usan el reset del superadmin y apagar el último método.
 */
export async function clearTwoFactorSecretsInTx(tx: Tx, userId: string, now: Date = new Date()): Promise<void> {
  await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
  await tx.twoFactorChallenge.updateMany({
    where: { userId, closedAt: null },
    data: { closedAt: now, closedReason: "REPLACED" },
  });
}

/**
 * Reset de la 2FA por un superadmin (`lib/platform-users.ts`, en SU tx con el registro de Plataforma): apaga los dos
 * flags, borra los códigos y cierra los desafíos. Los factores TOTP de Supabase los borra el caller DESPUÉS del
 * commit (`authAdminMfa().deleteFactor`). Devuelve qué tenía prendido (para el registro).
 */
export async function resetTwoFactorInTx(
  tx: Tx,
  p: { userId: string; byUserId: string; now?: Date }
): Promise<{ had: TwoFactorMethods } | null> {
  const now = p.now ?? new Date();
  await lockUser(tx, p.userId);
  const prof = await tx.userProfile.findUnique({
    where: { id: p.userId },
    select: { twoFactorTotp: true, twoFactorEmail: true },
  });
  if (!prof) return null;
  await tx.userProfile.update({
    where: { id: p.userId },
    data: { twoFactorTotp: false, twoFactorEmail: false, twoFactorUpdatedAt: now },
  });
  await clearTwoFactorSecretsInTx(tx, p.userId, now);
  await recordUserSecurityEventInTx(tx, {
    userId: p.userId,
    kind: "two_factor.reset_by_platform",
    // El id del superadmin y no su email: el registro de la cuenta lo puede ver la persona.
    payload: { byUserId: p.byUserId, hadTotp: prof.twoFactorTotp, hadEmail: prof.twoFactorEmail },
  });
  return { had: { totp: prof.twoFactorTotp, email: prof.twoFactorEmail } };
}

// ── Lectura para /cuenta/seguridad ────────────────────────────────────────────

export type SecurityEventRow = { id: string; kind: string; createdAt: string; ip: string | null };

export type TwoFactorOverview = {
  methods: TwoFactorMethods;
  updatedAt: string | null;
  recoveryCodesLeft: number;
  events: SecurityEventRow[];
};

export async function loadTwoFactorOverview(userId: string): Promise<TwoFactorOverview | null> {
  const [prof, left, events] = await Promise.all([
    prismaService.userProfile.findUnique({
      where: { id: userId },
      select: { twoFactorTotp: true, twoFactorEmail: true, twoFactorUpdatedAt: true },
    }),
    countRecoveryCodesLeft(userId),
    prismaService.userSecurityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, kind: true, createdAt: true, ip: true },
    }),
  ]);
  if (!prof) return null;
  return {
    methods: { totp: prof.twoFactorTotp, email: prof.twoFactorEmail },
    updatedAt: prof.twoFactorUpdatedAt?.toISOString() ?? null,
    recoveryCodesLeft: left,
    events: events.map((e) => ({ id: e.id, kind: e.kind, createdAt: e.createdAt.toISOString(), ip: e.ip })),
  };
}
