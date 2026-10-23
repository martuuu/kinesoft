/**
 * TV-2d (T7, §26.4 C-TV «Actions del dispositivo») · `pairDisplay` contra Postgres real, en los dos roles.
 *
 * El dispositivo no tiene Actor: escribe por `prismaService` con `id` + `tenantId` a mano, así que la integración corre
 * igual con `test:integration` (kinesoft_app) y `:owner` (BYPASSRLS = prod) y lo que se prueba es la barrera a mano.
 * Se mockea SOLO `next/headers` (un jar que además registra las opciones del `set`, para afirmar httpOnly/Strict/path)
 * y el ENV (Upstash apagado: el rate limit es el de memoria, reseteable). La action, el hash del código, el CAS y el
 * audit son los reales.
 *
 * Qué se fija: código vencido / reusado / concurrente (gana uno), re-vínculo que rota el secreto (la cookie vieja deja
 * de andar), el código de A nunca da B, consultorio suspendido o módulo revocado → no vincula, rate limit por IP y el
 * mensaje único ante cualquier fallo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const hdr = vi.hoisted(() => ({
  ip: "203.0.113.10",
  jar: new Map<string, { value: string; opts?: Record<string, unknown> }>(),
}));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (n: string) => (hdr.jar.has(n) ? { name: n, value: hdr.jar.get(n)!.value } : undefined),
    getAll: () => [...hdr.jar.entries()].map(([name, e]) => ({ name, value: e.value })),
    set: (n: string, v: string, opts?: Record<string, unknown>) => void hdr.jar.set(n, { value: v, opts }),
    delete: (n: string) => void hdr.jar.delete(n),
    has: (n: string) => hdr.jar.has(n),
  }),
  headers: () => new Headers({ "x-forwarded-for": hdr.ip, "user-agent": "vitest-tv" }),
}));

const over = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k in over.values ? over.values[k] : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

import { pairDisplay } from "@/lib/display-device";
import { resolveDisplaySession } from "@/lib/display-device-internal";
import { generatePairingCode, hashDeviceSecret, hashPairingCode, parseDisplayCookie } from "@/lib/display-pairing-internal";
import {
  DISPLAY_COOKIE,
  DISPLAY_COOKIE_MAX_AGE_S,
  PAIR_FAILED_MESSAGE,
  PAIRING_TTL_MS,
  formatPairingCode,
} from "@/lib/reception-displays-types";
import { toARDateKey } from "@/lib/datetime-ar";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const FAIL = { ok: false, error: PAIR_FAILED_MESSAGE };

async function newDisplay(db: PrismaClient, t: EphemeralTenant, o: { locationId?: string | null } = {}): Promise<string> {
  const d = await db.receptionDisplay.create({
    data: { tenantId: t.tenantId, name: `TV ${uniqueSuffix()}`, locationId: o.locationId ?? null, createdByUserId: t.userId },
    select: { id: true },
  });
  return d.id;
}

/** Lo que hace el staff al generar el código (TV-2s): se guarda solo el HMAC del código normalizado. */
async function issueCode(db: PrismaClient, id: string, ttlMs = PAIRING_TTL_MS): Promise<string> {
  const code = generatePairingCode();
  await db.receptionDisplay.update({
    where: { id },
    data: { pairingCodeHash: hashPairingCode(code), pairingExpiresAt: new Date(Date.now() + ttlMs) },
  });
  return code;
}

const cookieValue = () => hdr.jar.get(DISPLAY_COOKIE)?.value;

