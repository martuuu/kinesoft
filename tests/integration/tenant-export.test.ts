/**
 * [BO5-C] Export completo del consultorio (plan §19.5; BO-D4) y «Pedir export» desde Plataforma.
 *
 * Anti-fuga (lo que importa): dos consultorios A y B con datos y PHI MARCADA en cada entidad (`PHI-A-…`,
 * `PHI-B-…`), más una trampa: un `PatientTenantLink` de A que apunta a un paciente de B (las FK saltean RLS). El
 * export de A se escanea ENTERO (texto crudo) buscando cualquier id o marca de B. Corre en los dos roles:
 * `npm run test:integration -- export` (kinesoft_app, RLS aplicado) y `:owner -- export` (BYPASSRLS = prod: ahí el
 * `where: { tenantId }` a mano es la única barrera, y es el que importa).
 *
 * Símbolos REALES: el route handler `GET` (sesión, OWNER, soporte, rate limit, stream), `streamTenantExport`
 * (páginas con cursor) y `requestTenantExport`. Se mockea solo lo externo (sesión de Supabase, cookies, next/cache
 * en integration-setup; el DESPACHO del mail con `__setEmailTransportForTests`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { GET as exportTenant } from "@/app/api/consultorio/export/route";
import { streamTenantExport } from "@/lib/tenant-export-internal";
import { EXPORT_ENTITIES } from "@/lib/tenant-export-logic";
import { requestTenantExport } from "@/lib/platform-export-request";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { ForbiddenError } from "@/lib/session";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const URL_ = "http://localhost/api/consultorio/export";

type Seeded = { ids: string[]; markers: string[]; patientId: string };

/** Una fila con PHI marcada en cada entidad que el export lleva. Devuelve todos los ids y marcas creados. */
async function seed(db: PrismaClient, t: EphemeralTenant, tag: string): Promise<Seeded> {
  const s = uniqueSuffix();
  const mk = (f: string) => `PHI-${tag}-${f}-${s}`;
  const ids: string[] = [t.tenantId, t.practitionerId, t.serviceId, t.particularInsurerId];
  const patientId = await addPatient(db, t, { firstName: mk("nombre"), notes: mk("nota-paciente"), documentId: mk("dni") });
  ids.push(patientId);
  const loc = await db.location.create({ data: { tenantId: t.tenantId, name: mk("sede"), address: mk("direccion") } });
  const room = await db.room.create({ data: { tenantId: t.tenantId, locationId: loc.id, name: mk("sala") } });
  const cov = await db.coverage.create({ data: { patientId, insurer: mk("obra"), memberId: mk("afiliado") } });
  const ec = await db.emergencyContact.create({ data: { patientId, name: mk("contacto"), phone: mk("tel") } });
  const booking = await db.booking.create({
    data: {
      tenantId: t.tenantId,
      patientId,
      practitionerId: t.practitionerId,
      serviceId: t.serviceId,
      locationId: loc.id,
      roomId: room.id,
      scheduledFor: new Date("2031-05-05T13:00:00Z"),
      durationMin: 45,
      status: "CONFIRMED",
      notes: mk("nota-turno"),
      idempotencyKey: `IDEMP-${tag}-${randomUUID()}`,
    },
  });
  const pay = await db.payment.create({
    data: { bookingId: booking.id, amountCents: 5000, externalId: mk("mp"), rawPayload: { payer: mk("raw-mp") } },
  });
  const cond = await db.condition.create({ data: { tenantId: t.tenantId, slug: `c-${tag}-${s}`.toLowerCase(), name: mk("condicion") } });
  const ex = await db.exercise.create({ data: { tenantId: t.tenantId, slug: `e-${tag}-${s}`.toLowerCase(), name: mk("ejercicio") } });
  const cc = await db.clinicalCase.create({
    data: { tenantId: t.tenantId, authorId: t.practitionerId, patientId, selectedZones: [mk("zona")], refinements: {}, notes: mk("nota-caso") },
  });
  const dx = await db.diagnosis.create({ data: { caseId: cc.id, conditionId: cond.id, matchScore: 0.9, rank: 1 } });
  const prog = await db.treatmentProgram.create({
    data: { tenantId: t.tenantId, patientId, title: mk("plan"), startDate: new Date("2031-05-01T03:00:00Z"), notes: mk("nota-plan") },
  });
  const ses = await db.session.create({
    data: { programId: prog.id, practitionerId: t.practitionerId, index: 1, scheduledFor: new Date("2031-05-05T13:00:00Z"), notes: mk("nota-sesion") },
  });
  const se = await db.sessionExercise.create({ data: { sessionId: ses.id, exerciseId: ex.id, order: 1, sets: 3, reps: 10, notes: mk("nota-ej") } });
  const eva = await db.evaScore.create({ data: { patientId, value: 7, note: mk("eva"), sessionId: ses.id } });
  const file = await db.patientFile.create({
    data: { tenantId: t.tenantId, patientId, name: mk("archivo.pdf"), mime: "application/pdf", sizeBytes: 10, storageKey: `STORAGE-${tag}-${s}` },
  });
  const ev = await db.auditEvent.create({ data: { tenantId: t.tenantId, action: "test.seed", entity: "Patient", entityId: patientId, ip: `IP-${tag}` } });
  ids.push(loc.id, room.id, cov.id, ec.id, booking.id, pay.id, cond.id, ex.id, cc.id, dx.id, prog.id, ses.id, se.id, eva.id, file.id, ev.id);
  return {
    ids,
    patientId,
    markers: [`PHI-${tag}-`, `IDEMP-${tag}`, `STORAGE-${tag}`],
  };
}

