/**
 * [P4-S24p] Estado de cuenta del portal (`/portal/c/<slug>/cuenta`): saldo de los planes (P7) + turnos sueltos.
 *
 * Es plata vista por el paciente por el canal service (BYPASSRLS): lo que se prueba es
 *   - que un monto sale SOLO de una fuente explícita (`Booking.copagoCents` estampado / override / congelado al
 *     cobrar, o el precio pactado del plan). Una obra social sin copago no inventa un $0 ni cae al precio de lista del
 *     servicio: «A confirmar en el consultorio»;
 *   - que el DTO va por allowlist: ninguna clave fuera de la forma de `PortalAccountDTO` (ni `osAmountCents`, ni el
 *     arancel, ni el `priceCents` del Service, ni notas);
 *   - que todo va acotado por (tenantId, patientId) del vínculo: el plan de otro paciente del mismo consultorio no
 *     aparece, y sin vínculo no hay nada (la page responde 404);
 *   - gate por módulo: en Clínica general (sin `planes`) no hay sección de planes aunque haya filas legacy;
 *   - la UI formatea con `formatARS` y fechas en hora AR (corre en TZ=UTC: un turno a las 02:30Z es del día anterior).
 *
 * Símbolos reales (`getPortalAccount`, `AccountStatement`); solo se mockea la sesión de Supabase (tests/helpers/actor.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getPortalAccount } from "@/lib/portal-account";
import { AccountStatement } from "@/components/portal/account-statement";
import { formatARS } from "@/lib/format";
import type { PortalAccountDTO } from "@/lib/portal-account-types";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
// vitest.integration.config.ts no configura el JSX automático (los tests de integración no renderizan): el componente
// compila a `React.createElement` clásico, así que se expone React como global solo para este render.
(globalThis as unknown as { React: typeof React }).React = React;
const DAY = 86_400_000;

/**
 * Allowlist literal de `PortalAccountDTO` (brief ES4 §3.5). El test recorre el DTO entero: cualquier clave que no esté
 * acá (un `osAmountCents`, un `priceCents` del Service, `notes`, `insurer*`) lo rompe, aunque la UI no la pinte — el
 * payload RSC viaja igual al navegador.
 */
const ALLOWED_KEYS = new Set([
  // raíz
  "plans",
  "looseBookings",
  "totals",
  // plans[]
  "programId",
  "title",
  "sessionWord",
  "agreed",
  "collectedCents",
  "pendingCents",
  "creditCents",
  "inProcessCents",
  // looseBookings[]
  "id",
  "date",
  "serviceName",
  "amount",
  "paid",
  "inProcess",
  "pending",
  "cancelled",
  // PortalMoney
  "kind",
  "cents",
]);

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

