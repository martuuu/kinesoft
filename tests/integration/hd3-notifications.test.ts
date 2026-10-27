/**
 * PV-W1a (HD-3) · entradas de las actions de notificaciones y recordatorios.
 *
 * `lib/notifications.ts` es un `"use server"`: cada export es un endpoint RPC que recibe lo que el cliente mande,
 * no lo que tipa TypeScript. Antes:
 *  - `dismissReminder({ key, hours })` guardaba cualquier `key` (un string de MB entraba en `reminderKey`) y
 *    `hours` sin tope (`hours: 1e9` → `dismissedUntil` en el año 100.000+, o Invalid Date y un 500 de Prisma);
 *  - `restoreReminder(key)` igual con la key;
 *  - `listNotifications(limit)` pasaba `limit` derecho al `take` (`10_000` → todas las filas del usuario).
 * Ahora: key 1..100, hours entero 1..720 (30 días; la UI usa 24 × 7) y limit entero 1..50 (la campana pide 20).
 * Entrada inválida → `{ ok: false }` / sin filas, y nada escrito.
 *
 * `getActor()` real; los dos modos (kinesoft_app con RLS y owner BYPASSRLS).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { dismissReminder, listNotifications, restoreReminder } from "@/lib/notifications";
import {
  ownerClient,
  createEphemeralTenant,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("HD-3 · notificaciones y recordatorios validan la entrada", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  const reminders = () => db.dismissedReminder.findMany({ where: { tenantId: A.tenantId, userId: A.userId } });

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    // 60 notificaciones: más que el tope (50) para que un `take` sin validar se note.
    await db.notification.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        tenantId: A.tenantId,
        userId: A.userId,
        kind: "BOOKING_CREATED" as const,
        title: `Aviso ${i}`,
        createdAt: new Date(Date.UTC(2027, 0, 1, 12, i)),
      })),
    });
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("[HD-3] dismissReminder: key de 101 caracteres → rechazo sin fila", async () => {
    asUser(A.userId);
    const res = await dismissReminder({ key: "k".repeat(101) });
    expect(res.ok).toBe(false);
    expect(await reminders()).toEqual([]);
  });

  it("[HD-3] dismissReminder: key vacía o no-string → rechazo sin fila", async () => {
    asUser(A.userId);
    expect((await dismissReminder({ key: "" })).ok).toBe(false);
    expect((await dismissReminder({ key: 42 as unknown as string })).ok).toBe(false);
    expect((await dismissReminder(null as unknown as { key: string })).ok).toBe(false);
    expect(await reminders()).toEqual([]);
  });

  it("[HD-3] dismissReminder: hours 0, 721 y 7.5 → rechazo sin fila", async () => {
    asUser(A.userId);
    for (const hours of [0, 721, 7.5, -1, Number.NaN, 1e9]) {
      const res = await dismissReminder({ key: "near-discharge:2027-W01", hours });
      expect(res.ok, `hours=${hours}`).toBe(false);
    }
    expect(await reminders()).toEqual([]);
  });

  it("[HD-3] dismissReminder: control válido (key de 100, hours 720 y el default 24) escribe", async () => {
    asUser(A.userId);
    const before = Date.now();
    expect(await dismissReminder({ key: "k".repeat(100), hours: 720 })).toEqual({ ok: true, data: undefined });
    expect(await dismissReminder({ key: "near-discharge:2027-W02" })).toEqual({ ok: true, data: undefined });
    const rows = await reminders();
    expect(rows.map((r) => r.reminderKey).sort()).toEqual(["k".repeat(100), "near-discharge:2027-W02"].sort());
    const long = rows.find((r) => r.reminderKey === "k".repeat(100))!;
    const def = rows.find((r) => r.reminderKey === "near-discharge:2027-W02")!;
    expect(long.dismissedUntil.getTime() - before).toBeGreaterThanOrEqual(720 * 3_600_000 - 5_000);
    expect(long.dismissedUntil.getTime() - before).toBeLessThanOrEqual(720 * 3_600_000 + 60_000);
    expect(def.dismissedUntil.getTime() - before).toBeLessThanOrEqual(24 * 3_600_000 + 60_000);
  });

  it("[HD-3] restoreReminder: key de 101 o vacía → rechazo sin borrar; control válido borra", async () => {
    asUser(A.userId);
    // 101 caracteres: no matchea ninguna fila (100 es el tope), pero igual tiene que rechazarse ANTES de la tx.
    expect((await restoreReminder("k".repeat(101))).ok).toBe(false);
    expect((await restoreReminder("")).ok).toBe(false);
    expect((await restoreReminder({ not: "a string" } as unknown as string)).ok).toBe(false);
    expect(await reminders()).toHaveLength(2);
    expect(await restoreReminder("k".repeat(100))).toEqual({ ok: true, data: undefined });
    expect((await reminders()).map((r) => r.reminderKey)).toEqual(["near-discharge:2027-W02"]);
  });

  it("[HD-3] listNotifications(10_000) no devuelve más de 50 (rechazo → sin filas)", async () => {
    asUser(A.userId);
    const big = await listNotifications(10_000);
    expect(big.rows.length).toBeLessThanOrEqual(50);
    expect(big.rows).toEqual([]);
    for (const limit of [0, -1, 2.5, 51, Number.NaN, "20" as unknown as number]) {
      expect((await listNotifications(limit)).rows, `limit=${String(limit)}`).toEqual([]);
    }
  });

  it("[HD-3] listNotifications: control válido (50, default 20) devuelve filas y el contador", async () => {
    asUser(A.userId);
    const max = await listNotifications(50);
    expect(max.rows).toHaveLength(50);
    expect(max.unread).toBe(60);
    // Más reciente primero.
    expect(max.rows[0].title).toBe("Aviso 59");
    const def = await listNotifications();
    expect(def.rows).toHaveLength(20);
  });
});
