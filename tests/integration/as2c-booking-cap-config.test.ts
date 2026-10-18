/**
 * [AS-2c] Configuración del tope de turnos por intervalo (C-AS3, decisión 6 del 19-oct; plan §23.7), contra Postgres
 * en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS).
 *
 * Símbolos REALES: `setTenantBookingCap` (lib/tenant-settings.ts), `setPractitionerBookingCap`
 * (lib/practitioner-schedule.ts) y `loadConfiguracionPage`. Se mockea solo la cookie de sesión (`asUser`).
 *
 * `withSupportWritable` tira con un nombre fuera de `SUPPORT_WRITABLE_ACTIONS` (lib/support-writable.ts, de otra
 * sesión). Hasta que el integrador sume los dos nombres (handoff de T3e-2c), el mock deja pasar SOLO esos dos y para
 * todo lo demás llama al real; con el handoff aplicado, el real los acepta y el mock no cambia nada.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/support-writable", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/support-writable")>();
  const PENDING = new Set([
    "lib/tenant-settings.ts#setTenantBookingCap",
    "lib/practitioner-schedule.ts#setPractitionerBookingCap",
  ]);
  return {
    ...real,
    withSupportWritable: <T,>(name: string, fn: () => Promise<T>) =>
      PENDING.has(name) && !real.SUPPORT_WRITABLE_ACTIONS.has(name) ? fn() : real.withSupportWritable(name, fn),
  };
});

import { ForbiddenError, getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { setTenantBookingCap } from "@/lib/tenant-settings";
import { setPractitionerBookingCap } from "@/lib/practitioner-schedule";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import { BOOKING_CAP_COPY } from "@/lib/booking-cap-config";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[AS-2c] setters del tope por intervalo", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let secWith: string;
  let secWithout: string;
  let kine: { userId: string; practitionerId: string };
  let suspended: { userId: string; practitionerId: string };

  const tenantCap = () =>
    db.tenant.findUniqueOrThrow({
      where: { id: A.tenantId },
      select: { bookingCapCount: true, bookingCapIntervalMin: true },
    });
  const pracCap = (id: string) =>
    db.practitioner.findUniqueOrThrow({
      where: { id },
      select: { bookingCapMode: true, bookingCapCount: true, bookingCapIntervalMin: true },
    });
  const audits = (action: string, entityId: string) =>
    db.auditEvent.findMany({ where: { tenantId: A.tenantId, action, entityId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    secWith = (await addStaff(db, A, "ASSISTANT", { grantSettings: true })).userId;
    secWithout = (await addStaff(db, A, "ASSISTANT")).userId;
    kine = await addPractitioner(db, A);
    suspended = await addPractitioner(db, A);
    await db.membership.update({
      where: { userId_tenantId: { userId: suspended.userId, tenantId: A.tenantId } },
      data: { disabledAt: new Date() },
    });
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    asUser(A.userId);
    await db.tenant.update({ where: { id: A.tenantId }, data: { bookingCapCount: null, bookingCapIntervalMin: null } });
    await db.practitioner.update({
      where: { id: kine.practitionerId },
      data: { bookingCapMode: "INHERIT", bookingCapCount: null, bookingCapIntervalMin: null },
    });
  });

  // ── Consultorio ─────────────────────────────────────────────────────────────

  it("[AS-2c] el titular pone «2 cada 15 min»: se guarda y se audita en la misma tx (con el antes y el después)", async () => {
    const r = await setTenantBookingCap({ count: 2, intervalMin: 15 });
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await tenantCap()).toEqual({ bookingCapCount: 2, bookingCapIntervalMin: 15 });
    const ev = await audits("tenant.booking_cap", A.tenantId);
    expect(ev.at(-1)?.payload).toEqual({ from: null, to: { count: 2, intervalMin: 15 } });
    expect(ev.at(-1)?.actorId).toBe(A.userId);
  });

  it("[AS-2c] el mismo valor otra vez no escribe audit; vaciar los dos = sin tope", async () => {
    await setTenantBookingCap({ count: 3, intervalMin: 30 });
    const n = (await audits("tenant.booking_cap", A.tenantId)).length;
    expect((await setTenantBookingCap({ count: 3, intervalMin: 30 })).ok).toBe(true);
    expect(await audits("tenant.booking_cap", A.tenantId)).toHaveLength(n);
    expect((await setTenantBookingCap({ count: null, intervalMin: null })).ok).toBe(true);
    expect(await tenantCap()).toEqual({ bookingCapCount: null, bookingCapIntervalMin: null });
    expect((await audits("tenant.booking_cap", A.tenantId)).at(-1)?.payload).toEqual({
      from: { count: 3, intervalMin: 30 },
      to: null,
    });
  });

  it("[AS-2c] los dos o ninguno, 1..60 y 15/30/60: si no, error con copy y la fila no cambia", async () => {
    await setTenantBookingCap({ count: 2, intervalMin: 15 });
    expect(await setTenantBookingCap({ count: 2, intervalMin: null })).toEqual({ ok: false, error: BOOKING_CAP_COPY.pair });
    expect(await setTenantBookingCap({ count: null, intervalMin: 30 })).toEqual({ ok: false, error: BOOKING_CAP_COPY.pair });
    expect(await setTenantBookingCap({ count: 0, intervalMin: 15 })).toEqual({ ok: false, error: BOOKING_CAP_COPY.count });
    expect(await setTenantBookingCap({ count: 61, intervalMin: 15 })).toEqual({ ok: false, error: BOOKING_CAP_COPY.count });
    expect(await setTenantBookingCap({ count: 2, intervalMin: 45 })).toEqual({ ok: false, error: BOOKING_CAP_COPY.interval });
    expect(await tenantCap()).toEqual({ bookingCapCount: 2, bookingCapIntervalMin: 15 });
  });

  it("[AS-2c] la Secretaria con «Configuración» puede; sin «Configuración» (Secretaria o Profesional) no", async () => {
    asUser(secWith);
    expect((await setTenantBookingCap({ count: 4, intervalMin: 60 })).ok).toBe(true);
    expect(await tenantCap()).toEqual({ bookingCapCount: 4, bookingCapIntervalMin: 60 });
    expect((await audits("tenant.booking_cap", A.tenantId)).at(-1)?.actorId).toBe(secWith);

    asUser(secWithout);
    await expect(setTenantBookingCap({ count: 1, intervalMin: 15 })).rejects.toBeInstanceOf(ForbiddenError);
    asUser(kine.userId);
    await expect(setTenantBookingCap({ count: 1, intervalMin: 15 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await tenantCap()).toEqual({ bookingCapCount: 4, bookingCapIntervalMin: 60 });
  });

  // ── Profesional ─────────────────────────────────────────────────────────────

  it("[AS-2c] CUSTOM «3 cada 30»: se guarda y se audita; NONE e INHERIT limpian el par", async () => {
    const r = await setPractitionerBookingCap(kine.practitionerId, { mode: "CUSTOM", count: 3, intervalMin: 30 });
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await pracCap(kine.practitionerId)).toEqual({
      bookingCapMode: "CUSTOM",
      bookingCapCount: 3,
      bookingCapIntervalMin: 30,
    });
    expect((await audits("practitioner.booking_cap", kine.practitionerId)).at(-1)?.payload).toEqual({
      from: { mode: "INHERIT", count: null, intervalMin: null },
      to: { mode: "CUSTOM", count: 3, intervalMin: 30 },
    });

    // Números tipeados que quedaron en el form: se descartan (CHECK de M12: NULL fuera de CUSTOM).
    expect((await setPractitionerBookingCap(kine.practitionerId, { mode: "NONE", count: 3, intervalMin: 30 })).ok).toBe(true);
    expect(await pracCap(kine.practitionerId)).toEqual({ bookingCapMode: "NONE", bookingCapCount: null, bookingCapIntervalMin: null });

    expect((await setPractitionerBookingCap(kine.practitionerId, { mode: "INHERIT" })).ok).toBe(true);
    expect(await pracCap(kine.practitionerId)).toEqual({
      bookingCapMode: "INHERIT",
      bookingCapCount: null,
      bookingCapIntervalMin: null,
    });
  });

  it("[AS-2c] mismo modo y par = sin audit nuevo", async () => {
    await setPractitionerBookingCap(kine.practitionerId, { mode: "NONE" });
    const n = (await audits("practitioner.booking_cap", kine.practitionerId)).length;
    expect((await setPractitionerBookingCap(kine.practitionerId, { mode: "NONE" })).ok).toBe(true);
    expect(await audits("practitioner.booking_cap", kine.practitionerId)).toHaveLength(n);
  });

  it("[AS-2c] CUSTOM sin par o fuera de rango, o modo desconocido: error y la fila no cambia", async () => {
    expect(await setPractitionerBookingCap(kine.practitionerId, { mode: "CUSTOM" })).toEqual({
      ok: false,
      error: BOOKING_CAP_COPY.customPair,
    });
    expect(await setPractitionerBookingCap(kine.practitionerId, { mode: "CUSTOM", count: 2 })).toEqual({
      ok: false,
      error: BOOKING_CAP_COPY.pair,
    });
    expect(await setPractitionerBookingCap(kine.practitionerId, { mode: "CUSTOM", count: 2, intervalMin: 20 })).toEqual({
      ok: false,
      error: BOOKING_CAP_COPY.interval,
    });
    expect(
      await setPractitionerBookingCap(kine.practitionerId, { mode: "OTRO" as unknown as "NONE" })
    ).toEqual({ ok: false, error: BOOKING_CAP_COPY.mode });
    expect(await pracCap(kine.practitionerId)).toEqual({
      bookingCapMode: "INHERIT",
      bookingCapCount: null,
      bookingCapIntervalMin: null,
    });
  });

  it("[AS-2c] profesional de otro consultorio o suspendido = «Profesional no encontrado.» (sin escribir)", async () => {
    expect(await setPractitionerBookingCap(B.practitionerId, { mode: "NONE" })).toEqual({
      ok: false,
      error: "Profesional no encontrado.",
    });
    expect((await pracCap(B.practitionerId)).bookingCapMode).toBe("INHERIT");
    expect(await setPractitionerBookingCap(suspended.practitionerId, { mode: "NONE" })).toEqual({
      ok: false,
      error: "Profesional no encontrado.",
    });
    expect((await pracCap(suspended.practitionerId)).bookingCapMode).toBe("INHERIT");
  });

  it("[AS-2c] Secretaria con «Configuración» puede (`schedule.configure`); sin ella, no; el profesional tampoco", async () => {
    asUser(secWith);
    expect((await setPractitionerBookingCap(kine.practitionerId, { mode: "CUSTOM", count: 1, intervalMin: 60 })).ok).toBe(true);
    expect((await pracCap(kine.practitionerId)).bookingCapMode).toBe("CUSTOM");

    asUser(secWithout);
    await expect(setPractitionerBookingCap(kine.practitionerId, { mode: "NONE" })).rejects.toBeInstanceOf(ForbiddenError);
    // El propio profesional sin «Configuración» tampoco: el tope es de la agenda del consultorio, no una preferencia.
    asUser(kine.userId);
    await expect(setPractitionerBookingCap(kine.practitionerId, { mode: "NONE" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await pracCap(kine.practitionerId)).bookingCapMode).toBe("CUSTOM");
  });

  // ── Loader ──────────────────────────────────────────────────────────────────

  it("[AS-2c] el loader de Configuración expone el tope del consultorio y el de cada profesional", async () => {
    await setTenantBookingCap({ count: 2, intervalMin: 15 });
    await setPractitionerBookingCap(kine.practitionerId, { mode: "CUSTOM", count: 5, intervalMin: 60 });
    const actor = await getActor();
    const page = await loadConfiguracionPage(actor, await capabilitiesForActor(actor));
    expect(page.tenant).toMatchObject({ bookingCapCount: 2, bookingCapIntervalMin: 15 });
    const mine = page.scheduleSummary.find((s) => s.practitionerId === kine.practitionerId);
    expect(mine?.bookingCap).toEqual({ mode: "CUSTOM", count: 5, intervalMin: 60, tenant: { count: 2, intervalMin: 15 } });
    const owner = page.scheduleSummary.find((s) => s.practitionerId === A.practitionerId);
    expect(owner?.bookingCap).toEqual({ mode: "INHERIT", count: null, intervalMin: null, tenant: { count: 2, intervalMin: 15 } });
  });
});
