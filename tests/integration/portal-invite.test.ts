/**
 * [P4-S24v] Invitación al portal y `/portal/vincular` (brief ES4 §3.4, PD-15).
 *
 * Contexto: desde S24a el portal autoriza por el vínculo (tenantId, userId), y el auto-vínculo por email se niega a
 * propósito con dos fichas del mismo email (`ambiguous`). La salida es la invitación del consultorio: un token HMAC de
 * 7 días que apunta a UNA ficha, y una página que vincula con un POST y el CAS de `linkPatientCas`.
 *
 * Acá se fija, con los símbolos reales (`linkPortalByInvite`, `submitPortalInvite`, la página) contra Postgres:
 *  - rechazos sin escribir: token vencido / alterado / de otro email, ficha de otra cuenta, staff, sin sesión, la cuenta
 *    ya tiene otra ficha en el consultorio, la ficha ya no tiene el email invitado;
 *  - dos usos del mismo token con la misma cuenta → idempotente (`already`, sin tocar `Patient.updatedAt`);
 *  - el GET de la página no escribe (ni con sesión lista para vincular);
 *  - los logs no llevan el token (`t=`) ni el email;
 *  - el caso que motiva la invitación: dos fichas `Ana@x` / `ana@x` → la invitación vincula la que eligió el consultorio.
 *
 * Fronteras mockeadas: la sesión de Supabase (tests/helpers/actor.ts vía integration-setup) y la consulta de
 * proveedores OAuth de la página (red a GoTrue).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { linkPortalByInvite, submitPortalInvite } from "@/lib/portal-vincular";
import { PORTAL_VINCULAR_ERRORS } from "@/lib/portal-vincular-copy";
import { makePortalInviteToken } from "@/lib/portal-invite-token";
import { requirePortalPatient } from "@/lib/portal-identity-internal";
import { logger } from "@/lib/logger";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asAnonymous, asUser } from "@/tests/helpers/actor";

vi.mock("@/lib/oauth-providers-public", () => ({ visibleOAuthProviders: async () => ["google"] }));

// La config de integración compila JSX con el runtime clásico (`React.createElement`) y no inyecta el import: la
// página se renderiza como función (server component) y alcanza con exponer React global.
import * as ReactNs from "react";
(globalThis as { React?: unknown }).React = ReactNs;

import PortalVincular from "@/app/(portal)/portal/vincular/page";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** `redirect()` de Next tira un error con `digest = "NEXT_REDIRECT;<tipo>;<url>;<status>"`. */
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? "";
    throw err;
  }
  throw new Error("no redirigió");
}

