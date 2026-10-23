/**
 * MPS-3c (T6, C-MPS12): mails de Mercado Pago de la suscripción.
 *  - Plantillas puras (`lib/email/templates-billing.ts`): copy literal del brief, montos con `formatARS`, fechas AR
 *    aunque el host corra en UTC (correr con TZ=UTC), sin PHI (solo consultorio, montos, fechas y plan).
 *  - `billing_charge_created` con `collection`: «Se debita el 4…» con débito, «Pagá hasta el 9…» sin débito; sin el
 *    parámetro, el texto de antes (los llamadores existentes no cambian).
 *  - `sendSaasBillingMpMail` (símbolo real): destinatarios de facturación, idempotencia por clave en
 *    `PlatformAuditEvent.idempotencyKey` (acá, un Set que imita el UNIQUE), nunca tira. Se mockean solo los bordes
 *    (DB, audit, el núcleo de envío): importar el núcleo real en unit trae Prisma.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  billingCancelScheduledEmail,
  billingCancelledEmail,
  billingChargeCreatedEmail,
  billingDebitActivatedEmail,
  billingDebitFailedEmail,
  billingPlanChangeEmail,
} from "@/lib/email/templates-billing";
import type { RenderedEmail } from "@/lib/email/types";
import { formatARS } from "@/lib/format";

const URL = "https://app.kinesoft.com.ar/configuracion?tab=facturacion";
const TENANT = "Kine Centro";

/** Nada clínico ni de pacientes en un mail que lee cualquiera con acceso al buzón. */
function expectNoPhi(m: RenderedEmail) {
  const all = `${m.subject}\n${m.text}\n${m.html}`;
  expect(all).not.toMatch(/paciente|diagn[oó]stic|historia cl[ií]nica|ficha|evoluci[oó]n|turno/i);
}

// ── Mocks de los bordes de sendSaasBillingMpMail ─────────────────────────────────────────────────────────────
const claimed = new Set<string>();
const sent: { kind: string; tenantId: string; subject: string; text: string; entity: unknown }[] = [];
let recipients: { userId: string; email: string }[] = [];
let tenantRow: { name: string } | null = { name: TENANT };
let throwOnRecipients = false;

