/**
 * [P4-S24d] «Mis datos» del portal (brief ES4 §4 fila S24d, §3.5, ES4-D8/D9).
 *
 * Qué se fija, con los símbolos reales contra Postgres:
 *  - «Tus consultorios» muestra «Reservar turno» solo con el turnero abierto (`turneroPublico`); antes de S24d el link
 *    salía siempre y llevaba a un turnero cerrado.
 *  - El portal NUNCA escribe la ficha: el paciente deja un pedido (`PatientChangeRequest` PENDING) que el consultorio
 *    aprueba (S24r). Test de grep sobre `lib/portal*.ts`.
 *
 * Fronteras mockeadas: la sesión de Supabase (tests/helpers/actor.ts vía integration-setup).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { prismaService } from "@/lib/db";
import { logger } from "@/lib/logger";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  requestPortalProfileChange,
  signOutPortalEverywhere,
  submitPortalProfileChange,
} from "@/lib/portal-profile";
import { loadPortalProfile } from "@/lib/portal-profile-internal";

// La sesión de Supabase: `getUser` igual que el setup de integración (tests/helpers/actor.ts) + `signOut`, que es la
// red a GoTrue de «Cerrar sesión en todos lados» (frontera externa: se mockea, la action no).
const signOut = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", async () => {
  const { currentTestUser } = await import("@/tests/helpers/actor");
  return {
    getSupabaseServerClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: currentTestUser() }, error: null }),
        signOut,
      },
    }),
  };
});

// La config de integración compila JSX con el runtime clásico: la página se ejecuta como función (server component).
import * as ReactNs from "react";
(globalThis as { React?: unknown }).React = ReactNs;

import PortalMe from "@/app/(portal)/portal/me/page";

const RUN = process.env.INTEGRATION === "1";

type Node = { type?: unknown; props?: Record<string, unknown> } | string | number | null | undefined | boolean | Node[];

/** Textos y hrefs del árbol que devuelve la página (sin ejecutar componentes: alcanza con props/children). */
function collect(node: Node, out: { text: string[]; hrefs: string[] } = { text: [], hrefs: [] }) {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.text.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return out;
  }
  const props = node.props ?? {};
  if (typeof props.href === "string") out.hrefs.push(props.href);
  collect(props.children as Node, out);
  return out;
}