async function body(res: Response): Promise<{ text: string; json: { data: Record<string, Array<Record<string, unknown>>>; manifest: { counts: Record<string, number>; tenant: { id: string } } } }> {
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}

describe.skipIf(!RUN)("[BO5-C] export completo del consultorio", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  /** Consultorio suspendido (BO-D4). */
  let S: EphemeralTenant;
  /** Home del superadmin. */
  let H: EphemeralTenant;
  let seedA: Seeded;
  let seedB: Seeded;
  let adminA: string;
  const mails: SendEmailInput[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    S = await createEphemeralTenant(db, { status: "SUSPENDED" });
    H = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    adminA = (await addPractitioner(db, A, "ADMIN")).userId;
    seedA = await seed(db, A, "A");
    seedB = await seed(db, B, "B");
    // Trampa: A «vinculado» a un paciente cuyo consultorio casa es B. El export de A no puede sacar ese id.
    await db.patientTenantLink.create({ data: { patientId: seedB.patientId, tenantId: A.tenantId } });
  }, 60_000);

  afterAll(async () => {
    __setEmailTransportForTests(null);
    if (db) {
      for (const t of [A, B, S, H]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    cookies().delete(SUPPORT_COOKIE);
    cookies().delete("kine_tenant");
    __rateLimitInternals.reset();
    mails.length = 0;
    __setEmailTransportForTests(async (i): Promise<SendEmailResult> => {
      mails.push(i);
      return { ok: true, transport: "resend", providerId: `fake-${mails.length}` };
    });
  });

  it("OWNER de A: 200, JSON con headers de descarga, manifest con counts = filas, y NADA de B (escaneo completo)", async () => {
    asUser(A.userId);
    const res = await exportTenant(new Request(URL_));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(new RegExp(`^attachment; filename="kinesoft-${A.slug}-\\d{4}-\\d{2}-\\d{2}\\.json"$`));
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { text, json } = await body(res);

    expect(json.manifest.tenant.id).toBe(A.tenantId);
    for (const e of EXPORT_ENTITIES) expect(json.manifest.counts[e], e).toBe(json.data[e].length);
    // Todo lo de A está.
    for (const id of seedA.ids) expect(text, `falta ${id}`).toContain(id);
    expect(text).toContain("PHI-A-nota-sesion");
    // Nada de B: ni ids ni marcas.
    for (const id of seedB.ids) expect(text, `fuga de id de B ${id}`).not.toContain(id);
    expect(text).not.toContain("PHI-B-");
    // Exclusiones: secretos/internos de la propia A tampoco salen.
    expect(text).not.toMatch(/IDEMP-A|STORAGE-A|raw-mp|IP-A/);
    // Ids de Auth: solo en `team` (para atribuir el audit); el portal del paciente y el profesional no los llevan.
    for (const r of json.data.patients) expect(r).not.toHaveProperty("userId");
    for (const r of json.data.practitioners) expect(r).not.toHaveProperty("userId");
    for (const r of json.data.bookings) expect(r).not.toHaveProperty("idempotencyKey");
    for (const r of json.data.payments) expect(r).not.toHaveProperty("rawPayload");
    for (const r of json.data.patientFiles) expect(r).not.toHaveProperty("storageKey");
  });

  it("audita tenant.export.started y tenant.export con los conteos (sin PHI)", async () => {
    asUser(A.userId);
    const { json } = await body(await exportTenant(new Request(URL_)));
    const ev = await db.auditEvent.findFirst({ where: { tenantId: A.tenantId, action: "tenant.export" }, orderBy: { createdAt: "desc" } });
    expect(ev).toMatchObject({ actorId: A.userId, entity: "Tenant", entityId: A.tenantId });
    const payload = ev!.payload as { completed: boolean; counts: Record<string, number> };
    expect(payload.completed).toBe(true);
    expect(payload.counts).toEqual(json.manifest.counts);
    expect(JSON.stringify(ev!.payload)).not.toContain("PHI-");
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "tenant.export.started" } })).toBeGreaterThan(0);
  });

  it("paginado (cursor por id, página de 1) da exactamente los mismos datos que una sola página", async () => {
    asUser(A.userId);
    const { json: full } = await body(await exportTenant(new Request(URL_)));
    const tenant = { id: A.tenantId, slug: A.slug, name: "x" };
    const paged = JSON.parse(await new Response(streamTenantExport({ tenant, actorUserId: A.userId, now: new Date(), pageSize: 1 })).text());
    // El audit crece entre una corrida y otra (cada export se audita): ahí alcanza con que estén todas las de antes.
    for (const e of EXPORT_ENTITIES) {
      if (e === "auditEvents") {
        const pagedIds = new Set(paged.data[e].map((r: { id: string }) => r.id));
        for (const r of full.data[e]) expect(pagedIds.has(r.id as string)).toBe(true);
      } else expect(paged.data[e], e).toEqual(full.data[e]);
    }
    expect(paged.data.patients.length).toBeGreaterThan(0);
  });

  it("ADMIN de A → 403; sin sesión → 401", async () => {
    asUser(adminA);
    expect((await exportTenant(new Request(URL_))).status).toBe(403);
    asUser("test-user-inexistente");
    expect((await exportTenant(new Request(URL_))).status).toBe(401);
  });

  it("?tenant= de un consultorio ajeno (B) → 403 aunque sea OWNER de A", async () => {
    asUser(A.userId);
    expect((await exportTenant(new Request(`${URL_}?tenant=${B.tenantId}`))).status).toBe(403);
  });

  it("soporte (superadmin «como soporte» en A) → 403", async () => {
    asUser(H.userId);
    const r = await startSupport(A.tenantId, "Ayuda con obras sociales");
    expect(r.ok).toBe(true);
    expect((await exportTenant(new Request(URL_))).status).toBe(403);
  });

  it("OWNER de un consultorio SUSPENDIDO (sin Actor) → 200 con sus datos (BO-D4)", async () => {
    asUser(S.userId);
    const res = await exportTenant(new Request(URL_));
    expect(res.status).toBe(200);
    const { json } = await body(res);
    expect(json.manifest.tenant.id).toBe(S.tenantId);
    expect(json.data.tenant[0]).toMatchObject({ id: S.tenantId, status: "SUSPENDED" });
  });

  it("rate limit: 3 por hora por consultorio, la 4ª → 429 con Retry-After", async () => {
    asUser(A.userId);
    for (let i = 0; i < 3; i++) {
      const res = await exportTenant(new Request(URL_));
      expect(res.status).toBe(200);
      await res.text();
    }
    const blocked = await exportTenant(new Request(URL_));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUN)("[BO5-C] Plataforma «Pedir export»: el superadmin no recibe datos", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let H: EphemeralTenant;
  const mails: SendEmailInput[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    H = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    await addPatient(db, A, { firstName: "PHI-PEDIDO-nombre" });
  }, 60_000);

  afterAll(async () => {
    __setEmailTransportForTests(null);
    if (db) {
      for (const t of [A, H]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    mails.length = 0;
    __setEmailTransportForTests(async (i): Promise<SendEmailResult> => {
      mails.push(i);
      return { ok: true, transport: "resend", providerId: `fake-${mails.length}` };
    });
  });

  it("manda el mail al OWNER (link a Exportar datos, sin PHI), audita doble y no devuelve datos", async () => {
    asUser(H.userId);
    const r = await requestTenantExport({ tenantId: A.tenantId });
    expect(r).toEqual({ ok: true, data: { sent: 1, owners: 1 } });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: `${A.userId}@test.local`, kind: "tenant_export_request", tenantId: A.tenantId });
    expect(mails[0].html).toContain("/configuracion?tab=exportar");
    expect(mails[0].html + mails[0].text).not.toContain("PHI-PEDIDO");
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "platform.tenant.export.request", actorId: H.userId } })).toBe(1);
    expect(await db.platformAuditEvent.count({ where: { tenantId: A.tenantId, action: "platform.tenant.export.request", actorId: H.userId } })).toBe(1);
  });

  it("un no-superadmin (el OWNER mismo) → Forbidden", async () => {
    asUser(A.userId);
    await expect(requestTenantExport({ tenantId: A.tenantId })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rate limit por consultorio: 3 por día; la 4ª no manda mail", async () => {
    asUser(H.userId);
    for (let i = 0; i < 3; i++) expect((await requestTenantExport({ tenantId: A.tenantId })).ok).toBe(true);
    const r = await requestTenantExport({ tenantId: A.tenantId });
    expect(r.ok).toBe(false);
    expect(mails).toHaveLength(3);
  });

  it("zod estricto: claves de más o tenant inexistente → error sin mail", async () => {
    asUser(H.userId);
    expect((await requestTenantExport({ tenantId: A.tenantId, extra: 1 })).ok).toBe(false);
    expect((await requestTenantExport({ tenantId: "no-existe" })).ok).toBe(false);
    expect(mails).toHaveLength(0);
  });
});