describe.skipIf(!RUN)("TV-2d · pairDisplay", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
  });
  afterAll(async () => {
    over.values = {};
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    over.values = { UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined };
    __rateLimitInternals.reset();
    hdr.jar.clear();
    hdr.ip = "203.0.113.10";
  });

  it("[TV-2d] código válido: vincula, borra el código, cookie httpOnly/Strict/path /tv/180 d y audit sin actor", async () => {
    const id = await newDisplay(db, A);
    const code = await issueCode(db, id);
    const before = await db.receptionDisplay.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });

    expect(await pairDisplay({ code: formatPairingCode(code).toLowerCase() })).toEqual({ ok: true, data: undefined });

    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id } });
    expect(row.pairingCodeHash).toBeNull();
    expect(row.pairingExpiresAt).toBeNull();
    expect(row.pairedAt).not.toBeNull();
    expect(row.lastSeenAt).not.toBeNull();
    // El vínculo es estado del dispositivo, no una edición del staff: no mueve el `updatedAt` del CAS del drawer.
    expect(row.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    const entry = hdr.jar.get(DISPLAY_COOKIE)!;
    expect(entry.opts).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/tv", maxAge: DISPLAY_COOKIE_MAX_AGE_S });
    expect(DISPLAY_COOKIE_MAX_AGE_S).toBe(180 * 24 * 3600);
    expect(entry.opts?.secure).toBe(process.env.NODE_ENV === "production");
    const c = parseDisplayCookie(entry.value)!;
    expect(c.id).toBe(id);
    expect(c.issuedDay).toBe(toARDateKey(new Date()));
    expect(row.deviceSecretHash).toBe(hashDeviceSecret(c.secret));

    const audit = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "display.paired", entityId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBeNull();
    expect(audit[0].entity).toBe("ReceptionDisplay");
    // El audit no guarda el código ni el secreto.
    expect(JSON.stringify(audit[0])).not.toContain(code);
    expect(JSON.stringify(audit[0])).not.toContain(c.secret);

    const s = await resolveDisplaySession();
    expect(s).toMatchObject({ state: "paired", displayId: id, tenantId: A.tenantId });
  });

  it("[TV-2d] código vencido → mensaje único y no vincula", async () => {
    const id = await newDisplay(db, A);
    const code = await issueCode(db, id, -1_000);
    expect(await pairDisplay({ code })).toEqual(FAIL);
    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id } });
    expect(row.deviceSecretHash).toBeNull();
    expect(row.pairedAt).toBeNull();
    expect(cookieValue()).toBeUndefined();
  });

  it("[TV-2d] código reusado → la segunda vez falla (un solo uso)", async () => {
    const id = await newDisplay(db, A);
    const code = await issueCode(db, id);
    expect((await pairDisplay({ code })).ok).toBe(true);
    const first = await db.receptionDisplay.findUniqueOrThrow({ where: { id }, select: { deviceSecretHash: true } });
    hdr.jar.clear();
    expect(await pairDisplay({ code })).toEqual(FAIL);
    expect(cookieValue()).toBeUndefined();
    const after = await db.receptionDisplay.findUniqueOrThrow({ where: { id }, select: { deviceSecretHash: true } });
    expect(after.deviceSecretHash).toBe(first.deviceSecretHash);
  });

  it("[TV-2d] dos TVs con el mismo código a la vez: gana una (CAS count===1)", async () => {
    const id = await newDisplay(db, A);
    const code = await issueCode(db, id);
    // Carrera REAL: se toma el lock de la fila y se lanzan 3 vínculos; todos pasan el `findFirst` (lectura sin lock)
    // y quedan bloqueados en el UPDATE. Sin esto, el primero terminaba antes de que los otros leyeran y el test pasaba
    // aunque se borrara el `count === 1` (medido: mutación verde).
    const pending = await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ReceptionDisplay" WHERE "id" = ${id} FOR UPDATE`;
        const p = Promise.all([pairDisplay({ code }), pairDisplay({ code }), pairDisplay({ code })]);
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [{ n }] = await db.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%UPDATE "ReceptionDisplay"%"deviceSecretHash"%'`;
          if (n >= 3) break;
          if (Date.now() > deadline) throw new Error(`solo ${n}/3 vínculos llegaron a bloquearse: la carrera no se probó`);
          await new Promise((r) => setTimeout(r, 25));
        }
        return { p };
      },
      { timeout: 20_000 }
    );
    const results = await pending.p;
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([FAIL, FAIL]);
    const audit = await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "display.paired", entityId: id } });
    expect(audit).toBe(1);
    // La cookie que quedó es la del ganador: su secreto es el que guardó la base.
    const c = parseDisplayCookie(cookieValue())!;
    const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id }, select: { deviceSecretHash: true } });
    expect(row.deviceSecretHash).toBe(hashDeviceSecret(c.secret));
  });

  it("[TV-2d] re-vínculo rota el secreto: la cookie vieja deja de andar", async () => {
    const id = await newDisplay(db, A);
    expect((await pairDisplay({ code: await issueCode(db, id) })).ok).toBe(true);
    const oldCookie = cookieValue()!;
    expect((await resolveDisplaySession()).state).toBe("paired");

    // El staff regenera el código (mover la pantalla a otra TV) y la TV nueva lo tipea.
    hdr.jar.clear();
    expect((await pairDisplay({ code: await issueCode(db, id) })).ok).toBe(true);
    const newCookie = cookieValue()!;
    expect(parseDisplayCookie(newCookie)!.secret).not.toBe(parseDisplayCookie(oldCookie)!.secret);
    expect((await resolveDisplaySession()).state).toBe("paired");

    hdr.jar.set(DISPLAY_COOKIE, { value: oldCookie });
    expect((await resolveDisplaySession()).state).toBe("unpaired");
  });

  it("[TV-2d] el código de A nunca da B; la cookie con el id de B y el secreto de A no entra", async () => {
    const idA = await newDisplay(db, A);
    const idB = await newDisplay(db, B);
    const codeA = await issueCode(db, idA);
    const codeB = await issueCode(db, idB);

    expect((await pairDisplay({ code: codeA })).ok).toBe(true);
    const s = await resolveDisplaySession();
    expect(s).toMatchObject({ state: "paired", displayId: idA, tenantId: A.tenantId });
    const rowB = await db.receptionDisplay.findUniqueOrThrow({ where: { id: idB } });
    expect(rowB.deviceSecretHash).toBeNull();
    expect(rowB.pairingCodeHash).toBe(hashPairingCode(codeB));

    const c = parseDisplayCookie(cookieValue())!;
    hdr.jar.set(DISPLAY_COOKIE, { value: `v1.${idB}.${c.secret}.${c.issuedDay}` });
    expect((await resolveDisplaySession()).state).toBe("unpaired");
  });

  it("[TV-2d] consultorio suspendido o módulo revocado (M12) → no vincula y el código sigue vivo", async () => {
    const S = await createEphemeralTenant(db, { saasPlan: "CLINICA", status: "SUSPENDED" });
    const R = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    const I = await createEphemeralTenant(db, { saasPlan: "INDIVIDUAL" });
    try {
      await db.tenant.update({ where: { id: R.tenantId }, data: { moduleRevokes: ["salaEspera"] } });
      for (const t of [S, R, I]) {
        const id = await newDisplay(db, t);
        await issueCode(db, id);
        const code = await issueCode(db, id);
        expect(await pairDisplay({ code })).toEqual(FAIL);
        const row = await db.receptionDisplay.findUniqueOrThrow({ where: { id } });
        expect(row.deviceSecretHash).toBeNull();
        expect(row.pairingCodeHash).toBe(hashPairingCode(code));
      }
      expect(cookieValue()).toBeUndefined();
    } finally {
      await S.cleanup();
      await R.cleanup();
      await I.cleanup();
    }
  });

  it("[TV-2d] grant de Plataforma (M12) en INDIVIDUAL → vincula", async () => {
    const G = await createEphemeralTenant(db, { saasPlan: "INDIVIDUAL" });
    try {
      await db.tenant.update({ where: { id: G.tenantId }, data: { moduleGrants: ["salaEspera"] } });
      const id = await newDisplay(db, G);
      expect((await pairDisplay({ code: await issueCode(db, id) })).ok).toBe(true);
    } finally {
      await G.cleanup();
    }
  });

  it("[TV-2d] entrada basura → mensaje único (sin tirar)", async () => {
    for (const code of ["", "ABC", "UUUUUUUU", "x".repeat(32), "ABCD-EFGH-IJKL"]) {
      expect(await pairDisplay({ code })).toEqual(FAIL);
    }
    expect(await pairDisplay({ code: "y".repeat(33) })).toEqual(FAIL);
    expect(await pairDisplay(null as never)).toEqual(FAIL);
    expect(await pairDisplay({ code: 12345678 } as never)).toEqual(FAIL);
  });

  it("[TV-2d] rate limit por IP: 10 cada 10 min (el 11.º, aun con código válido, falla); otra IP sigue", async () => {
    const id = await newDisplay(db, A);
    const code = await issueCode(db, id);
    for (let i = 0; i < 10; i++) expect(await pairDisplay({ code: "ZZZZZZZZ" })).toEqual(FAIL);
    expect(await pairDisplay({ code })).toEqual(FAIL);
    expect((await db.receptionDisplay.findUniqueOrThrow({ where: { id } })).deviceSecretHash).toBeNull();

    hdr.ip = "203.0.113.99";
    expect((await pairDisplay({ code })).ok).toBe(true);
  });
});
