/**
 * TV-2d (T7, §26.4 C-TV «Sesión y feed del dispositivo») · sesión de la TV, feed, `lastSeenAt` y token realtime contra
 * Postgres real, en los dos roles (`test:integration` = kinesoft_app, `:owner` = BYPASSRLS como prod).
 *
 * El dispositivo no tiene Actor: todo va por `prismaService` con `id` + `tenantId` a mano, así que el aislamiento que
 * se prueba es el del código (en prod la conexión salta RLS). Se mockea SOLO `next/headers` (cookie + IP) y el ENV
 * (Upstash apagado, driver/secreto de realtime de TEST). Nunca la función bajo test.
 *
 * Qué se fija:
 *   - estados de la sesión: sin cookie / basura / secreto ajeno → unpaired; revocada → revoked; consultorio
 *     suspendido o módulo revocado (M12) → unavailable; grant de Plataforma en INDIVIDUAL → paired;
 *   - el día AR en TZ=UTC: un turno de las 23:30 AR (02:30Z del día siguiente) entra; uno de las 00:30 AR del día
 *     siguiente (mismo día UTC) no;
 *   - filtro de sede: la principal ve también los turnos sin sede; una secundaria solo los suyos; sin sede, todo;
 *   - PHI: el JSON no trae apellido, DNI, teléfono, servicio, notas ni ids;
 *   - `touchDisplaySeen` escribe a lo sumo una vez por minuto y no mueve `updatedAt`;
 *   - `getDisplayFeed`: rate limit por pantalla y renovación deslizante de la cookie;
 *   - `mintDisplayRealtimeToken`: claims verificables y que pasan `kinesoft_realtime_can_read` (M5) solo para su
 *     consultorio; denegado si la pantalla está revocada o el módulo apagado.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const hdr = vi.hoisted(() => ({
  ip: "198.51.100.7",
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

import { getDisplayFeed } from "@/lib/display-device";
import { mintDisplayRealtimeToken } from "@/lib/realtime-display-token";
import {
  displayRealtimeBootstrap,
  loadDisplayFeed,
  resolveDisplaySession,
  touchDisplaySeen,
  type PairedDisplaySession,
} from "@/lib/display-device-internal";
import { hashDeviceSecret, makeDisplayCookie, newDeviceSecret, parseDisplayCookie } from "@/lib/display-pairing-internal";
import { verifyRealtimeToken } from "@/lib/realtime-token-internal";
import { topicFor } from "@/lib/realtime-constants";
import { DISPLAY_COOKIE, type DisplayFeed } from "@/lib/reception-displays-types";
import { toARDateKey } from "@/lib/datetime-ar";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { __resetMintDeniedLogForTests } from "@/lib/realtime-mint-log";
import { addPatient, addRoom, createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const SECRET = "integration-test-secret-tv-not-a-real-key-0123456789";
const BASE_ENV = {
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  REALTIME_DRIVER: "off",
  SUPABASE_JWT_SECRET: undefined,
  SUPABASE_JWT_KID: undefined,
  NEXT_PUBLIC_SUPABASE_URL: "https://example-test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
};
const SUPA = { REALTIME_DRIVER: "supabase", SUPABASE_JWT_SECRET: SECRET };

/** 2026-11-10 23:00 AR = 2026-11-11 02:00Z: el día UTC ya cambió, el AR no. */
const NOW = new Date("2026-11-11T02:00:00.000Z");
const ar = (local: string) => new Date(`${local}:00-03:00`);

type DisplayOpts = { locationId?: string | null; nameMode?: "SHORT_NAME" | "TURN_TIME"; revoked?: boolean };

/** Pantalla ya vinculada (como la deja `pairDisplay`) y su cookie. */
async function pairedDisplay(db: PrismaClient, t: EphemeralTenant, o: DisplayOpts = {}, issuedDay = toARDateKey(new Date())) {
  const secret = newDeviceSecret();
  const revoked = o.revoked ?? false;
  const d = await db.receptionDisplay.create({
    data: {
      tenantId: t.tenantId,
      name: `TV ${uniqueSuffix()}`,
      locationId: o.locationId ?? null,
      nameMode: o.nameMode,
      createdByUserId: t.userId,
      ...(revoked
        ? { revokedAt: new Date(), revokedByUserId: t.userId, pairedAt: new Date() }
        : { deviceSecretHash: hashDeviceSecret(secret), pairedAt: new Date() }),
    },
    select: { id: true },
  });
  return { id: d.id, cookie: makeDisplayCookie(d.id, secret, issuedDay) };
}

