/**
 * [CF2-PS3] Reparto de % entre profesionales (CF2 · P.3, plan §29 D-CF2-18): las actions REALES de
 * `lib/revenue-share.ts` (`listRevenueShares`, `setRevenueShare`, `endRevenueShare`) contra Postgres, en los dos
 * roles (`test:integration` = `kinesoft_app` con RLS; `:owner` = BYPASSRLS, como prod). Se mockea solo la cookie de
 * sesión (`asUser`) y `next/cache` (integration-setup).
 *
 *   [CF2-PS3-1] gate `tenant.sensitive`: Secretaria y Facturación (aun con «Configuración») y un profesional sin la
 *               delegación no leen ni escriben; el Titular sí.
 *   [CF2-PS3-2] ids de otro consultorio (el que destina o el que recibe) → rechazo, nada escrito.
 *   [CF2-PS3-3] receptor suspendido → «Solo puede recibir un profesional activo del consultorio.».
 *   [CF2-PS3-4] a sí mismo (zod), mutuo y cadenas (los dos sentidos) rechazados con su copy.
 *   [CF2-PS3-5] cambiar = cerrar la vigente en `now` + insertar desde `now`: el historial queda intacto y contiguo;
 *               audit por cambio con ids/bps/fuentes; la lista trae nombres y receptores posibles.
 *   [CF2-PS3-6] «Dejar de destinar» con CAS: id viejo → conflicto; el vigente → cerrado, sin vigente.
 *   [CF2-PS3-7] carrera: el mismo profesional guardado dos veces en paralelo → gana exactamente una (la otra,
 *               «Cambió mientras lo editabas»), una sola vigente y un solo audit.
 *   [CF2-PS3-8] carrera A→B vs B→A → gana exactamente una; la otra cae por «mutuo» y no escribe nada.
 *   [CF2-PS3-9] un escritor que saltea el lock (fila vigente sin commitear) → el INSERT de la action choca con el
 *               único parcial (P2002) → conflicto, y la tx entera (audit incluido) se revierte.
 *   [CF2-PS3-10] el export del consultorio trae las reglas (vigentes y cerradas) y nada de otro consultorio.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { endRevenueShare, listRevenueShares, setRevenueShare } from "@/lib/revenue-share";
import { tenantExportChunks } from "@/lib/tenant-export-internal";
import { EXPORT_ENTITIES, type ExportEntity } from "@/lib/tenant-export-logic";
import { REVENUE_SHARE_COPY, SHARE_GRAPH_ERROR_COPY } from "@/lib/revenue-share-types";
import { asUser } from "@/tests/helpers/actor";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import {
  addPractitioner,
  addRevenueShare,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const ALL = { manual: true, online: true, insurer: true };
const lockKey = (tenantId: string) => `kinesoft:rshare:${tenantId}`;

describe.skipIf(!RUN)("[CF2-PS3] reparto: listRevenueShares / setRevenueShare / endRevenueShare", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let p1: { userId: string; practitionerId: string };
  let p2: { userId: string; practitionerId: string };
  let p3: { userId: string; practitionerId: string };
  let suspended: { userId: string; practitionerId: string };
  let secretaria: string;
  let facturacion: string;
  let t0: Date;

  const set = (giver: string, receiver: string, pct: string, expectedOpenId: string | null, sources = ALL) =>
    setRevenueShare({ giverPractitionerId: giver, receiverPractitionerId: receiver, sharePct: pct, sources, expectedOpenId });

  const rowsA = () =>
    db.practitionerRevenueShare.findMany({ where: { tenantId: A.tenantId }, orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }] });
  const auditsA = () =>
    db.auditEvent.findMany({
      where: { tenantId: A.tenantId, action: { startsWith: "revenueShare." }, createdAt: { gte: t0 } },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    p1 = await addPractitioner(db, A);
    p2 = await addPractitioner(db, A);
    p3 = await addPractitioner(db, A);
    suspended = await addPractitioner(db, A);
    await db.membership.updateMany({ where: { tenantId: A.tenantId, userId: suspended.userId }, data: { disabledAt: new Date() } });
    secretaria = (await addStaff(db, A, "ASSISTANT", { grantSettings: true })).userId;
    facturacion = (await addStaff(db, A, "BILLING", { grantSettings: true, grantBilling: true })).userId;
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.practitionerRevenueShare.deleteMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } });
    t0 = new Date(Date.now() - 1);
    asUser(A.userId);
  });

  it("[CF2-PS3-1] solo `tenant.sensitive`: Secretaria, Facturación y un profesional sin «Configuración» no leen ni escriben", async () => {
    const ruleId = await addRevenueShare(db, A, { giverPractitionerId: p1.practitionerId, receiverPractitionerId: p2.practitionerId, shareBps: 1000 });
    for (const who of [secretaria, facturacion, p1.userId]) {
      asUser(who);
      expect((await listRevenueShares()).ok, who).toBe(false);
      expect((await set(p3.practitionerId, p2.practitionerId, "10", null)).ok, who).toBe(false);
      expect((await endRevenueShare({ giverPractitionerId: p1.practitionerId, expectedOpenId: ruleId })).ok, who).toBe(false);
    }
    const rows = await rowsA();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ruleId, effectiveTo: null });
    expect(await auditsA()).toEqual([]);

    asUser(A.userId);
    const list = await listRevenueShares();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.rules.map((r) => r.id)).toEqual([ruleId]);
  });

  it("[CF2-PS3-2] ids de otro consultorio → rechazo, nada escrito", async () => {
    const fromB = await set(B.practitionerId, p2.practitionerId, "10", null);
    const toB = await set(p1.practitionerId, B.practitionerId, "10", null);
    expect(fromB.ok).toBe(false);
    expect(toB.ok).toBe(false);
    if (!toB.ok) expect(toB.error).toBe(REVENUE_SHARE_COPY.receiverNotBookable);
    // Cerrar la regla de OTRO consultorio con su id real: no la encuentra (CAS contra las vigentes de A).
    const ruleB = await addRevenueShare(db, B, { giverPractitionerId: B.practitionerId, receiverPractitionerId: (await addPractitioner(db, B)).practitionerId, shareBps: 500 });
    const endB = await endRevenueShare({ giverPractitionerId: B.practitionerId, expectedOpenId: ruleB });
    expect(endB.ok).toBe(false);
    expect(await db.practitionerRevenueShare.findUnique({ where: { id: ruleB } })).toMatchObject({ effectiveTo: null, closedById: null });
    expect(await rowsA()).toEqual([]);
    expect(await auditsA()).toEqual([]);
  });

  it("[CF2-PS3-3] receptor suspendido → solo recibe un profesional activo", async () => {
    const r = await set(p1.practitionerId, suspended.practitionerId, "10", null);
    expect(r).toEqual({ ok: false, error: REVENUE_SHARE_COPY.receiverNotBookable });
    expect(await rowsA()).toEqual([]);
    // Y no aparece entre los receptores posibles.
    const list = await listRevenueShares();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = list.data.receivers.map((x) => x.practitionerId);
    expect(ids).toEqual(expect.arrayContaining([A.practitionerId, p1.practitionerId, p2.practitionerId, p3.practitionerId]));
    expect(ids).not.toContain(suspended.practitionerId);
    expect(ids).not.toContain(B.practitionerId);
  });

  it("[CF2-PS3-4] a sí mismo, mutuo y cadenas rechazados con su copy", async () => {
    const self = await set(p1.practitionerId, p1.practitionerId, "10", null);
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.fieldErrors?.receiverPractitionerId).toEqual([SHARE_GRAPH_ERROR_COPY.self]);

    const r12 = await addRevenueShare(db, A, { giverPractitionerId: p1.practitionerId, receiverPractitionerId: p2.practitionerId, shareBps: 1000 });
    // p2 → p1: mutuo.
    expect(await set(p2.practitionerId, p1.practitionerId, "10", null)).toEqual({ ok: false, error: SHARE_GRAPH_ERROR_COPY.mutual });
    // p3 → p1: p1 ya destina (receiverGives).
    expect(await set(p3.practitionerId, p1.practitionerId, "10", null)).toEqual({ ok: false, error: SHARE_GRAPH_ERROR_COPY.receiverGives });
    // p2 → p3: p2 ya recibe (giverReceives).
    expect(await set(p2.practitionerId, p3.practitionerId, "10", null)).toEqual({ ok: false, error: SHARE_GRAPH_ERROR_COPY.giverReceives });
    // % y fuentes inválidos: zod, con su campo.
    const badPct = await set(p3.practitionerId, p2.practitionerId, "0", null);
    expect(badPct.ok).toBe(false);
    if (!badPct.ok) expect(badPct.fieldErrors?.sharePct).toEqual([REVENUE_SHARE_COPY.invalidPct]);
    const noSrc = await set(p3.practitionerId, p2.practitionerId, "10", null, { manual: false, online: false, insurer: false });
    expect(noSrc.ok).toBe(false);

    const rows = await rowsA();
    expect(rows.map((r) => r.id)).toEqual([r12]);
    expect(await auditsA()).toEqual([]);
  });

  it("[CF2-PS3-5] cambiar = cerrar en `now` + abrir desde `now`; historial intacto y audit con ids/bps/fuentes", async () => {
    const first = await set(p1.practitionerId, p2.practitionerId, "12,5", null, { manual: true, online: false, insurer: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await set(p1.practitionerId, p3.practitionerId, "20", first.data.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const rows = await rowsA();
    expect(rows).toHaveLength(2);
    const [old, cur] = rows;
    expect(old).toMatchObject({
      id: first.data.id,
      giverPractitionerId: p1.practitionerId,
      receiverPractitionerId: p2.practitionerId,
      shareBps: 1250,
      appliesManual: true,
      appliesOnline: false,
      appliesInsurer: true,
      createdById: A.userId,
      closedById: A.userId,
    });
    expect(cur).toMatchObject({
      id: second.data.id,
      receiverPractitionerId: p3.practitionerId,
      shareBps: 2000,
      appliesOnline: true,
      effectiveTo: null,
      closedById: null,
      createdById: A.userId,
    });
    // Contiguas: la vieja termina exactamente donde empieza la nueva (la caja usa [from, to): sin hueco ni solape).
    expect(old.effectiveTo?.getTime()).toBe(cur.effectiveFrom.getTime());

    const audits = await auditsA();
    expect(audits.map((a) => a.action)).toEqual(["revenueShare.set", "revenueShare.set"]);
    expect(audits[1]).toMatchObject({ actorId: A.userId, entity: "PractitionerRevenueShare", entityId: second.data.id });
    expect(audits[1].payload).toMatchObject({
      giverPractitionerId: p1.practitionerId,
      receiverPractitionerId: p3.practitionerId,
      shareBps: 2000,
      sources: ALL,
      closedRuleId: first.data.id,
    });
    expect(audits[0].payload).toMatchObject({ shareBps: 1250, sources: { manual: true, online: false, insurer: true }, closedRuleId: null });

    // La lista: vigente + historial (effectiveFrom desc) con nombres; nunca el email.
    const list = await listRevenueShares();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.rules.map((r) => r.id)).toEqual([second.data.id, first.data.id]);
    const v = list.data.rules[0];
    expect(v).toMatchObject({ giverPractitionerId: p1.practitionerId, shareBps: 2000, effectiveTo: null, sources: ALL });
    expect(v.giverName).toMatch(/^Kine /);
    expect(v.createdByName).toBeTruthy();
    expect(list.data.rules[1].effectiveTo).toBe(old.effectiveTo?.toISOString());
    expect(list.data.rules[1].closedByName).toBeTruthy();
    expect(JSON.stringify(list.data)).not.toContain("@test.local");

    // Guardar lo mismo que ya rige: no abre otra regla (sin ruido en el historial).
    const same = await set(p1.practitionerId, p3.practitionerId, "20", second.data.id);
    expect(same).toEqual({ ok: true, data: { id: second.data.id } });
    expect(await rowsA()).toHaveLength(2);
  });

  it("[CF2-PS3-6] «Dejar de destinar» con CAS: id viejo → conflicto; el vigente → cerrado", async () => {
    const a = await set(p1.practitionerId, p2.practitionerId, "10", null);
    if (!a.ok) throw new Error(a.error);
    const b = await set(p1.practitionerId, p2.practitionerId, "15", a.data.id);
    if (!b.ok) throw new Error(b.error);
    // Otra pestaña vio la regla `a` (ya cerrada).
    expect(await endRevenueShare({ giverPractitionerId: p1.practitionerId, expectedOpenId: a.data.id })).toEqual({ ok: false, error: REVENUE_SHARE_COPY.conflict });
    // Guardar con el id viejo también es conflicto.
    expect(await set(p1.practitionerId, p3.practitionerId, "10", a.data.id)).toEqual({ ok: false, error: REVENUE_SHARE_COPY.conflict });
    expect(await set(p1.practitionerId, p3.practitionerId, "10", null)).toEqual({ ok: false, error: REVENUE_SHARE_COPY.conflict });

    expect(await endRevenueShare({ giverPractitionerId: p1.practitionerId, expectedOpenId: b.data.id })).toEqual({ ok: true, data: null });
    const rows = await rowsA();
    expect(rows.every((r) => r.effectiveTo !== null)).toBe(true);
    expect(rows.find((r) => r.id === b.data.id)).toMatchObject({ closedById: A.userId });
    // Sin vigente: cerrar de nuevo → no hay regla vigente (conflicto: lo que vio el editor ya no rige).
    expect((await endRevenueShare({ giverPractitionerId: p1.practitionerId, expectedOpenId: b.data.id })).ok).toBe(false);
    const audits = await auditsA();
    expect(audits.map((x) => x.action)).toEqual(["revenueShare.set", "revenueShare.set", "revenueShare.end"]);
    expect(audits[2]).toMatchObject({ entityId: b.data.id });
    expect(audits[2].payload).toMatchObject({ giverPractitionerId: p1.practitionerId, receiverPractitionerId: p2.practitionerId, shareBps: 1500, sources: ALL });
  });

  /** Toma el lock de A desde el test, lanza `fns` y suelta recién cuando las dos esperan: contención real. */
  async function raceUnderLock<T>(fns: Array<() => Promise<T>>): Promise<T[]> {
    let pending: Promise<T[]> | null = null;
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(A.tenantId)}, 0))`;
        pending = Promise.all(fns.map((f) => f()));
        await waitForAdvisoryWaiter(db, lockKey(A.tenantId), { minWaiters: fns.length, timeoutMs: 10_000 });
      },
      { timeout: 20_000 }
    );
    return pending!;
  }

  it("[CF2-PS3-7] carrera: el mismo profesional dos veces en paralelo → gana exactamente una", async () => {
    const results = await raceUnderLock([
      () => set(p1.practitionerId, p2.practitionerId, "10", null),
      () => set(p1.practitionerId, p3.practitionerId, "30", null),
    ]);
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: REVENUE_SHARE_COPY.conflict }]);
    const rows = await rowsA();
    expect(rows).toHaveLength(1);
    expect(rows[0].effectiveTo).toBeNull();
    expect((await auditsA()).length).toBe(1);
  });

  it("[CF2-PS3-8] carrera A→B vs B→A → gana exactamente una; la otra cae por «mutuo»", async () => {
    const results = await raceUnderLock([
      () => set(p1.practitionerId, p2.practitionerId, "10", null),
      () => set(p2.practitionerId, p1.practitionerId, "10", null),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: SHARE_GRAPH_ERROR_COPY.mutual }]);
    expect(await rowsA()).toHaveLength(1);
    expect((await auditsA()).length).toBe(1);
  });

  it("[CF2-PS3-9] un escritor que saltea el lock → P2002 del único parcial → conflicto y la tx entera se revierte", async () => {
    let pending: ReturnType<typeof set> | null = null;
    let competitor = "";
    await db.$transaction(
      async (tx) => {
        // Fila vigente de p1 SIN commitear y sin el advisory lock (un escritor que no pasa por la action).
        competitor = (
          await tx.practitionerRevenueShare.create({
            data: {
              tenantId: A.tenantId,
              giverPractitionerId: p1.practitionerId,
              receiverPractitionerId: p3.practitionerId,
              shareBps: 700,
              appliesManual: true,
              appliesOnline: true,
              appliesInsurer: true,
              effectiveFrom: new Date(),
            },
            select: { id: true },
          })
        ).id;
        const [{ xid }] = await tx.$queryRaw<{ xid: string }[]>`SELECT (txid_current() % 4294967296)::text AS xid`;
        // La action no la ve (READ COMMITTED): pasa el CAS con `null` y su INSERT queda esperando el índice único.
        pending = set(p1.practitionerId, p2.practitionerId, "10", null);
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [{ n }] = await db.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = ${xid}`;
          if (n > 0) break;
          if (Date.now() > deadline) throw new Error("la action nunca quedó esperando el índice único");
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      { timeout: 20_000 }
    );
    expect(await pending!).toEqual({ ok: false, error: REVENUE_SHARE_COPY.conflict });
    const rows = await rowsA();
    expect(rows.map((r) => r.id)).toEqual([competitor]);
    expect(await auditsA()).toEqual([]);
  });

  it("[CF2-PS3-10] el export del consultorio trae las reglas (vigentes y cerradas), nada de otro", async () => {
    const a = await set(p1.practitionerId, p2.practitionerId, "10", null);
    if (!a.ok) throw new Error(a.error);
    const b = await set(p1.practitionerId, p3.practitionerId, "25", a.data.id);
    if (!b.ok) throw new Error(b.error);
    const pB = await addPractitioner(db, B);
    const ruleB = await addRevenueShare(db, B, { giverPractitionerId: B.practitionerId, receiverPractitionerId: pB.practitionerId, shareBps: 300 });

    const counts = Object.fromEntries(EXPORT_ENTITIES.map((e) => [e, 0])) as Record<ExportEntity, number>;
    let text = "";
    for await (const chunk of tenantExportChunks({ tenant: { id: A.tenantId, slug: A.slug, name: "x" }, now: new Date(), counts })) text += chunk;
    const json = JSON.parse(text) as { data: Record<string, Array<Record<string, unknown>>> };
    const shares = json.data.practitionerRevenueShares;
    expect(shares.map((r) => r.id).sort()).toEqual([a.data.id, b.data.id].sort());
    expect(counts.practitionerRevenueShares).toBe(2);
    expect(shares.find((r) => r.id === a.data.id)).toMatchObject({
      giverPractitionerId: p1.practitionerId,
      receiverPractitionerId: p2.practitionerId,
      shareBps: 1000,
      appliesManual: true,
      appliesOnline: true,
      appliesInsurer: true,
      createdById: A.userId,
      closedById: A.userId,
    });
    expect(typeof shares[0].effectiveFrom).toBe("string");
    expect(text).not.toContain(ruleB);
  });
});