describe.skipIf(!RUN)("[P4-S24d] «Mis datos» del portal", () => {
  let db: PrismaClient;
  let open: EphemeralTenant;
  let closed: EphemeralTenant;
  let suspended: EphemeralTenant;
  const profiles: string[] = [];
  const logs: Array<[string, unknown]> = [];

  const account = async () => {
    const id = `test-prof-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
    profiles.push(id);
    return { id, email: `${id}@test.local` };
  };
  /** Ficha vinculada a la cuenta (como la deja `linkPatientCas`). */
  const linked = async (t: EphemeralTenant, userId: string) => {
    const patientId = await addPatient(db, t, {});
    await db.patient.update({ where: { id: patientId }, data: { userId } });
    return patientId;
  };

  beforeAll(async () => {
    db = ownerClient();
    open = await createEphemeralTenant(db, { publicBookingEnabled: true });
    closed = await createEphemeralTenant(db, { publicBookingEnabled: false });
    suspended = await createEphemeralTenant(db, { status: "SUSPENDED" });
  });
  afterAll(async () => {
    await open?.cleanup();
    await closed?.cleanup();
    await suspended?.cleanup();
    if (profiles.length) await db.userProfile.deleteMany({ where: { id: { in: profiles } } });
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    logs.length = 0;
    signOut.mockReset();
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation((msg: string, ctx?: Record<string, unknown>) => {
        logs.push([msg, ctx]);
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    asAnonymous();
  });

  const PHONE = "+54 9 11 5555-0101";
  const pending = (patientId: string) =>
    db.patientChangeRequest.findMany({ where: { patientId, status: "PENDING" } });
  const patientRow = (id: string) =>
    db.patient.findUniqueOrThrow({
      where: { id },
      select: { phone: true, email: true, updatedAt: true, userId: true, firstName: true, lastName: true },
    });
  /**
   * Parche a mano del `findFirst` del delegate (no `vi.spyOn`: el delegate de Prisma es un proxy y `restoreAllMocks`
   * lo rompía para el resto, ver portal-identity.test.ts). `after` corre DESPUÉS de la lectura real, una sola vez: es la
   * carrera «otra request escribió entre la lectura y el write».
   */
  async function withRaceAfterRead<T>(after: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
    const delegate = prismaService.patientChangeRequest as unknown as {
      findFirst: (args: unknown) => Promise<unknown>;
    };
    const original = delegate.findFirst;
    let fired = false;
    delegate.findFirst = async (args: unknown) => {
      const row = await original.call(delegate, args);
      if (!fired) {
        fired = true;
        await after();
      }
      return row;
    };
    try {
      return await run();
    } finally {
      delegate.findFirst = original;
    }
  }

  it("[P4-S24d] «Sacar un turno» oculto con el turnero cerrado", async () => {
    const me = await account();
    await linked(open, me.id);
    await linked(closed, me.id);
    asUser(me.id);

    const tree = collect((await PortalMe()) as Node);
    expect(tree.hrefs).toContain(`/c/${open.slug}/booking`);
    expect(tree.hrefs).not.toContain(`/c/${closed.slug}/booking`);
    expect(tree.text.filter((s) => s.includes("Sacar un turno"))).toHaveLength(1);
  });

  it("el portal nunca escribe la ficha: lib/portal*.ts sin patient.update/updateMany/upsert/create (salvo el vínculo)", () => {
    const dir = join(process.cwd(), "lib");
    const files = readdirSync(dir).filter((f) => /^portal.*\.ts$/.test(f) && f !== "portal-link-internal.ts");
    expect(files).toContain("portal.ts");
    const write = /\.patient\.(update|updateMany|upsert|create|createMany|delete|deleteMany)\b|UPDATE\s+"Patient"/;
    const offenders = files.filter((f) => write.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("enviar un pedido crea la PENDING y no toca la ficha; avisa al equipo sin valores", async () => {
    const me = await account();
    const patientId = await linked(open, me.id);
    const before = await patientRow(patientId);
    asUser(me.id);

    const r = await requestPortalProfileChange({
      tenantSlug: open.slug,
      changes: { phone: PHONE, coverage: { insurerName: "OSDE", planName: "310", memberId: "123456789" } },
    });
    expect(r).toEqual({ ok: true, data: { fields: ["phone", "coverage"] } });

    const rows = await pending(patientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: open.tenantId,
      requestedByUserId: me.id,
      changes: { phone: PHONE, coverage: { insurerName: "OSDE", planName: "310", memberId: "123456789" } },
    });
    // La ficha, intacta (incluido `updatedAt`, el optimistic lock del lado consultorio).
    expect(await patientRow(patientId)).toEqual(before);

    const notes = await db.notification.findMany({ where: { tenantId: open.tenantId, link: `/pacientes/${patientId}` } });
    expect(notes.map((n) => n.userId)).toContain(open.userId);
    const dump = JSON.stringify(notes) + JSON.stringify(logs);
    for (const secret of [PHONE, "OSDE", "123456789", me.email]) expect(dump).not.toContain(secret);
    expect(notes[0].body).toContain("teléfono");
    expect(notes[0].body).toContain("obra social");
  });

  it("[ES4-Z b7] el aviso llega también a la Secretaria (agenda.operateAll); no a Facturación ni a suspendidas", async () => {
    const staff = async (role: "ASSISTANT" | "BILLING", disabled = false) => {
      const id = `test-staff-${uniqueSuffix()}`;
      await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
      profiles.push(id);
      await db.membership.create({
        data: { userId: id, tenantId: open.tenantId, role, disabledAt: disabled ? new Date() : null },
      });
      return id;
    };
    const assistant = await staff("ASSISTANT");
    const billing = await staff("BILLING");
    const suspended = await staff("ASSISTANT", true);
    const me = await account();
    const patientId = await linked(open, me.id);
    asUser(me.id);
    expect((await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } })).ok).toBe(true);
    const to = (await db.notification.findMany({ where: { tenantId: open.tenantId, link: `/pacientes/${patientId}` } })).map(
      (n) => n.userId
    );
    expect(to).toContain(open.userId);
    expect(to).toContain(assistant);
    expect(to).not.toContain(billing);
    expect(to).not.toContain(suspended);
    await db.membership.deleteMany({ where: { userId: { in: [assistant, billing, suspended] } } });
  });

  it("un segundo pedido actualiza la misma PENDING y fusiona por campo", async () => {
    const me = await account();
    const patientId = await linked(open, me.id);
    asUser(me.id);
    await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } });
    const [first] = await pending(patientId);
    const r = await requestPortalProfileChange({
      tenantSlug: open.slug,
      changes: { emergencyContact: { name: "Marta", relation: "madre", phone: "1144443333" } },
    });
    expect(r).toEqual({ ok: true, data: { fields: ["phone", "emergencyContact"] } });
    const rows = await pending(patientId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].changes).toEqual({
      phone: PHONE,
      emergencyContact: { name: "Marta", relation: "madre", phone: "1144443333" },
    });
    expect(rows[0].updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime() - 1);
  });

  it("carrera en el INSERT: otra request creó la PENDING → P2002 del parcial → reintenta como UPDATE", async () => {
    const me = await account();
    const patientId = await linked(open, me.id);
    asUser(me.id);
    const r = await withRaceAfterRead(
      () =>
        db.patientChangeRequest.create({
          data: { tenantId: open.tenantId, patientId, changes: { email: "otra@pestana.test" }, requestedByUserId: me.id },
        }),
      () => requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } })
    );
    expect(r).toEqual({ ok: true, data: { fields: ["phone", "email"] } });
    const rows = await pending(patientId);
    expect(rows).toHaveLength(1);
    expect(rows[0].changes).toEqual({ email: "otra@pestana.test", phone: PHONE });
  });

  it("CAS de updatedAt: la PENDING cambió entre la lectura y el UPDATE → no la pisa, reintenta sobre lo nuevo", async () => {
    const me = await account();
    const patientId = await linked(open, me.id);
    asUser(me.id);
    await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } });
    const [row] = await pending(patientId);
    const r = await withRaceAfterRead(
      () =>
        db.patientChangeRequest.update({
          where: { id: row.id },
          data: { changes: { phone: PHONE, email: "nuevo@pestana.test" } },
        }),
      () => requestPortalProfileChange({ tenantSlug: open.slug, changes: { coverage: { insurerName: "Swiss Medical" } } })
    );
    expect(r.ok).toBe(true);
    const [after] = await pending(patientId);
    // Sin CAS, el UPDATE con lo leído antes de la carrera habría perdido el email.
    expect(after.changes).toEqual({ phone: PHONE, email: "nuevo@pestana.test", coverage: { insurerName: "Swiss Medical" } });
  });

  it("el consultorio decidió la PENDING en el medio → la decidida queda intacta y se abre una nueva", async () => {
    const me = await account();
    const patientId = await linked(open, me.id);
    asUser(me.id);
    await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } });
    const [row] = await pending(patientId);
    const r = await withRaceAfterRead(
      () => db.patientChangeRequest.update({ where: { id: row.id }, data: { status: "APPROVED", decidedAt: new Date() } }),
      () => requestPortalProfileChange({ tenantSlug: open.slug, changes: { email: "yo@nuevo.test" } })
    );
    expect(r).toEqual({ ok: true, data: { fields: ["email"] } });
    const decided = await db.patientChangeRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(decided.status).toBe("APPROVED");
    expect(decided.changes).toEqual({ phone: PHONE });
    const open2 = await pending(patientId);
    expect(open2).toHaveLength(1);
    expect(open2[0].changes).toEqual({ email: "yo@nuevo.test" });
  });

  it("rate-limit 3/h por (cuenta, consultorio): el cuarto no escribe; otro consultorio sigue pudiendo", async () => {
    const me = await account();
    const patientId = await linked(open, me.id);
    const otherPatient = await linked(closed, me.id);
    asUser(me.id);
    for (const n of [1, 2, 3]) {
      expect((await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: `11-4000-000${n}` } })).ok).toBe(true);
    }
    const r = await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: "11-4000-0004" } });
    expect(r.ok).toBe(false);
    expect((await pending(patientId))[0].changes).toEqual({ phone: "11-4000-0003" });
    expect((await requestPortalProfileChange({ tenantSlug: closed.slug, changes: { phone: "11-4000-0005" } })).ok).toBe(true);
    expect(await pending(otherPatient)).toHaveLength(1);
  });

  it("rechazos sin escribir: consultorio suspendido, ficha sin vincular (mismo email), slug ajeno, staff, sin sesión", async () => {
    const me = await account();
    const susp = await linked(suspended, me.id);
    asUser(me.id);
    const r1 = await requestPortalProfileChange({ tenantSlug: suspended.slug, changes: { phone: PHONE } });
    expect(r1.ok).toBe(false);
    expect(await pending(susp)).toHaveLength(0);

    const unlinkedOwner = await account();
    const unlinked = await addPatient(db, open, { email: unlinkedOwner.email });
    asUser(unlinkedOwner.id);
    expect(await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } })).toEqual({
      ok: false,
      error: "No encontramos tu ficha en este consultorio. Volvé a Mis consultorios y probá de nuevo.",
    });
    expect(await pending(unlinked)).toHaveLength(0);

    // Vinculado en `closed`, pide sobre el slug de `open` (P-otro): no hay ficha suya ahí.
    const elsewhere = await account();
    await linked(closed, elsewhere.id);
    asUser(elsewhere.id);
    expect((await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } })).ok).toBe(false);

    // Staff (Membership) con una ficha vinculada: el portal no lo trata como paciente (AUDIT §5.22).
    const staffPatient = await linked(open, open.userId);
    asUser(open.userId);
    expect((await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } })).ok).toBe(false);
    expect(await pending(staffPatient)).toHaveLength(0);

    asAnonymous();
    expect((await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } })).ok).toBe(false);
    expect(await db.patientChangeRequest.count({ where: { tenantId: { in: [open.tenantId, suspended.tenantId] }, patientId: { in: [unlinked, staffPatient, susp] } } })).toBe(0);
  });

  it("validación del contrato: clave extra, grupo incompleto y pedido vacío → error claro, sin escribir", async () => {
    const me = await account();
    const patientId = await linked(open, me.id);
    asUser(me.id);
    expect((await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE, dni: "1" } })).ok).toBe(false);
    const ec = await requestPortalProfileChange({
      tenantSlug: open.slug,
      changes: { emergencyContact: { name: "Marta", phone: "" } },
    });
    expect(ec.ok === false && ec.fieldErrors?.emergencyContact).toEqual([
      "Para el contacto de emergencia necesitamos nombre y un teléfono (entre 6 y 30 caracteres).",
    ]);
    // ES4-Z B2: teléfono de 6 a 30 caracteres (antes «1» era un pedido válido).
    const short = await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: "12345" } });
    expect(short.ok === false && short.fieldErrors?.phone).toEqual([
      "Revisá el teléfono: tiene que tener entre 6 y 30 caracteres.",
    ]);
    const long = await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: "1".repeat(31) } });
    expect(long.ok).toBe(false);
    expect(await requestPortalProfileChange({ tenantSlug: open.slug, changes: {} })).toMatchObject({
      ok: false,
      error: "Completá al menos un dato para cambiar.",
    });
    expect(await pending(patientId)).toHaveLength(0);
  });

  it("form sin JS (useFormState): arma el pedido desde los campos; con error devuelve lo tipeado", async () => {
    const me = await account();
    const patientId = await linked(open, me.id);
    asUser(me.id);
    const fd = new FormData();
    fd.set("slug", open.slug);
    fd.set("email", "  Nuevo@Mail.Test ");
    fd.set("insurerName", "OSDE");
    fd.set("ecName", "");
    const ok = await submitPortalProfileChange(null, fd);
    expect(ok).toMatchObject({ status: "sent", slug: open.slug, fields: ["email", "coverage"] });
    expect((await pending(patientId))[0].changes).toEqual({
      email: "nuevo@mail.test",
      coverage: { insurerName: "OSDE", planName: null, memberId: null },
    });

    const bad = new FormData();
    bad.set("slug", open.slug);
    bad.set("ecName", "Marta");
    const err = await submitPortalProfileChange(null, bad);
    expect(err).toMatchObject({
      status: "error",
      error: "Para el contacto de emergencia necesitamos nombre y un teléfono (entre 6 y 30 caracteres).",
      values: { ecName: "Marta" },
    });
  });

  it("loadPortalProfile: pedidos abiertos con nombres de campo y sin valores; canBook por turnero", async () => {
    const me = await account();
    await linked(open, me.id);
    await linked(closed, me.id);
    asUser(me.id);
    await requestPortalProfileChange({ tenantSlug: open.slug, changes: { phone: PHONE } });
    const profile = await loadPortalProfile();
    expect(profile?.email).toBe(me.email);
    expect(profile?.tenants.map((t) => [t.slug, t.canBook]).sort()).toEqual(
      [
        [open.slug, true],
        [closed.slug, false],
      ].sort()
    );
    expect(profile?.pending).toEqual([{ slug: open.slug, fields: ["phone"], updatedAt: expect.any(String) }]);
    expect(JSON.stringify(profile)).not.toContain(PHONE);

    asAnonymous();
    expect(await loadPortalProfile()).toBeNull();
  });

  describe("«Cerrar sesión en todos lados»", () => {
    it("llama a signOut({ scope: 'global' }) y vuelve al portal", async () => {
      signOut.mockResolvedValue({ error: null });
      let digest = "";
      try {
        await signOutPortalEverywhere(null, new FormData());
      } catch (e) {
        digest = String((e as { digest?: unknown }).digest ?? "");
      }
      expect(signOut).toHaveBeenCalledWith({ scope: "global" });
      expect(digest.split(";")[2]).toBe("/portal");
    });

    it("si GoTrue devuelve { error }, lo muestra y no redirige", async () => {
      signOut.mockResolvedValue({ error: Object.assign(new Error("boom"), { name: "AuthRetryableFetchError", status: 0 }) });
      const r = await signOutPortalEverywhere(null, new FormData());
      expect(r).toEqual({
        status: "error",
        error: "No pudimos cerrar tus otras sesiones. Revisá tu conexión y probá de nuevo.",
      });
    });
  });
});