function useCookie(value: string | null) {
  hdr.jar.clear();
  if (value) hdr.jar.set(DISPLAY_COOKIE, { value });
}

async function session(cookie: string): Promise<PairedDisplaySession> {
  useCookie(cookie);
  const s = await resolveDisplaySession();
  if (s.state !== "paired") throw new Error(`sesión ${s.state}`);
  return s;
}

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe.skipIf(!RUN)("TV-2d · sesión del dispositivo", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
  });
  afterAll(async () => {
    over.values = {};
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    over.values = { ...BASE_ENV };
    __rateLimitInternals.reset();
    hdr.jar.clear();
  });

  it("[TV-2d] sin cookie, basura o secreto ajeno → unpaired; vinculada → paired con tenant de la fila", async () => {
    const { id, cookie } = await pairedDisplay(db, A);
    useCookie(null);
    expect(await resolveDisplaySession()).toEqual({ state: "unpaired" });
    useCookie("v2.cualquier.cosa.2026-01-01");
    expect(await resolveDisplaySession()).toEqual({ state: "unpaired" });
    const c = parseDisplayCookie(cookie)!;
    useCookie(makeDisplayCookie(id, newDeviceSecret(), c.issuedDay));
    expect(await resolveDisplaySession()).toEqual({ state: "unpaired" });
    useCookie(makeDisplayCookie(`nope${uniqueSuffix()}`, c.secret, c.issuedDay));
    expect(await resolveDisplaySession()).toEqual({ state: "unpaired" });

    useCookie(cookie);
    expect(await resolveDisplaySession()).toMatchObject({ state: "paired", displayId: id, tenantId: A.tenantId, locationId: null });
    expect(await getDisplayFeed()).toMatchObject({ ok: true });
  });

  it("[TV-2d] revocada → revoked (feed y token)", async () => {
    const { cookie } = await pairedDisplay(db, A, { revoked: true });
    useCookie(cookie);
    expect(await resolveDisplaySession()).toEqual({ state: "revoked" });
    expect(await getDisplayFeed()).toEqual({ ok: false, state: "revoked" });
    over.values = { ...BASE_ENV, ...SUPA };
    expect((await mintDisplayRealtimeToken()).ok).toBe(false);
  });

  it("[TV-2d] consultorio suspendido → unavailable; módulo revocado (M12) → unavailable; grant en INDIVIDUAL → paired", async () => {
    const S = await createEphemeralTenant(db, { saasPlan: "CLINICA", status: "SUSPENDED" });
    const R = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    const G = await createEphemeralTenant(db, { saasPlan: "INDIVIDUAL" });
    try {
      await db.tenant.update({ where: { id: R.tenantId }, data: { moduleRevokes: ["salaEspera"] } });
      await db.tenant.update({ where: { id: G.tenantId }, data: { moduleGrants: ["salaEspera"] } });
      over.values = { ...BASE_ENV, ...SUPA };
      for (const t of [S, R]) {
        const { cookie } = await pairedDisplay(db, t);
        useCookie(cookie);
        expect((await resolveDisplaySession()).state).toBe("unavailable");
        expect(await getDisplayFeed()).toEqual({ ok: false, state: "unavailable" });
        expect((await mintDisplayRealtimeToken()).ok).toBe(false);
      }
      const { cookie } = await pairedDisplay(db, G);
      useCookie(cookie);
      expect((await resolveDisplaySession()).state).toBe("paired");
    } finally {
      await S.cleanup();
      await R.cleanup();
      await G.cleanup();
    }
  });
});