describe.skipIf(!RUN)("[P4-S24v] invitación al portal y /portal/vincular", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  const profiles: string[] = [];
  const logs: Array<[string, unknown]> = [];

  /** Cuenta de paciente (UserProfile, sin Membership) con sesión verificada. Email = `<id>@test.local`. */
  const account = async () => {
    const id = `test-inv-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
    profiles.push(id);
    return { id, email: `${id}@test.local` };
  };
  const invite = (patientId: string, t: EphemeralTenant, email: string, nowMs?: number) =>
    makePortalInviteToken({ patientId, tenantId: t.tenantId, email }, nowMs);
  const snapshot = async (patientId: string) => {
    const p = await db.patient.findUniqueOrThrow({ where: { id: patientId }, select: { userId: true, updatedAt: true } });
    const links = await db.patientTenantLink.count({ where: { patientId } });
    return { ...p, links };
  };

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (profiles.length) await db.userProfile.deleteMany({ where: { id: { in: profiles } } });
    await db?.$disconnect();
  });
  beforeEach(() => {
    __rateLimitInternals.reset();
    logs.length = 0;
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

  it("vincula la ficha de la invitación y devuelve el slug; requirePortalPatient la ve", async () => {
    const me = await account();
    const patientId = await addPatient(db, A, { email: me.email });
    const t = invite(patientId, A, me.email);
    asUser(me.id);

    expect(await linkPortalByInvite(form({ t }))).toEqual({ ok: true, data: { slug: A.slug } });
    const after = await snapshot(patientId);
    expect(after.userId).toBe(me.id);
    expect(after.links).toBe(1);
    expect((await requirePortalPatient(A.slug))?.patientId).toBe(patientId);
  });

  it("dos usos del mismo token por la misma cuenta → idempotente (already), sin reescribir la ficha", async () => {
    const me = await account();
    const patientId = await addPatient(db, A, { email: me.email });
    const t = invite(patientId, A, me.email);
    asUser(me.id);

    expect((await linkPortalByInvite(form({ t }))).ok).toBe(true);
    const first = await snapshot(patientId);
    expect(await linkPortalByInvite(form({ t }))).toEqual({ ok: true, data: { slug: A.slug } });
    const second = await snapshot(patientId);
    expect(second).toEqual(first);
    expect(logs.filter(([m]) => m === "portal.invite.linked").map(([, c]) => (c as { outcome: string }).outcome)).toEqual([
      "linked",
      "already",
    ]);
  });

  it("dos fichas Ana@x / ana@x (auto-vínculo: ambiguous) → la invitación vincula la que eligió el consultorio", async () => {
    const me = await account();
    const p1 = await addPatient(db, A, { email: me.email });
    const p2 = await addPatient(db, A, { email: me.email.toUpperCase() });
    asUser(me.id);

    expect((await linkPortalByInvite(form({ t: invite(p2, A, me.email.toUpperCase()) }))).ok).toBe(true);
    expect((await snapshot(p1)).userId).toBeNull();
    expect((await snapshot(p2)).userId).toBe(me.id);
  });

  describe("rechazos sin escribir", () => {
    const expectNoWrite = async (patientId: string, before: Awaited<ReturnType<typeof snapshot>>) => {
      expect(await snapshot(patientId)).toEqual(before);
    };

    it("token vencido (7 d + 1 s), alterado o basura → invitación inválida", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      asUser(me.id);
      const before = await snapshot(patientId);
      const expired = invite(patientId, A, me.email, Date.now() - 7 * DAY - 1000);
      const tampered = invite(patientId, A, me.email).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
      for (const t of [expired, tampered, "basura", ""]) {
        expect(await linkPortalByInvite(form({ t }))).toEqual({ ok: false, error: PORTAL_VINCULAR_ERRORS.invalid });
      }
      await expectNoWrite(patientId, before);
    });

    it("token de otro email (link reenviado a otra cuenta) → otra cuenta", async () => {
      const owner = await account();
      const intruder = await account();
      const patientId = await addPatient(db, A, { email: owner.email });
      asUser(intruder.id);
      const before = await snapshot(patientId);
      expect(await linkPortalByInvite(form({ t: invite(patientId, A, owner.email) }))).toEqual({
        ok: false,
        error: PORTAL_VINCULAR_ERRORS.other_email,
      });
      await expectNoWrite(patientId, before);
    });

    it("ficha ya vinculada a otra cuenta → rechazo, el vínculo no se toca", async () => {
      const owner = await account();
      const me = await account();
      // La ficha tiene MI email (el consultorio lo corrigió) pero quedó vinculada a la cuenta anterior.
      const patientId = await addPatient(db, A, { email: me.email });
      await db.patient.update({ where: { id: patientId }, data: { userId: owner.id } });
      asUser(me.id);
      const before = await snapshot(patientId);
      expect(await linkPortalByInvite(form({ t: invite(patientId, A, me.email) }))).toEqual({
        ok: false,
        error: PORTAL_VINCULAR_ERRORS.linked_elsewhere,
      });
      await expectNoWrite(patientId, before);
      expect(before.userId).toBe(owner.id);
    });

    it("staff (Membership en cualquier consultorio) → rechazo (AUDIT §5.22)", async () => {
      const staffEmail = `${A.userId}@test.local`;
      const patientId = await addPatient(db, B, { email: staffEmail });
      asUser(A.userId);
      const before = await snapshot(patientId);
      expect(await linkPortalByInvite(form({ t: invite(patientId, B, staffEmail) }))).toEqual({
        ok: false,
        error: PORTAL_VINCULAR_ERRORS.staff,
      });
      await expectNoWrite(patientId, before);
    });

    it("sin sesión → pide entrar", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      asAnonymous();
      const before = await snapshot(patientId);
      expect(await linkPortalByInvite(form({ t: invite(patientId, A, me.email) }))).toEqual({
        ok: false,
        error: PORTAL_VINCULAR_ERRORS.session,
      });
      await expectNoWrite(patientId, before);
    });

    it("la cuenta ya tiene otra ficha en ese consultorio (único (tenantId, userId)) → conflict, sin P2002", async () => {
      const me = await account();
      const mine = await addPatient(db, A, { email: me.email });
      await db.patient.update({ where: { id: mine }, data: { userId: me.id } });
      const other = await addPatient(db, A, { email: me.email.toUpperCase() });
      asUser(me.id);
      const before = await snapshot(other);
      expect(await linkPortalByInvite(form({ t: invite(other, A, me.email) }))).toEqual({
        ok: false,
        error: PORTAL_VINCULAR_ERRORS.conflict,
      });
      await expectNoWrite(other, before);
    });

    it("el consultorio cambió el email de la ficha después de invitar → la invitación vieja deja de valer", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      const t = invite(patientId, A, me.email);
      await db.patient.update({ where: { id: patientId }, data: { email: `corregido-${uniqueSuffix()}@test.local` } });
      asUser(me.id);
      const before = await snapshot(patientId);
      expect(await linkPortalByInvite(form({ t }))).toEqual({ ok: false, error: PORTAL_VINCULAR_ERRORS.invalid });
      await expectNoWrite(patientId, before);
    });

    it("token de un consultorio con el patientId de otro → no encuentra la ficha (el par se valida)", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      asUser(me.id);
      const before = await snapshot(patientId);
      expect(await linkPortalByInvite(form({ t: invite(patientId, B, me.email) }))).toEqual({
        ok: false,
        error: PORTAL_VINCULAR_ERRORS.not_found,
      });
      await expectNoWrite(patientId, before);
    });

    it("rate limit: 10 intentos por hora por cuenta", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      asUser(me.id);
      for (let i = 0; i < 10; i++) await linkPortalByInvite(form({ t: "basura-que-igual-cuenta" }));
      // Los inválidos cortan antes del límite (no consumen cupo): se consume con tokens válidos de otro email.
      const other = invite(patientId, A, `otro-${uniqueSuffix()}@test.local`);
      for (let i = 0; i < 10; i++) {
        expect((await linkPortalByInvite(form({ t: other }))).ok).toBe(false);
      }
      expect(await linkPortalByInvite(form({ t: invite(patientId, A, me.email) }))).toEqual({
        ok: false,
        error: PORTAL_VINCULAR_ERRORS.rate_limited,
      });
      expect((await snapshot(patientId)).userId).toBeNull();
    });
  });

  describe("form sin JS (submitPortalInvite)", () => {
    it("vinculada → redirect a /portal/c/<slug>; error → vuelve a la página con ?e=<código> (nunca texto libre)", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      const t = invite(patientId, A, me.email);

      const intruder = await account();
      asUser(intruder.id);
      const back = new URL(await redirectOf(submitPortalInvite(form({ t }))), "http://x");
      expect(back.pathname).toBe("/portal/vincular");
      expect(back.searchParams.get("t")).toBe(t);
      expect(back.searchParams.get("e")).toBe("other_email");

      asUser(me.id);
      expect(await redirectOf(submitPortalInvite(form({ t })))).toBe(`/portal/c/${A.slug}?vinculado=1`);
      expect((await snapshot(patientId)).userId).toBe(me.id);

      expect(await redirectOf(submitPortalInvite(form({})))).toBe("/portal");
    });
  });

  describe("GET de /portal/vincular", () => {
    type El = { type: unknown; props: { title?: string; children?: unknown } };
    /** Título de la tarjeta: `Shell` lo recibe directo; un estado envuelto (`InvalidInvite`) se expande un nivel. */
    const titleOf = (el: El): string | undefined =>
      el.props.title ?? (typeof el.type === "function" ? (el.type as (p: unknown) => El)(el.props).props.title : undefined);

    it("no escribe: ni sin sesión, ni con la sesión correcta lista para vincular, ni con otra cuenta", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      const t = invite(patientId, A, me.email);
      const before = await snapshot(patientId);

      asAnonymous();
      expect(titleOf((await PortalVincular({ searchParams: { t } })) as El)).toBe("Entrá para vincular tu ficha");
      asUser(me.id);
      expect(titleOf((await PortalVincular({ searchParams: { t } })) as El)).toBe("Vinculá tu ficha");
      const other = await account();
      asUser(other.id);
      expect(titleOf((await PortalVincular({ searchParams: { t } })) as El)).toBe(
        "Esta invitación es para otro email"
      );

      expect(await snapshot(patientId)).toEqual(before);
      expect(before.userId).toBeNull();
    });

    it("token vencido → aviso de invitación inválida; ya vinculada → «Tu ficha ya está vinculada»", async () => {
      const me = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      asUser(me.id);
      const expired = invite(patientId, A, me.email, Date.now() - 8 * DAY);
      expect(titleOf((await PortalVincular({ searchParams: { t: expired } })) as El)).toBe(
        "No pudimos usar esta invitación"
      );
      const t = invite(patientId, A, me.email);
      await linkPortalByInvite(form({ t }));
      expect(titleOf((await PortalVincular({ searchParams: { t } })) as El)).toBe("Tu ficha ya está vinculada");
    });

    it("[ES4-Z] ficha ya vinculada a OTRA cuenta → sin form desde el GET; ?e=conflict tampoco ofrece reintentar", async () => {
      const me = await account();
      const other = await account();
      const patientId = await addPatient(db, A, { email: me.email });
      await db.patient.update({ where: { id: patientId }, data: { userId: other.id } });
      const t = invite(patientId, A, me.email);
      asUser(me.id);
      expect(titleOf((await PortalVincular({ searchParams: { t } })) as El)).toBe("No pudimos vincular tu ficha");
      const free = await addPatient(db, A, { email: me.email.toUpperCase() });
      const t2 = invite(free, A, me.email.toUpperCase());
      expect(titleOf((await PortalVincular({ searchParams: { t: t2, e: "conflict" } })) as El)).toBe(
        "No pudimos vincular tu ficha"
      );
      expect(titleOf((await PortalVincular({ searchParams: { t: t2 } })) as El)).toBe("Vinculá tu ficha");
    });
  });

  it("los logs no llevan el token (t=) ni el email", async () => {
    const me = await account();
    const intruder = await account();
    const patientId = await addPatient(db, A, { email: me.email });
    const t = invite(patientId, A, me.email);
    const expired = invite(patientId, A, me.email, Date.now() - 8 * DAY);

    asUser(intruder.id);
    await linkPortalByInvite(form({ t }));
    await redirectOf(submitPortalInvite(form({ t })));
    await linkPortalByInvite(form({ t: expired }));
    asUser(me.id);
    await linkPortalByInvite(form({ t }));
    await linkPortalByInvite(form({ t }));

    const kinds = logs.map(([m]) => m);
    expect(kinds).toContain("portal.invite.refused");
    expect(kinds).toContain("portal.invite.linked");
    const dump = JSON.stringify(logs);
    for (const secret of [t, expired, t.split(".")[0], t.split(".")[1], "t=", me.email, intruder.email]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toContain("@");
  });
});