describe.skipIf(!RUN)("[P4-S24p] portal · estado de cuenta", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kinesiología (tiene `planes`)
  let G: EphemeralTenant; // Clínica general (sin `planes`)
  const profiles: string[] = [];

  let me: { id: string; email: string };
  let mePatientK: string;
  let otherPatientK: string;
  let mePatientG: string;
  let myPlanId: string;
  let otherPlanId: string;
  let legacyPlanG: string;
  const ids: Record<string, string> = {};
  let tzBookingAt: Date;

  const account = async () => {
    const id = `test-pid-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
    profiles.push(id);
    return { id, email: `${id}@test.local` };
  };

  // Horario distinto por turno: el índice único parcial de turnos activos no es lo que se prueba acá.
  let slot = 0;
  const at = (daysFromNow: number) => {
    slot += 1;
    return new Date(Date.now() + daysFromNow * DAY + slot * 3_600_000);
  };

  const booking = (
    t: EphemeralTenant,
    patientId: string,
    data: {
      scheduledFor: Date;
      copagoCents?: number | null;
      status?: "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";
      paymentStatus?: "UNPAID" | "AUTHORIZED" | "PAID" | "REFUNDED" | "FAILED";
      programId?: string;
      sessionId?: string;
      pricedByPlan?: boolean;
    }
  ) =>
    db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        practitionerId: t.practitionerId,
        serviceId: t.serviceId,
        durationMin: 45,
        idempotencyKey: `s24p-${uniqueSuffix()}`,
        notes: "nota interna del consultorio",
        ...data,
      },
      select: { id: true },
    });

  /** Plan por sesión de $1.000: 3 sesiones, 2 realizadas (1 cobrada, 1 no). Saldo: pactado 3.000, pendiente 1.000. */
  const pricedPlan = async (t: EphemeralTenant, patientId: string, title: string) => {
    const program = await db.treatmentProgram.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        title,
        startDate: new Date(Date.now() - 30 * DAY),
        pricingMode: "PER_SESSION",
        pricePerSessionCents: 100_000,
        notes: "nota clínica del plan",
      },
    });
    const sessions = [];
    for (const index of [1, 2, 3]) {
      sessions.push(
        await db.session.create({
          data: {
            programId: program.id,
            practitionerId: t.practitionerId,
            index,
            scheduledFor: at(index - 20),
            completedAt: index < 3 ? new Date() : null,
            priceCents: 100_000,
            notes: "nota de sesión",
          },
        })
      );
    }
    await booking(t, patientId, {
      scheduledFor: sessions[0].scheduledFor,
      status: "COMPLETED",
      paymentStatus: "PAID",
      copagoCents: 100_000,
      programId: program.id,
      sessionId: sessions[0].id,
      pricedByPlan: true,
    });
    await booking(t, patientId, {
      scheduledFor: sessions[1].scheduledFor,
      status: "COMPLETED",
      paymentStatus: "UNPAID",
      copagoCents: 100_000,
      programId: program.id,
      sessionId: sessions[1].id,
      pricedByPlan: true,
    });
    return program.id;
  };

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    me = await account();

    mePatientK = await addPatient(db, K, { email: me.email });
    await db.patient.update({ where: { id: mePatientK }, data: { userId: me.id } });
    otherPatientK = await addPatient(db, K);
    mePatientG = await addPatient(db, G, { email: me.email });
    await db.patient.update({ where: { id: mePatientG }, data: { userId: me.id } });

    // Obra social SIN copago configurado (Insurer.copagoCents nace en 0): para el paciente no hay cifra honesta.
    const osId = await addInsurer(db, K, { name: `OSDE ${uniqueSuffix()}`, fixedFeeCents: 900_000 });
    await db.coverage.create({ data: { patientId: mePatientK, insurer: "OSDE", insurerId: osId } });

    myPlanId = await pricedPlan(K, mePatientK, "Plan lumbar");
    otherPlanId = await pricedPlan(K, otherPatientK, "Plan de otro paciente");

    // Turnos sueltos (sin plan) del paciente en K.
    ids.osNoCopago = (await booking(K, mePatientK, { scheduledFor: at(-5), status: "COMPLETED", copagoCents: null })).id;
    // 02:30Z de hace 10 días = 23:30 AR del día anterior (el test corre en TZ=UTC).
    const d = new Date(Date.now() - 10 * DAY);
    tzBookingAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 2, 30));
    ids.paid = (
      await booking(K, mePatientK, {
        scheduledFor: tzBookingAt,
        status: "COMPLETED",
        paymentStatus: "PAID",
        copagoCents: 250_000,
      })
    ).id;
    ids.unpaid = (
      await booking(K, mePatientK, { scheduledFor: at(-3), status: "COMPLETED", copagoCents: 150_000 })
    ).id;
    ids.future = (await booking(K, mePatientK, { scheduledFor: at(7), status: "CONFIRMED", copagoCents: 80_000 })).id;
    ids.cancelled = (
      await booking(K, mePatientK, { scheduledFor: at(-4), status: "CANCELLED", copagoCents: 70_000 })
    ).id;
    ids.old = (
      await booking(K, mePatientK, { scheduledFor: at(-400), status: "COMPLETED", copagoCents: 60_000 })
    ).id;
    // Del otro paciente del mismo consultorio: nunca aparece.
    // ES4-Z B3: REFUNDED no reabre deuda; AUTHORIZED (por el Payment de MP) está en proceso; cancelado con cobro.
    ids.refunded = (
      await booking(K, mePatientK, { scheduledFor: at(-6), status: "COMPLETED", paymentStatus: "REFUNDED", copagoCents: 33_000 })
    ).id;
    ids.authorized = (
      await booking(K, mePatientK, { scheduledFor: at(-7), status: "COMPLETED", copagoCents: 44_000 })
    ).id;
    await db.payment.create({ data: { bookingId: ids.authorized, status: "AUTHORIZED", amountCents: 0 } });
    ids.cancelledPaid = (
      await booking(K, mePatientK, { scheduledFor: at(-8), status: "CANCELLED", paymentStatus: "PAID", copagoCents: 55_000 })
    ).id;
    ids.otherLoose = (
      await booking(K, otherPatientK, { scheduledFor: at(-2), status: "COMPLETED", copagoCents: 99_000 })
    ).id;

    // Clínica general: un plan legacy (fila que existe aunque el módulo no) + un turno suelto.
    legacyPlanG = (
      await db.treatmentProgram.create({
        data: { tenantId: G.tenantId, patientId: mePatientG, title: "Legacy", startDate: new Date() },
      })
    ).id;
    ids.general = (await booking(G, mePatientG, { scheduledFor: at(-1), status: "COMPLETED", copagoCents: 40_000 })).id;
  });

  afterAll(async () => {
    await K?.cleanup();
    await G?.cleanup();
    if (profiles.length) await db.userProfile.deleteMany({ where: { id: { in: profiles } } });
    await db?.$disconnect();
  });

  it("[P4-S24p] OS sin copago → sin monto", async () => {
    asUser(me.id);
    const acc = await getPortalAccount(K.slug);
    expect(acc).not.toBeNull();
    const row = acc!.looseBookings.find((b) => b.id === ids.osNoCopago);
    expect(row).toBeDefined();
    // Ni $0 (Insurer.copagoCents = 0 por default) ni el precio del servicio ($50): a confirmar.
    expect(row!.amount).toEqual({ kind: "to_confirm" });
    expect(row!.paid).toBe(false);
  });

  it("[P4-S24p] el DTO no tiene osAmountCents", async () => {
    asUser(me.id);
    for (const slug of [K.slug, G.slug]) {
      const acc = await getPortalAccount(slug);
      expect(acc).not.toBeNull();
      const keys = allKeys(acc);
      expect(keys.filter((k) => !ALLOWED_KEYS.has(k))).toEqual([]);
      const json = JSON.stringify(acc);
      for (const banned of ["osAmountCents", "fixedFee", "listPriceCents", "priceCents\"", "notes", "insurer", "nota"]) {
        expect(json).not.toContain(banned);
      }
      // El arancel de la OS ($9.000) no viaja.
      expect(json).not.toContain("900000");
    }
  });

  it("[P4-S24p] plan de otro paciente del mismo tenant no aparece", async () => {
    asUser(me.id);
    const acc = (await getPortalAccount(K.slug))!;
    expect(acc.plans.map((p) => p.programId)).toEqual([myPlanId]);
    expect(acc.plans.map((p) => p.programId)).not.toContain(otherPlanId);
    expect(acc.looseBookings.map((b) => b.id)).not.toContain(ids.otherLoose);
  });

  it("[P4-S24p] saldo del plan = P7 (balanceOf) y turnos sueltos por fuente explícita", async () => {
    asUser(me.id);
    const acc = (await getPortalAccount(K.slug))!;
    expect(acc.plans).toEqual([
      {
        programId: myPlanId,
        title: "Plan lumbar",
        sessionWord: "sesión",
        agreed: { kind: "amount", cents: 300_000 },
        collectedCents: 100_000,
        pendingCents: 100_000,
        creditCents: 0,
        inProcessCents: 0,
      },
    ]);
    // Ventana ES4-D7: últimos 12 meses + futuros; sin los cancelados no cobrados; solo turnos sin plan.
    const byId = new Map(acc.looseBookings.map((b) => [b.id, b]));
    expect([...byId.keys()].sort()).toEqual(
      [ids.osNoCopago, ids.paid, ids.unpaid, ids.future, ids.refunded, ids.authorized, ids.cancelledPaid].sort()
    );
    expect(byId.get(ids.unpaid)).toMatchObject({ pending: true, inProcess: false, cancelled: false });
    expect(byId.get(ids.refunded)).toMatchObject({ paid: false, pending: false, inProcess: false });
    expect(byId.get(ids.authorized)).toMatchObject({ paid: false, pending: false, inProcess: true });
    expect(byId.get(ids.cancelledPaid)).toMatchObject({ paid: true, pending: false, cancelled: true });
    expect(byId.get(ids.paid)).toMatchObject({ amount: { kind: "amount", cents: 250_000 }, paid: true, serviceName: "Consulta" });
    expect(byId.get(ids.unpaid)).toMatchObject({ amount: { kind: "amount", cents: 150_000 }, paid: false });
    expect(byId.get(ids.paid)!.date).toBe(tzBookingAt.toISOString());
    // Pendiente total = plan (1.000) + suelto realizado no cobrado (1.500). El futuro y el «a confirmar» no suman.
    expect(acc.totals).toEqual({ pendingCents: 250_000, creditCents: 0 });
  });

  it("[P4-S24p] Clínica general: sin sección de planes (gate `planes`), con turnos sueltos", async () => {
    asUser(me.id);
    const acc = (await getPortalAccount(G.slug))!;
    expect(acc.plans).toEqual([]);
    expect(JSON.stringify(acc)).not.toContain(legacyPlanG);
    expect(acc.looseBookings.map((b) => b.id)).toEqual([ids.general]);
    expect(acc.totals).toEqual({ pendingCents: 40_000, creditCents: 0 });
  });

  it("[P4-S24p] sin vínculo → null (la page responde 404), aunque la ficha tenga el email de la cuenta", async () => {
    const stranger = await account();
    await addPatient(db, K, { email: stranger.email }); // misma dirección, sin userId
    asUser(stranger.id);
    expect(await getPortalAccount(K.slug)).toBeNull();
    // Staff del consultorio tampoco es paciente (AUDIT §5.22).
    asUser(K.userId);
    expect(await getPortalAccount(K.slug)).toBeNull();
    // Slug inexistente.
    asUser(me.id);
    expect(await getPortalAccount(`no-existe-${uniqueSuffix()}`)).toBeNull();
  });

  it("[P4-S24p] la UI usa formatARS y fechas AR (TZ=UTC)", async () => {
    asUser(me.id);
    const acc: PortalAccountDTO = (await getPortalAccount(K.slug))!;
    const html = renderToStaticMarkup(
      createElement(AccountStatement, { account: acc, vertical: "KINESIOLOGY", showPlans: true, nowMs: Date.now() })
    );
    expect(html).toContain(formatARS(250_000)); // pendiente total y turno cobrado
    expect(html).toContain(formatARS(300_000)); // pactado del plan
    expect(html).toContain("A confirmar en el consultorio");
    expect(html).toContain("Pago en proceso");
    expect(html).toContain("A pagar");
    expect(html).not.toContain("250000");
    // 02:30Z → día anterior en AR. Con la fecha UTC del host mostraría otro día.
    const opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" };
    const ar = tzBookingAt.toLocaleDateString("es-AR", { ...opts, timeZone: "America/Argentina/Buenos_Aires" });
    const utc = tzBookingAt.toLocaleDateString("es-AR", { ...opts, timeZone: "UTC" });
    expect(ar).not.toBe(utc);
    expect(html).toContain(ar);
    expect(html).not.toContain(utc);
  });
});
