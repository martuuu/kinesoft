/**
 * FC-2c · diagnósticos server (C-FC2, brief T4 §24.4; tests del Anexo C «FC-2c»): búsqueda, favoritos, recientes,
 * propios (FC-D22) y la resolución de refs que usan las fichas (`resolveDiagnosesInTx`).
 *
 * Símbolos reales contra Postgres en los dos roles (`npm run test:integration -- diagnoses` = kinesoft_app con RLS;
 * `:owner` = BYPASSRLS como prod). Se mockea solo la sesión/cookies/`next/cache` (integration-setup).
 *
 * `DiagnosisCode` es global: cada corrida usa un token propio en los títulos y códigos `9Y**` (el importador de FC-1d
 * usa `9Z**`), los crea el owner (la app solo lee) y los borra en afterAll. Las fichas de «recientes» se insertan con
 * el owner (no dependen de FC-2a) y las limpia `deleteTenantDeep`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  archiveTenantDiagnosis,
  createTenantDiagnosis,
  getDiagnosisPickerHome,
  listTenantDiagnoses,
  searchDiagnoses,
  toggleDiagnosisFavorite,
  updateTenantDiagnosis,
} from "@/lib/diagnoses";
import { resolveDiagnosesInTx } from "@/lib/diagnoses-internal";
import { normalizeIcdSearchText } from "@/lib/diagnoses-import-core";
import { DIAGNOSIS_COPY, DIAGNOSIS_FAVORITES_MAX, type DiagnosisRef, type DiagnosisSnapshot } from "@/lib/diagnoses-types";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Letras solas: no parece un código (`parseDiagnosisQuery` exige letra Y dígito) y no choca con otros títulos. */
const letters = (n: number) =>
  Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const T = `zq${letters(8)}`;
const C2 = `${"0123456789"[Math.floor(Math.random() * 10)]}${"ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]}`;

