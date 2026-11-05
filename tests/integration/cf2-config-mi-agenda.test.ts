/**
 * [CF2-TL] Pestaña personal «Mi agenda» de `/configuracion` (brief CF2 T.C) y la anticipación por profesional en
 * Profesionales (T.A), sobre el loader REAL (`loadConfiguracionPage(actor, caps)`, como la página).
 *
 * Qué se fija:
 *   1. Quién la recibe: el miembro clínico con profesional propio (mismo gate que «Mis fichas»); la Secretaria (aun con
 *      «Configuración») y el soporte no (null).
 *   2. Shape: las columnas de M21 del profesional PROPIO tal cual están en la base (nunca las de otro), el switch
 *      propio del turnero (el mismo dato que lee el layout), la anticipación del consultorio para «Usar la del
 *      consultorio (N)» y el estado del turnero del consultorio.
 *   3. Presupuesto: sin tx nueva; el Titular y el ADMIN, 0 sentencias nuevas (la anticipación del consultorio ya viene en
 *      la fila del Tenant); el Profesional sin delegaciones, +1 (no lee el Tenant: ver la cabecera del loader).
 *   4. Profesionales: cada fila del resumen trae su `publicMinLeadMinutes` y el del consultorio, del select de siempre.
 *   5. Aislamiento: nada del otro consultorio (en el rol owner BYPASSRLS el `where: { tenantId }` es la única barrera).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

// Entrar como soporte pide el step-up de 2FA; se da por hecho (el corte real lo prueba two-factor.test.ts).
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

import type { PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import { measure } from "@/tests/helpers/query-counter";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";

const RUN = process.env.INTEGRATION === "1";

/** Fechas a string como las ve el cliente (props serializadas). */
const plain = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe.skipIf(!RUN)("[CF2-TL] /configuracion: «Mi agenda» y la anticipación por profesional", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let U: EphemeralTenant;
  let pro: { userId: string; practitionerId: string };
  let secretaryUserId: string;
  const consentAt = new Date("2026-11-01T13:00:00.000Z");

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    U = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    pro = await addPractitioner(db, T, "PRACTITIONER");
    secretaryUserId = (await addStaff(db, T, "ASSISTANT", { grantSettings: true })).userId;
    await db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: true, publicMinLeadMinutes: 120 } });
    await db.practitioner.update({
      where: { id: pro.practitionerId },
      data: {
        publicBookingEnabled: true,
        publicMinLeadMinutes: 180,
        contactWhatsapp: "+5491155550101",
        showContactInLeadWindow: true,
        contactConsentAt: consentAt,
        contactConsentVersion: "cf2-lead-contact-v1",
        notifyBookingEmail: true,
        notifyBookingPush: false,
      },
    });
    // Del otro consultorio, con valores que no se tienen que colar en T.
    await db.tenant.update({ where: { id: U.tenantId }, data: { publicMinLeadMinutes: 999 } });
    await db.practitioner.update({
      where: { id: U.practitionerId },
      data: { publicMinLeadMinutes: 777, contactWhatsapp: "+5491199990202", notifyBookingPush: true },
    });
  }, 60_000);

  afterAll(async () => {
    if (db) {
      for (const t of [T, U]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  async function load(userId: string) {
    asUser(userId);
    const actor = await getActor();
    const caps = await capabilitiesForActor(actor);
    return measure(() => loadConfiguracionPage(actor, caps));
  }

  it("[CF2-TL1] Profesional sin delegaciones: «Mi agenda» con sus columnas y la anticipación del consultorio (1 tx, +1 sentencia)", async () => {
    const { result: r, m } = await load(pro.userId);
    console.info(`[CF2-TL1] /configuracion Profesional: ${m.transactions} tx · ${m.statements} sentencias (app ${m.byClient.app} · service ${m.byClient.service})`);
    expect(m.transactions).toBeLessThanOrEqual(1);
    // +1 declarada: la anticipación del consultorio (el Profesional sin delegaciones no lee la fila del Tenant).
    // [CT-L] +1 más DECLARADA (05-nov): la matrícula de la persona para «Mi agenda» (UserProfile, `ownLicenseInTx`).
    expect(m.statements).toBeLessThanOrEqual(PRO_BASELINE_STATEMENTS + 2);
    expect(plain(r.miAgenda)).toEqual({
      practitionerId: pro.practitionerId,
      name: expect.any(String),
      publicBookingEnabled: true,
      tenantPublicBookingEnabled: true,
      publicMinLeadMinutes: 180,
      tenantPublicMinLeadMinutes: 120,
      contactWhatsapp: "+5491155550101",
      showContactInLeadWindow: true,
      contactConsentAt: consentAt.toISOString(),
      notifyBookingEmail: true,
      notifyBookingPush: false,
      // CF3 AU-C (D-CF3-3/5/12): los switches de M22 (defaults) y el link propio, sin sentencias nuevas.
      ownPublicBookingEnabled: true,
      showPublicPrice: true,
      showContactForInsured: false,
      tenantSlug: T.slug,
      bookingUrl: `/c/${T.slug}/booking?pro=${pro.practitionerId}`,
      // CF3b CT-L (M23): la matrícula de la persona (no cargó).
      license: { license: null, updatedAt: null },
      // CF3b PH-S (M24): la foto de la persona (no subió) y el opt-in de este consultorio (default false). 0 sentencias:
      // viaja en la misma lectura de UserProfile que la matrícula y en el select del profesional.
      photo: { url: null, showPublic: false },
    });
    // El nombre es el del actor (el mismo que ve en la agenda), nunca el email.
    expect(r.miAgenda?.name).not.toContain("@");
    const blob = JSON.stringify(r.miAgenda);
    expect(blob).not.toContain(U.practitionerId);
    expect(blob).not.toMatch(/999|777|5491199990202/);
  });

  it("[CF2-TL2] Titular: «Mi agenda» sin sentencias nuevas (la anticipación del consultorio sale de la fila del Tenant)", async () => {
    const { result: r, m } = await load(T.userId);
    expect(m.transactions).toBeLessThanOrEqual(3);
    // Mismo techo que pf2-config-budget (42): «Mi agenda» y la anticipación de Profesionales son columnas de selects
    // que ya corrían.
    // [CT-L] 42 → 43: la matrícula de la persona, +1 declarada (también en pf2-config-budget).
    expect(m.statements).toBeLessThanOrEqual(43);
    expect(r.miAgenda).toMatchObject({
      practitionerId: T.practitionerId,
      publicMinLeadMinutes: null,
      tenantPublicMinLeadMinutes: 120,
      contactWhatsapp: null,
      showContactInLeadWindow: false,
      contactConsentAt: null,
      notifyBookingEmail: false,
      notifyBookingPush: false,
    });
  });

  it("[CF2-TL3] Profesionales: cada fila del resumen trae su anticipación y la del consultorio", async () => {
    const { result: r } = await load(T.userId);
    const by = Object.fromEntries(r.scheduleSummary.map((s) => [s.practitionerId, s.publicLead]));
    expect(by[pro.practitionerId]).toEqual({ own: 180, tenant: 120 });
    expect(by[T.practitionerId]).toEqual({ own: null, tenant: 120 });
    expect(Object.keys(by)).not.toContain(U.practitionerId);
  });

  it("[CF2-TL4] la Secretaria con «Configuración» y el soporte no reciben «Mi agenda»", async () => {
    const s = await load(secretaryUserId);
    expect(s.result.miAgenda).toBeNull();
    expect(s.result.fichas).toBeNull();

    const H = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    try {
      cookies().delete(SUPPORT_COOKIE);
      asUser(H.userId);
      const started = await startSupport(T.tenantId, "Revisar Mi agenda (CF2-TL)");
      if (!started.ok) throw new Error(started.error);
      const actor = await getActor();
      expect(actor.support).toBeTruthy();
      const r = await loadConfiguracionPage(actor, await capabilitiesForActor(actor));
      expect(r.miAgenda).toBeNull();
    } finally {
      cookies().delete(SUPPORT_COOKIE);
      await db.supportSession.deleteMany({ where: { superadminId: H.userId } });
      await H.cleanup();
    }
  });
});

/** Sentencias del Profesional sin delegaciones ANTES de CF2 (medido el 02-nov sobre el loader de 476bdf5). */
const PRO_BASELINE_STATEMENTS = 3;