describe.skipIf(!RUN)("TV-2d · loadDisplayFeed", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let primaryId: string;
  let secondaryId: string;
  let roomP: string;
  let roomS: string;
  const secrets: string[] = [];
  const ids: string[] = [];
  let practitionerName: string;

  async function booking(o: {
    at: Date;
    patientId?: string | null;
    guestName?: string;
    locationId?: string | null;
    roomId?: string | null;
    status?: "PENDING" | "CONFIRMED" | "CANCELLED" | "COMPLETED";
    arrivedAt?: Date | null;
    calledAt?: Date | null;
  }) {
    const b = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        patientId: o.patientId ?? null,
        guestName: o.guestName,
        guestPhone: o.guestName ? "1166667777" : undefined,
        scheduledFor: o.at,
        durationMin: 45,
        status: o.status ?? "CONFIRMED",
        idempotencyKey: randomUUID(),
        locationId: o.locationId ?? null,
        roomId: o.roomId ?? null,
        notes: "NotaSecretaTV",
        arrivedAt: o.arrivedAt === undefined ? new Date(o.at.getTime() - 10 * 60_000) : o.arrivedAt,
        calledAt: o.calledAt ?? null,
      },
      select: { id: true },
    });
    ids.push(b.id);
    return b.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    await db.service.update({ where: { id: A.serviceId }, data: { name: "ServicioSecretoTV" } });
    practitionerName = (await db.userProfile.findUniqueOrThrow({ where: { id: A.userId } })).fullName!;
    primaryId = (await db.location.create({ data: { tenantId: A.tenantId, name: "Sede Centro", isPrimary: true } })).id;
    secondaryId = (await db.location.create({ data: { tenantId: A.tenantId, name: "Sede Norte" } })).id;
    roomP = (await addRoom(db, A, { locationId: primaryId, name: "Box 3" })).roomId;
    roomS = (await addRoom(db, A, { locationId: secondaryId, name: "Box Norte" })).roomId;

    const maria = await addPatient(db, A, { firstName: "María", lastName: "Zapiola", documentId: "DNI-TV-777", phone: "1155554444" });
    const ana = await addPatient(db, A, { firstName: "Ana", lastName: "Lopezgarcía", documentId: "DNI-TV-888" });
    const lucia = await addPatient(db, A, { firstName: "Lucía", lastName: "Fernandezpaz", documentId: "DNI-TV-999" });
    const norte = await addPatient(db, A, { firstName: "Pedro", lastName: "Norteño" });
    const other = await addPatient(db, A, { firstName: "Otro", lastName: "Excluido" });
    ids.push(maria, ana, lucia, norte, other);

    await booking({ at: ar("2026-11-10T23:30"), patientId: maria, locationId: primaryId }); // 02:30Z del 11: entra
    await booking({ at: ar("2026-11-10T00:10"), patientId: ana, locationId: null }); // sin sede = principal
    await booking({ at: ar("2026-11-10T21:00"), guestName: "Juan Pérez", locationId: primaryId });
    await booking({
      at: ar("2026-11-10T22:30"),
      patientId: lucia,
      locationId: primaryId,
      roomId: roomP,
      calledAt: new Date(NOW.getTime() - 60_000),
    });
    await booking({
      at: ar("2026-11-10T22:00"),
      patientId: norte,
      locationId: secondaryId,
      roomId: roomS,
      calledAt: new Date(NOW.getTime() - 120_000),
    });
    // Fuera: mañana AR (mismo día UTC que el de las 23:30), ayer AR, cancelado, sin llegada.
    await booking({ at: ar("2026-11-11T00:30"), patientId: other, locationId: primaryId });
    await booking({ at: ar("2026-11-09T23:30"), patientId: other, locationId: primaryId });
    await booking({ at: ar("2026-11-10T20:00"), patientId: other, locationId: primaryId, status: "CANCELLED" });
    await booking({ at: ar("2026-11-10T19:00"), patientId: other, locationId: primaryId, arrivedAt: null });
  });
  afterAll(async () => {
    over.values = {};
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    over.values = { ...BASE_ENV };
    __rateLimitInternals.reset();
    hdr.jar.clear();
  });

  function assertNoPhi(feed: DisplayFeed, displayId: string) {
    const json = JSON.stringify(feed);
    for (const bad of [
      "Zapiola",
      "Lopezgarcía",
      "Fernandezpaz",
      "Norteño",
      "Pérez",
      "DNI-TV",
      "1155554444",
      "1166667777",
      "ServicioSecretoTV",
      "NotaSecretaTV",
      A.tenantId,
      A.practitionerId,
      A.serviceId,
      primaryId,
      secondaryId,
      roomP,
      roomS,
      displayId,
      ...ids,
      ...secrets,
    ]) {
      expect(json, `el feed filtró «${bad}»`).not.toContain(bad);
    }
  }

  it("[TV-2d] sede principal: sus turnos + los sin sede, día AR en TZ=UTC (23:30 entra, 00:30 de mañana no)", async () => {
    const { id, cookie } = await pairedDisplay(db, A, { locationId: primaryId });
    const s = await session(cookie);
    expect(s.isPrimaryLocation).toBe(true);
    const feed = await loadDisplayFeed(s, NOW);
    expect(feed.dayKey).toBe("2026-11-10");
    expect(feed.locationName).toBe("Sede Centro");
    expect(feed.hero).toMatchObject({ label: "Lucía F.", room: "Box 3", practitioner: practitionerName });
    expect(labels(feed.waiting)).toEqual(["Ana L.", "Juan P.", "María Z."]);
    expect(feed.waitingCount).toBe(3);
    expect(labels(feed.recent)).toEqual([]); // el llamado de la sede Norte no se ve acá
    assertNoPhi(feed, id);
  });

  it("[TV-2d] sede secundaria: solo sus turnos (los sin sede son de la principal)", async () => {
    const { id, cookie } = await pairedDisplay(db, A, { locationId: secondaryId });
    const s = await session(cookie);
    expect(s.isPrimaryLocation).toBe(false);
    const feed = await loadDisplayFeed(s, NOW);
    expect(feed.locationName).toBe("Sede Norte");
    expect(feed.hero).toMatchObject({ label: "Pedro N.", room: "Box Norte" });
    expect(feed.waiting).toEqual([]);
    expect(feed.waitingCount).toBe(0);
    assertNoPhi(feed, id);
  });

  it("[TV-2d] sin sede elegida: todo el consultorio; el otro tenant no ve nada de A", async () => {
    const { id, cookie } = await pairedDisplay(db, A);
    const feed = await loadDisplayFeed(await session(cookie), NOW);
    expect(feed.locationName).toBeNull();
    expect(feed.hero?.label).toBe("Lucía F.");
    expect(labels(feed.recent)).toEqual(["Pedro N."]);
    expect(feed.waitingCount).toBe(3);
    assertNoPhi(feed, id);

    const b = await pairedDisplay(db, B);
    const fb = await loadDisplayFeed(await session(b.cookie), NOW);
    expect(fb.hero).toBeNull();
    expect(fb.waitingCount).toBe(0);
    expect(fb.clinicName).not.toBe(feed.clinicName);
  });

  it("[TV-2d] modo «Hora del turno»: la hora es la AR (TZ=UTC) y no sale ningún nombre", async () => {
    const { id, cookie } = await pairedDisplay(db, A, { locationId: primaryId, nameMode: "TURN_TIME" });
    const feed = await loadDisplayFeed(await session(cookie), NOW);
    expect(labels(feed.waiting)).toEqual(["Turno de las 00:10", "Turno de las 21:00", "Turno de las 23:30"]);
    const json = JSON.stringify(feed);
    for (const n of ["María", "Ana", "Juan", "Lucía"]) expect(json).not.toContain(n);
    assertNoPhi(feed, id);
  });

  it("[TV-2d] touchDisplaySeen: a lo sumo una escritura por minuto y sin mover updatedAt", async () => {
    const { id, cookie } = await pairedDisplay(db, A);
    await db.receptionDisplay.update({ where: { id }, data: { lastSeenAt: null } });
    const before = await db.receptionDisplay.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    const s = await session(cookie);
    const t0 = new Date();
    expect(await touchDisplaySeen(s, t0)).toBe(true);
    expect(await touchDisplaySeen(s, new Date(t0.getTime() + 30_000))).toBe(false);
    let row = await db.receptionDisplay.findUniqueOrThrow({ where: { id } });
    expect(row.lastSeenAt?.getTime()).toBe(t0.getTime());
    const t1 = new Date(t0.getTime() + 61_000);
    expect(await touchDisplaySeen(s, t1)).toBe(true);
    row = await db.receptionDisplay.findUniqueOrThrow({ where: { id } });
    expect(row.lastSeenAt?.getTime()).toBe(t1.getTime());
    expect(row.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("[TV-2d] getDisplayFeed: 30 por minuto por pantalla y toca lastSeenAt", async () => {
    const { id, cookie } = await pairedDisplay(db, A);
    useCookie(cookie);
    const r = await getDisplayFeed();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feed.dayKey).toBe(toARDateKey(new Date()));
    expect((await db.receptionDisplay.findUniqueOrThrow({ where: { id } })).lastSeenAt).not.toBeNull();
    for (let i = 0; i < 29; i++) expect((await getDisplayFeed()).ok).toBe(true);
    expect(await getDisplayFeed()).toEqual({ ok: false, state: "rate_limited" });
    // Otra pantalla desde la misma IP sigue (el tope por IP es 240).
    const other = await pairedDisplay(db, A);
    useCookie(other.cookie);
    expect((await getDisplayFeed()).ok).toBe(true);
  });

  it("[TV-2d] renovación deslizante: cookie de hace 40 días se re-emite con el día de hoy; una de hace 5, no", async () => {
    const day = (n: number) => toARDateKey(new Date(Date.now() - n * 86_400_000));
    const old = await pairedDisplay(db, A, {}, day(40));
    useCookie(old.cookie);
    expect((await getDisplayFeed()).ok).toBe(true);
    const renewed = hdr.jar.get(DISPLAY_COOKIE)!;
    expect(parseDisplayCookie(renewed.value)).toEqual({ ...parseDisplayCookie(old.cookie)!, issuedDay: toARDateKey(new Date()) });
    expect(renewed.opts).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/tv" });

    const fresh = await pairedDisplay(db, A, {}, day(5));
    useCookie(fresh.cookie);
    expect((await getDisplayFeed()).ok).toBe(true);
    expect(hdr.jar.get(DISPLAY_COOKIE)).toEqual({ value: fresh.cookie });
  });

  it("[TV-2d] token: claims verificables, mismo topic que el staff (M5) y solo para su consultorio", async () => {
    __resetMintDeniedLogForTests();
    const { cookie } = await pairedDisplay(db, A);
    useCookie(cookie);
    expect(await mintDisplayRealtimeToken()).toEqual({ ok: false, error: "realtime-off" });
    over.values = { ...BASE_ENV, ...SUPA };
    const r = await mintDisplayRealtimeToken();
    if (!r.ok) throw new Error(r.error);
    secrets.push(r.data.token);
    const claims = verifyRealtimeToken(r.data.token, SECRET);
    expect(claims?.tenant_id).toBe(A.tenantId);
    expect(new Date(r.data.expiresAt).getTime()).toBe(claims!.exp * 1000);
    const can = async (topic: string) => {
      const rows = await db.$queryRawUnsafe<{ ok: boolean | null }[]>(
        "select public.kinesoft_realtime_can_read($1, $2::jsonb) as ok",
        topic,
        JSON.stringify(claims)
      );
      return rows[0].ok;
    };
    expect(await can(topicFor(A.tenantId))).toBe(true);
    expect(await can(topicFor(B.tenantId))).toBe(false);

    useCookie(null);
    expect((await mintDisplayRealtimeToken()).ok).toBe(false);
  });

  it("[TV-2d] displayRealtimeBootstrap: local → off (solo polling), supabase sin secreto → off, con secreto → supabase", async () => {
    over.values = { ...BASE_ENV, REALTIME_DRIVER: "local" };
    expect(await displayRealtimeBootstrap(A.tenantId)).toEqual({ driver: "off", tenantId: A.tenantId });
    over.values = { ...BASE_ENV, REALTIME_DRIVER: "supabase" };
    expect(await displayRealtimeBootstrap(A.tenantId)).toEqual({ driver: "off", tenantId: A.tenantId });
    over.values = { ...BASE_ENV, ...SUPA };
    expect(await displayRealtimeBootstrap(A.tenantId)).toEqual({
      driver: "supabase",
      tenantId: A.tenantId,
      url: BASE_ENV.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: BASE_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });
  });
});