describe.skipIf(!RUN)("[FC-2c] diagnósticos server", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let G: EphemeralTenant;
  let p2: { userId: string; practitionerId: string };
  let p3: { userId: string; practitionerId: string };
  let secretaria: { userId: string };
  let facturacion: { userId: string };
  const codeIds: string[] = [];
  const icd: Record<string, { id: string; code: string; title: string; uri: string }> = {};
  let kineA: string;
  let kineB: string;

  async function addIcd(key: string, code: string, title: string, opts: { retired?: boolean } = {}) {
    const uri = `http://id.who.int/icd/release/11/2025-01/mms/${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const row = await db.diagnosisCode.create({
      data: {
        code,
        title,
        uri,
        release: "2025-01",
        searchText: normalizeIcdSearchText(code, title),
        ...(opts.retired ? { retiredAt: new Date(), retiredInRelease: "2025-01" } : {}),
      },
      select: { id: true },
    });
    codeIds.push(row.id);
    icd[key] = { id: row.id, code, title, uri };
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", saasPlan: "CLINICA" });
    p2 = await addPractitioner(db, A);
    p3 = await addPractitioner(db, A);
    secretaria = await addStaff(db, A, "ASSISTANT", { grantSettings: true });
    facturacion = await addStaff(db, A, "BILLING");

    // Orden: «{T} aguda» empieza con (2) · «Dolor {T}» palabra (3) · «Pre{T}» contiene (4) · retirado afuera.
    await addIcd("starts", `9Y${C2}`, `${T} aguda`);
    await addIcd("prefix", `9Y${C2}.1`, `Dolor ${T}`);
    await addIcd("contains", `9Y${C2}.2`, `Pre${T}`);
    await addIcd("retired", `9Y${C2}.3`, `${T} retirado`, { retired: true });
    await addIcd("accent", `9Y${C2}.4`, `Cuádriceps ${T}`);

    kineA = (
      await db.condition.create({
        data: { slug: `kine-${uniqueSuffix()}`, name: `${T} kinesio propia`, cie10: "M54.5", tenantId: A.tenantId },
        select: { id: true },
      })
    ).id;
    kineB = (
      await db.condition.create({
        data: { slug: `kine-${uniqueSuffix()}`, name: `${T} kinesio ajena`, tenantId: B.tenantId },
        select: { id: true },
      })
    ).id;
    await db.tenantDiagnosis.create({
      data: { tenantId: B.tenantId, title: `${T} propio ajeno`, searchText: normalizeIcdSearchText("", `${T} propio ajeno`) },
    });
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    for (const t of [A, B, G]) await t?.cleanup();
    if (codeIds.length) {
      await db.diagnosisFavorite.deleteMany({ where: { diagnosisCodeId: { in: codeIds } } });
      await db.diagnosisCode.deleteMany({ where: { id: { in: codeIds } } });
    }
    await db.$disconnect();
  });

  const resolve = async (userId: string, refs: DiagnosisRef[], keep?: DiagnosisSnapshot[]) => {
    asUser(userId);
    const actor = await getActor();
    return runWithRls(actor.tenantId, (tx) => resolveDiagnosesInTx(tx, actor, refs, keep ? { keep } : undefined));
  };

  // ─── Búsqueda ──────────────────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2c] orden de la búsqueda; sin tildes; retirados afuera", async () => {
    asUser(A.userId);
    const r = await searchDiagnoses({ q: T.toUpperCase() });
    expect(r?.icdCatalogLoaded).toBe(true);
    const icdGroup = r!.groups.find((g) => g.source === "icd11")!;
    expect(icdGroup.label).toBe("CIE-11 (OMS)");
    const titles = icdGroup.options.map((o) => o.title);
    expect(titles.filter((t) => t.toLowerCase().includes(T))).toEqual([
      `${T} aguda`,
      `Dolor ${T}`,
      `Cuádriceps ${T}`,
      `Pre${T}`,
    ]);
    expect(titles).not.toContain(`${T} retirado`);
    expect(icdGroup.options[0]).toMatchObject({ ref: { kind: "icd11", id: icd.starts.id }, code: icd.starts.code, retired: false });

    // Sin tildes: «cuadriceps» encuentra «Cuádriceps» (empieza con).
    const acc = await searchDiagnoses({ q: `cuadriceps ${T}` });
    expect(acc!.groups.find((g) => g.source === "icd11")!.options[0].title).toBe(`Cuádriceps ${T}`);

    // Código exacto (0) > prefijo (1): por código, aunque el título no tenga nada que ver.
    const byCode = await searchDiagnoses({ q: `9y${C2.toLowerCase()}` });
    const codes = byCode!.groups.find((g) => g.source === "icd11")!.options.map((o) => o.code);
    expect(codes[0]).toBe(`9Y${C2}`);
    expect([...codes.slice(1, 4)].sort()).toEqual([`9Y${C2}.1`, `9Y${C2}.2`, `9Y${C2}.4`]);
    expect(codes).not.toContain(`9Y${C2}.3`);
  });

  it("[FC-2c] grupos; nunca de otro consultorio", async () => {
    asUser(A.userId);
    const own = await createTenantDiagnosis({ title: `${T} propio de A` });
    expect(own.ok).toBe(true);
    const r = await searchDiagnoses({ q: T });
    expect(r!.groups.map((g) => g.source)).toEqual(["tenant", "kine", "icd11"]);
    expect(r!.groups.map((g) => g.label)).toEqual(["Propios del consultorio", "Kinesiología", "CIE-11 (OMS)"]);
    const all = r!.groups.flatMap((g) => g.options.map((o) => o.title));
    expect(all).toContain(`${T} propio de A`);
    expect(all).toContain(`${T} kinesio propia`);
    expect(all).not.toContain(`${T} propio ajeno`);
    expect(all).not.toContain(`${T} kinesio ajena`);
    // FC-D25: Kinesiología sin cie10.
    expect(r!.groups.find((g) => g.source === "kine")!.options.find((o) => o.title === `${T} kinesio propia`)!.code).toBeNull();
    expect(r!.canCreateOwn).toBe(true);

    // General: sin el módulo `diagnostico` no hay grupo Kinesiología.
    asUser(G.userId);
    const g = await searchDiagnoses({ q: T });
    expect(g!.groups.map((x) => x.source)).not.toContain("kine");
    expect(g!.groups.map((x) => x.source)).toContain("icd11");

    // <2 caracteres: sin grupos, sin error.
    asUser(A.userId);
    expect(await searchDiagnoses({ q: "a" })).toMatchObject({ groups: [], icdCatalogLoaded: true });
  });

  it("[FC-2c] staff no clínico → vacío", async () => {
    for (const u of [secretaria.userId, facturacion.userId]) {
      asUser(u);
      expect(await searchDiagnoses({ q: T })).toBeNull();
      expect(await getDiagnosisPickerHome()).toBeNull();
      expect(await listTenantDiagnoses()).toEqual([]);
      expect(await toggleDiagnosisFavorite({ ref: { kind: "icd11", id: icd.starts.id }, on: true })).toMatchObject({ ok: false });
      expect(await createTenantDiagnosis({ title: `${T} de la secretaria` })).toMatchObject({ ok: false });
    }
    expect(await db.tenantDiagnosis.count({ where: { tenantId: A.tenantId, title: `${T} de la secretaria` } })).toBe(0);
    expect(await db.diagnosisFavorite.count({ where: { userId: { in: [secretaria.userId, facturacion.userId] } } })).toBe(0);
  });

  // ─── Favoritos ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2c] favoritos idempotentes, por usuario, tope 200", async () => {
    asUser(p2.userId);
    const ref = { kind: "icd11", id: icd.starts.id } as const;
    expect(await toggleDiagnosisFavorite({ ref, on: true })).toEqual({ ok: true, data: { favorite: true } });
    expect(await toggleDiagnosisFavorite({ ref, on: true })).toEqual({ ok: true, data: { favorite: true } });
    expect(await db.diagnosisFavorite.count({ where: { userId: p2.userId, diagnosisCodeId: icd.starts.id } })).toBe(1);

    // Por usuario: p3 no lo ve como favorito.
    const homeP2 = await getDiagnosisPickerHome();
    expect(homeP2!.favorites.map((f) => f.ref)).toEqual([ref]);
    asUser(p3.userId);
    expect((await getDiagnosisPickerHome())!.favorites).toEqual([]);
    const s3 = await searchDiagnoses({ q: T });
    expect(s3!.groups.find((g) => g.source === "icd11")!.options.find((o) => o.title === `${T} aguda`)!.favorite).toBe(false);

    // Destinos inválidos: retirado, propio ajeno, condición ajena.
    asUser(p2.userId);
    expect(await toggleDiagnosisFavorite({ ref: { kind: "icd11", id: icd.retired.id }, on: true })).toEqual({
      ok: false,
      error: DIAGNOSIS_COPY.retired,
    });
    const ajeno = await db.tenantDiagnosis.findFirstOrThrow({ where: { tenantId: B.tenantId }, select: { id: true } });
    expect(await toggleDiagnosisFavorite({ ref: { kind: "tenant", id: ajeno.id }, on: true })).toEqual({
      ok: false,
      error: DIAGNOSIS_COPY.notAvailable,
    });
    expect(await toggleDiagnosisFavorite({ ref: { kind: "kine", id: kineB }, on: true })).toEqual({
      ok: false,
      error: DIAGNOSIS_COPY.notAvailable,
    });
    expect((await toggleDiagnosisFavorite({ ref: { kind: "kine", id: kineA }, on: true })).ok).toBe(true);

    // Apagar: idempotente.
    expect(await toggleDiagnosisFavorite({ ref, on: false })).toEqual({ ok: true, data: { favorite: false } });
    expect(await toggleDiagnosisFavorite({ ref, on: false })).toEqual({ ok: true, data: { favorite: false } });
    expect(await db.diagnosisFavorite.count({ where: { userId: p2.userId, diagnosisCodeId: icd.starts.id } })).toBe(0);

    // Tope 200 (p3: llena 200 con propios del consultorio).
    const many = Array.from({ length: DIAGNOSIS_FAVORITES_MAX }, (_, i) => ({
      id: `td-${T}-${i}`,
      tenantId: A.tenantId,
      title: `${T} lote ${i}`,
      searchText: `${T} lote ${i}`,
    }));
    await db.tenantDiagnosis.createMany({ data: many });
    await db.diagnosisFavorite.createMany({
      data: many.map((m) => ({ tenantId: A.tenantId, userId: p3.userId, tenantDiagnosisId: m.id })),
    });
    asUser(p3.userId);
    expect(await toggleDiagnosisFavorite({ ref, on: true })).toEqual({ ok: false, error: DIAGNOSIS_COPY.favoritesFull });
    // Uno que ya está sigue siendo idempotente en el tope.
    expect(await toggleDiagnosisFavorite({ ref: { kind: "tenant", id: many[0].id }, on: true })).toEqual({
      ok: true,
      data: { favorite: true },
    });
    expect((await getDiagnosisPickerHome())!.favorites).toHaveLength(DIAGNOSIS_FAVORITES_MAX);
    await db.diagnosisFavorite.deleteMany({ where: { userId: p3.userId } });
    await db.tenantDiagnosis.deleteMany({ where: { id: { in: many.map((m) => m.id) } } });
  });

  // ─── Propios (FC-D22) ──────────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2c] permisos de propios (FC-D22)", async () => {
    asUser(p2.userId);
    const c = await createTenantDiagnosis({ title: `  ${T} de p2  `, code: " X1 " });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.data.option).toMatchObject({ ref: { kind: "tenant" }, source: "tenant", code: "X1", title: `${T} de p2` });
    const id = (c.data.option.ref as { id: string }).id;
    const row = await db.tenantDiagnosis.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ tenantId: A.tenantId, createdByUserId: p2.userId, searchText: `x1 ${T} de p2` });

    // Mismo nombre vivo, sin distinguir mayúsculas → duplicado.
    expect(await createTenantDiagnosis({ title: `${T} DE P2` })).toEqual({ ok: false, error: DIAGNOSIS_COPY.duplicateTitle });
    // Texto fuera de 2..120.
    expect(await createTenantDiagnosis({ title: " x " })).toEqual({ ok: false, error: DIAGNOSIS_COPY.textLength });

    const list2 = await listTenantDiagnoses();
    expect(list2.find((r) => r.id === id)).toMatchObject({ createdByMe: true, canManage: true, archived: false });

    // Otro profesional: no lo edita ni lo archiva.
    asUser(p3.userId);
    expect((await listTenantDiagnoses()).find((r) => r.id === id)).toMatchObject({ createdByMe: false, canManage: false });
    expect(await updateTenantDiagnosis({ id, title: `${T} pisado`, expectedUpdatedAt: row.updatedAt.toISOString() })).toEqual({
      ok: false,
      error: DIAGNOSIS_COPY.forbidden,
    });
    expect(await archiveTenantDiagnosis({ id })).toEqual({ ok: false, error: DIAGNOSIS_COPY.forbidden });

    // El autor lo renombra (lock optimista).
    asUser(p2.userId);
    const u = await updateTenantDiagnosis({ id, title: `${T} de p2 v2`, code: null, expectedUpdatedAt: row.updatedAt.toISOString() });
    expect(u.ok).toBe(true);
    // updatedAt viejo → rechazo.
    const stale = await updateTenantDiagnosis({ id, title: `${T} de p2 v3`, expectedUpdatedAt: row.updatedAt.toISOString() });
    expect(stale.ok).toBe(false);
    expect((await db.tenantDiagnosis.findUniqueOrThrow({ where: { id } })).title).toBe(`${T} de p2 v2`);

    // Titular (`tenant.sensitive`) archiva el de otro; archivar es idempotente y no borra.
    asUser(A.userId);
    expect(await archiveTenantDiagnosis({ id })).toEqual({ ok: true, data: undefined });
    expect(await archiveTenantDiagnosis({ id })).toEqual({ ok: true, data: undefined });
    expect((await db.tenantDiagnosis.findUniqueOrThrow({ where: { id } })).archivedAt).not.toBeNull();
    // Archivado: sale de la búsqueda y libera el nombre.
    const s = await searchDiagnoses({ q: `${T} de p2` });
    expect((s!.groups.find((g) => g.source === "tenant")?.options ?? []).map((o) => o.title)).not.toContain(`${T} de p2 v2`);
    expect((await createTenantDiagnosis({ title: `${T} de p2 v2` })).ok).toBe(true);

    // De otro consultorio: no existe para A.
    const ajeno = await db.tenantDiagnosis.findFirstOrThrow({ where: { tenantId: B.tenantId }, select: { id: true } });
    expect(await archiveTenantDiagnosis({ id: ajeno.id })).toEqual({ ok: false, error: DIAGNOSIS_COPY.notAvailable });
    expect((await db.tenantDiagnosis.findUniqueOrThrow({ where: { id: ajeno.id } })).archivedAt).toBeNull();

    // Audit en la misma tx, sin el título (ids y nombres de campo, nunca texto clínico).
    const ev = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, entityId: id }, orderBy: { createdAt: "asc" } });
    expect(ev.map((e) => e.action)).toEqual(["tenantDiagnosis.create", "tenantDiagnosis.update", "tenantDiagnosis.archive"]);
  });

  // ─── Recientes ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("[FC-2c] recientes ≤8", async () => {
    const pid = await addPatient(db, A, { assignedPractitionerId: p2.practitionerId });
    const t0 = Date.now() - 20 * 60_000;
    const note = (i: number, diagnoses: DiagnosisSnapshot[] | null, voided = false) =>
      db.clinicalNote.create({
        data: {
          tenantId: A.tenantId,
          patientId: pid,
          body: `Ficha ${i}`,
          occurredAt: new Date(t0 + i * 60_000),
          createdAt: new Date(t0 + i * 60_000),
          authorUserId: p2.userId,
          authorPractitionerId: p2.practitionerId,
          authorName: "Kine p2",
          idempotencyKey: randomUUID(),
          diagnoses: diagnoses ?? undefined,
          ...(voided ? { voidedAt: new Date(), voidedByUserId: p2.userId, voidReason: "Error de carga" } : {}),
        },
      });
    const text = (t: string): DiagnosisSnapshot => ({ v: 1, source: "text", refId: null, code: null, title: t, uri: null, release: null });
    const snapIcd = (k: string): DiagnosisSnapshot => ({
      v: 1, source: "icd11", refId: icd[k].id, code: icd[k].code, title: icd[k].title, uri: icd[k].uri, release: "2025-01",
    });
    // La más vieja primero; la más nueva (i=11) lleva el retirado, que no debe aparecer.
    for (let i = 0; i < 10; i++) await note(i, [text(`${T} texto ${i}`)]);
    await note(10, [snapIcd("starts"), text(`${T} texto 9`)]);
    await note(11, [snapIcd("retired"), snapIcd("starts")]);
    await note(12, [text(`${T} anulada`)], true);
    await note(13, null);

    asUser(p2.userId);
    const home = await getDiagnosisPickerHome();
    const rec = home!.recents.map((o) => o.title);
    expect(rec).toHaveLength(8);
    expect(rec).toEqual([
      `${T} aguda`,
      `${T} texto 9`,
      `${T} texto 8`,
      `${T} texto 7`,
      `${T} texto 6`,
      `${T} texto 5`,
      `${T} texto 4`,
      `${T} texto 3`,
    ]);
    expect(rec).not.toContain(`${T} retirado`);
    expect(rec).not.toContain(`${T} anulada`);
    expect(home!.recents[1].ref).toEqual({ kind: "text", text: `${T} texto 9` });

    // Recientes de OTRO usuario: no.
    asUser(p3.userId);
    expect((await getDiagnosisPickerHome())!.recents).toEqual([]);
  });

  // ─── resolveDiagnosesInTx (lo que usan las fichas) ─────────────────────────────────────────────────────────────

  it("[FC-2c] re-lectura en el server: congela {v, source, refId, code, title, uri, release}; kine sin cie10", async () => {
    const own = await db.tenantDiagnosis.create({
      data: { tenantId: A.tenantId, title: `${T} resolver`, code: "R1", searchText: `r1 ${T} resolver` },
    });
    const r = await resolve(p2.userId, [
      { kind: "icd11", id: icd.starts.id },
      { kind: "tenant", id: own.id },
      { kind: "kine", id: kineA },
      { kind: "text", text: "  Contractura  " },
      { kind: "icd11", id: icd.starts.id }, // repetido: se guarda una vez
    ]);
    expect(r).toEqual({
      ok: true,
      snapshots: [
        { v: 1, source: "icd11", refId: icd.starts.id, code: icd.starts.code, title: icd.starts.title, uri: icd.starts.uri, release: "2025-01" },
        { v: 1, source: "tenant", refId: own.id, code: "R1", title: `${T} resolver`, uri: null, release: null },
        { v: 1, source: "kine", refId: kineA, code: null, title: `${T} kinesio propia`, uri: null, release: null },
        { v: 1, source: "text", refId: null, code: null, title: "Contractura", uri: null, release: null },
      ],
    });
  });

  it("[FC-2c] CIE-11 retirado; propio ajeno; kine sin módulo; texto fuera de rango; más de 5", async () => {
    expect(await resolve(p2.userId, [{ kind: "icd11", id: icd.retired.id }])).toEqual({ ok: false, error: DIAGNOSIS_COPY.retired });
    expect(await resolve(p2.userId, [{ kind: "icd11", id: "no-existe" }])).toEqual({ ok: false, error: DIAGNOSIS_COPY.notAvailable });
    const ajeno = await db.tenantDiagnosis.findFirstOrThrow({ where: { tenantId: B.tenantId }, select: { id: true } });
    expect(await resolve(p2.userId, [{ kind: "tenant", id: ajeno.id }])).toEqual({ ok: false, error: DIAGNOSIS_COPY.notAvailable });
    expect(await resolve(p2.userId, [{ kind: "kine", id: kineB }])).toEqual({ ok: false, error: DIAGNOSIS_COPY.notAvailable });
    // General: sin el módulo `diagnostico`, ni la global ni la propia.
    expect(await resolve(G.userId, [{ kind: "kine", id: kineA }])).toEqual({ ok: false, error: DIAGNOSIS_COPY.notAvailable });
    expect(await resolve(p2.userId, [{ kind: "text", text: " x " }])).toEqual({ ok: false, error: DIAGNOSIS_COPY.textLength });
    expect(await resolve(p2.userId, [{ kind: "text", text: "y".repeat(121) }])).toEqual({ ok: false, error: DIAGNOSIS_COPY.textLength });
    const six = Array.from({ length: 6 }, (_, i) => ({ kind: "text", text: `Diagnóstico ${i}` }) as const);
    expect(await resolve(p2.userId, six)).toEqual({ ok: false, error: DIAGNOSIS_COPY.tooMany });
  });

  it("[FC-2c] editar conserva congelado lo que ya estaba (retirado, renombrado, sin módulo)", async () => {
    const frozenIcd: DiagnosisSnapshot = {
      v: 1, source: "icd11", refId: icd.retired.id, code: icd.retired.code, title: "Título con que se firmó", uri: icd.retired.uri, release: "2024-01",
    };
    const frozenKine: DiagnosisSnapshot = { v: 1, source: "kine", refId: kineA, code: null, title: "Condición vieja", uri: null, release: null };
    const r = await resolve(G.userId, [{ kind: "icd11", id: icd.retired.id }, { kind: "kine", id: kineA }, { kind: "text", text: "Agregado" }], [frozenIcd, frozenKine]);
    expect(r).toEqual({
      ok: true,
      snapshots: [frozenIcd, frozenKine, { v: 1, source: "text", refId: null, code: null, title: "Agregado", uri: null, release: null }],
    });
    // Sin `keep`, el mismo retirado se rechaza.
    expect(await resolve(G.userId, [{ kind: "icd11", id: icd.retired.id }])).toEqual({ ok: false, error: DIAGNOSIS_COPY.retired });
  });

  it("[FC-2c] sin catálogo CIE-11 cargado: icdCatalogLoaded false, propios y texto siguen", async (ctx) => {
    // La base local es compartida: solo se puede afirmar el vacío si no hay otros códigos vivos además de los nuestros.
    const others = await db.diagnosisCode.count({ where: { retiredAt: null, id: { notIn: codeIds } } });
    if (others > 0) ctx.skip();
    await db.diagnosisCode.updateMany({ where: { id: { in: codeIds }, retiredAt: null }, data: { retiredAt: new Date(), retiredInRelease: "2099-01" } });
    try {
      asUser(A.userId);
      const r = await searchDiagnoses({ q: T });
      expect(r!.icdCatalogLoaded).toBe(false);
      expect(r!.groups.map((g) => g.source)).not.toContain("icd11");
      expect(r!.groups.map((g) => g.source)).toContain("tenant");
      expect((await getDiagnosisPickerHome())!.icdCatalogLoaded).toBe(false);
      expect(await resolve(A.userId, [{ kind: "text", text: "Lumbalgia" }])).toMatchObject({ ok: true });
    } finally {
      await db.diagnosisCode.updateMany({ where: { id: { in: codeIds }, retiredInRelease: "2099-01" }, data: { retiredAt: null, retiredInRelease: null } });
    }
  });
});