vi.mock("@/lib/db", () => ({
  prismaService: {
    tenant: { findUnique: vi.fn(async () => tenantRow) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  },
}));
vi.mock("@/lib/audit", () => ({
  auditPlatformGlobalInTx: vi.fn(async (_tx: unknown, p: { idempotencyKey?: string | null }) => {
    const k = p.idempotencyKey as string;
    if (claimed.has(k)) return { inserted: false };
    claimed.add(k);
    return { inserted: true, platformEventId: k };
  }),
}));
vi.mock("@/lib/saas-billing-internal", () => ({
  billingUrl: () => URL,
  billingRecipients: vi.fn(async () => {
    if (throwOnRecipients) throw new Error("db down");
    return recipients;
  }),
  sendBillingMail: vi.fn(async (tenantId: string, kind: string, mail: RenderedEmail, entity: unknown) => {
    for (const _r of recipients) sent.push({ kind, tenantId, subject: mail.subject, text: mail.text, entity });
    return { sent: recipients.length, notSent: 0 };
  }),
}));

describe("[MPS-3c] plantillas de C-MPS12", () => {
  it("[MPS-3c] débito activado: copy literal, sin PHI", () => {
    const m = billingDebitActivatedEmail({ tenantName: TENANT, url: URL });
    expect(m.text).toContain("Listo: el débito automático quedó activo. Se debita el 4 de cada mes.");
    expect(m.text).toContain(URL);
    expectNoPhi(m);
  });

  it("[MPS-3c] débito rechazado: monto con formatARS y el 9 en fecha AR, link a Facturación", () => {
    const m = billingDebitFailedEmail({ tenantName: TENANT, amountCents: 2_500_050, dueDate: "2026-11-09", url: URL });
    expect(m.text).toContain(`No pudimos debitar ${formatARS(2_500_050)}. Pagalo antes del 9 de noviembre para no perder el acceso.`);
    expect(m.text).toContain("Configuración → Facturación");
    expect(m.text).toContain(URL);
    expectNoPhi(m);
  });

  it("[MPS-3c] baja programada: acceso completo hasta la fecha y después solo lectura", () => {
    const m = billingCancelScheduledEmail({ tenantName: TENANT, accessUntil: "2026-12-04", url: URL });
    expect(m.text).toContain(
      "Pediste la baja. Vas a tener acceso completo hasta el 4 de diciembre de 2026. Después el consultorio queda en solo lectura."
    );
    expectNoPhi(m);
  });

  it("[MPS-3c] baja aplicada: solo lectura y cómo reactivar", () => {
    const m = billingCancelledEmail({ tenantName: TENANT, url: URL });
    expect(m.text).toContain("solo lectura");
    expect(m.text).toContain("Reactivar");
    expectNoPhi(m);
  });

  it("[MPS-3c] cambio de plan programado / aplicado / no aplicado / subida", () => {
    const sch = billingPlanChangeEmail({ tenantName: TENANT, outcome: "scheduled", planToLabel: "Individual", effectiveOn: "2026-12-04", url: URL });
    expect(sch.text).toContain("Tu plan pasa a Individual el 4 de diciembre de 2026.");
    const app = billingPlanChangeEmail({ tenantName: TENANT, outcome: "applied", planToLabel: "Individual", url: URL });
    expect(app.text).toContain("Tu plan ya es Individual.");
    const no = billingPlanChangeEmail({ tenantName: TENANT, outcome: "not_applied", planToLabel: "Individual", url: URL });
    expect(no.text).toContain("Tu cambio a Individual no se aplicó porque el consultorio tiene más usuarios que los que permite ese plan.");
    const ann = billingPlanChangeEmail({ tenantName: TENANT, outcome: "annulled", planToLabel: "Individual", url: URL });
    expect(ann.text).toBe(no.text);
    const up = billingPlanChangeEmail({ tenantName: TENANT, outcome: "upgraded", planToLabel: "Consultorio", prorationCents: 123_400, url: URL });
    expect(up.text).toContain("Pasaste a Consultorio.");
    expect(up.text).toContain(`En el próximo cargo se suman ${formatARS(123_400)}`);
    for (const m of [sch, app, no, up]) expectNoPhi(m);
  });

  it("[MPS-3c] escapa el nombre del consultorio en el html", () => {
    const m = billingDebitActivatedEmail({ tenantName: '<img src=x onerror="a">', url: URL });
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;img");
  });
});

describe("[MPS-3c] billing_charge_created con `collection`", () => {
  const base = { tenantName: TENANT, amountCents: 1_000_000, periodStart: "2026-11-04", periodEnd: "2026-12-04", dueDate: "2026-11-09", url: URL };

  it("[MPS-3c] con débito: «Se debita el 4 de noviembre.» y nada de comprobante", () => {
    const m = billingChargeCreatedEmail({ ...base, collection: "AUTO_DEBIT", transferInfo: "CBU 123" });
    expect(m.text).toContain("Se debita el 4 de noviembre.");
    expect(m.text).not.toContain("comprobante");
    expect(m.text).not.toContain("CBU 123");
  });

  it("[MPS-3c] sin débito: «Pagá hasta el 9 de noviembre para no perder el acceso.»", () => {
    for (const collection of ["MP_CHECKOUT", "TRANSFER"] as const) {
      const m = billingChargeCreatedEmail({ ...base, collection });
      expect(m.text, collection).toContain("Pagá hasta el 9 de noviembre para no perder el acceso.");
    }
    expect(billingChargeCreatedEmail({ ...base, collection: "TRANSFER", transferInfo: "CBU 123" }).text).toContain("CBU 123");
  });

  it("[MPS-3c] sin `collection` (llamadores existentes): el texto de antes, byte a byte", () => {
    const m = billingChargeCreatedEmail(base);
    expect(m.text).toContain(
      "Vence el 9 de noviembre de 2026. Cuando transfieras, subí el comprobante desde Configuración → Facturación y lo acreditamos."
    );
    expect(billingChargeCreatedEmail({ ...base, collection: null }).text).toBe(m.text);
  });
});

describe("[MPS-3c] sendSaasBillingMpMail", () => {
  beforeEach(() => {
    claimed.clear();
    sent.length = 0;
    recipients = [
      { userId: "u1", email: "titular@example.test" },
      { userId: "u2", email: "admin@example.test" },
    ];
    tenantRow = { name: TENANT };
    throwOnRecipients = false;
  });

  it("[MPS-3c] manda a todos los destinatarios de facturación y es idempotente por clave", async () => {
    const { sendSaasBillingMpMail } = await import("@/lib/saas-billing-mail-internal");
    const data = { entity: "SaasMpAuthorizedPayment", entityId: "auth-1", paymentId: "pay-9", amountCents: 900_000, effectiveOn: "2026-11-09" };
    const r1 = await sendSaasBillingMpMail("billing_debit_failed", "t1", data);
    expect(r1).toEqual({ sent: 2, notSent: 0 });
    expect(claimed.has("billing_debit_failed:auth-1:pay-9")).toBe(true);
    expect(sent[0].text).toContain(`No pudimos debitar ${formatARS(900_000)}.`);
    const r2 = await sendSaasBillingMpMail("billing_debit_failed", "t1", data);
    expect(r2).toEqual({ sent: 0, notSent: 0 });
    expect(sent).toHaveLength(2);
    // Otro pago del mismo débito sí avisa.
    await sendSaasBillingMpMail("billing_debit_failed", "t1", { ...data, paymentId: "pay-10" });
    expect(sent).toHaveLength(4);
  });

  it("[MPS-3c] claves cron.billing_*:<tenant>:<fecha> de baja y cambio de plan", async () => {
    const { sendSaasBillingMpMail } = await import("@/lib/saas-billing-mail-internal");
    await sendSaasBillingMpMail("billing_cancel_scheduled", "t1", { entity: "Tenant", entityId: "t1", effectiveOn: "2026-12-04" });
    await sendSaasBillingMpMail("billing_cancelled", "t1", { entity: "Tenant", entityId: "t1", effectiveOn: "2026-12-04" });
    await sendSaasBillingMpMail("billing_plan_change", "t1", {
      entity: "Tenant",
      entityId: "t1",
      effectiveOn: "2026-12-04",
      planTo: "INDIVIDUAL",
      planChangeOutcome: "not_applied",
    });
    expect([...claimed]).toEqual([
      "cron.billing_cancel_scheduled:t1:2026-12-04",
      "cron.billing_cancelled:t1:2026-12-04",
      "cron.billing_plan_change_not_applied:t1:2026-12-04",
    ]);
    expect(sent.at(-1)?.text).toContain("Tu cambio a Individual no se aplicó");
  });

  it("[MPS-3c] sin destinatarios no reserva la clave; sin datos obligatorios no manda", async () => {
    const { sendSaasBillingMpMail } = await import("@/lib/saas-billing-mail-internal");
    recipients = [];
    expect(await sendSaasBillingMpMail("billing_debit_activated", "t1", { entity: "SaasMpSubscription", entityId: "pre-1" })).toEqual({ sent: 0, notSent: 0 });
    expect(claimed.size).toBe(0);
    recipients = [{ userId: "u1", email: "titular@example.test" }];
    // débito rechazado sin monto: no se arma un mail con «$ 0».
    expect(await sendSaasBillingMpMail("billing_debit_failed", "t1", { entity: "X", entityId: "a", paymentId: "p" })).toEqual({ sent: 0, notSent: 0 });
    expect(claimed.size).toBe(0);
  });

  it("[MPS-3c] nunca tira", async () => {
    const { sendSaasBillingMpMail } = await import("@/lib/saas-billing-mail-internal");
    throwOnRecipients = true;
    await expect(sendSaasBillingMpMail("billing_cancelled", "t1", { entity: "Tenant", entityId: "t1" })).resolves.toEqual({ sent: 0, notSent: 0 });
    throwOnRecipients = false;
    tenantRow = null;
    await expect(sendSaasBillingMpMail("billing_cancelled", "t1", { entity: "Tenant", entityId: "t1" })).resolves.toEqual({ sent: 0, notSent: 0 });
  });
});
