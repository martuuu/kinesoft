"use server";

/**
 * Política de cobro online del turnero (T5, contrato C-TP5 del plan §25). TP-2b.
 *
 * La configura quien tiene lo delicado (`tenant.sensitive`, decisión 1 de Martin): el Titular, o quien tenga
 * «Configuración» salvo la Secretaria y Facturación (corte de staff de T3). Soporte la ve pero no escribe (la tx de
 * `runWithRls` va en solo lectura y `withReadOnlyResult` lo devuelve como error con copy; nada nuevo en
 * `SUPPORT_WRITABLE_ACTIONS`, C-TP14).
 *
 * - zod espejo de los CHECK de M18 (`PaymentPolicySchema` de `-types.ts`): un input que pasa no puede ser un 23514.
 * - `useClinicAccount` solo con la cuenta del consultorio ACTIVE: prenderlo sin cuenta prometería un cobro que el
 *   turnero no puede hacer (TP-D8 lo resolvería «sin cobro», pero el panel diría otra cosa).
 * - Optimistic lock por `updatedAt` (`expectedUpdatedAt`; null = «no había fila»): dos personas editando la política a
 *   la vez no se pisan en silencio.
 * - Audit `bookingPaymentPolicy.update {from,to}` en la misma tx (plata: PL-A).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { auditInTx } from "@/lib/audit";
import { ForbiddenError, writableError } from "@/lib/session";
import { capabilitiesForActor, requireTenantSensitive } from "@/lib/authz";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { mpConnectMode } from "@/lib/env";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { loadAccountViews, mpAccountViewOf } from "@/lib/mp-connect/accounts-internal";
import { ONLINE_PAYMENTS_AUDIT } from "@/lib/online-payments-types";
import { DEFAULT_PAYMENT_POLICY, PaymentPolicySchema, type PaymentPolicyInput } from "@/lib/booking-payment-policy-types";
import type { ActionResult } from "@/lib/validation";
import type { OnlinePaymentsSettingsView } from "@/lib/mp-connect-types";

const ExpectedSchema = z.string().datetime({ offset: true }).nullable();

const COPY = {
  stale: "Otra persona cambió la política mientras la editabas. Recargá la página y revisá antes de guardar.",
  noClinicAccount: "Para usar la cuenta del consultorio, primero conectá su Mercado Pago.",
  invalid: "Revisá los datos de la política.",
} as const;

const POLICY_SELECT = {
  mode: true,
  chargeKind: true,
  fixedCents: true,
  percentBps: true,
  useClinicAccount: true,
  cancellationNote: true,
  updatedAt: true,
} as const;

function policyOf(row: PaymentPolicyInput): PaymentPolicyInput {
  return {
    mode: row.mode,
    chargeKind: row.chargeKind,
    fixedCents: row.fixedCents,
    percentBps: row.percentBps,
    useClinicAccount: row.useClinicAccount,
    cancellationNote: row.cancellationNote,
  };
}

function samePolicy(a: PaymentPolicyInput, b: PaymentPolicyInput): boolean {
  return (Object.keys(DEFAULT_PAYMENT_POLICY) as (keyof PaymentPolicyInput)[]).every((k) => a[k] === b[k]);
}

class Stale extends Error {}

export async function savePaymentPolicy(
  input: PaymentPolicyInput,
  expectedUpdatedAt: string | null
): Promise<ActionResult<{ updatedAt: string }>> {
  return withReadOnlyResult(() => savePaymentPolicyImpl(input, expectedUpdatedAt));
}

async function savePaymentPolicyImpl(
  input: PaymentPolicyInput,
  expectedUpdatedAt: string | null
): Promise<ActionResult<{ updatedAt: string }>> {
  const actor = await requireTenantSensitive("Solo el titular o quien tenga «Configuración» (no la Secretaría ni Facturación) configura los cobros online.");
  const parsed = PaymentPolicySchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    return { ok: false, error: Object.values(fieldErrors)[0]?.[0] ?? COPY.invalid, fieldErrors };
  }
  const expected = ExpectedSchema.safeParse(expectedUpdatedAt ?? null);
  if (!expected.success) return { ok: false, error: COPY.invalid };
  // Antes de leer: un guardado sin cambios no escribe, y sin esto soporte (o un consultorio en solo lectura) vería un
  // «guardado» que nunca pasó por la tx de solo lectura.
  const ro = writableError(actor);
  if (ro) return { ok: false, error: ro };
  const next: PaymentPolicyInput = parsed.data;
  const tenantId = actor.tenantId;

  try {
    const updatedAt = await runWithRls<{ error: string } | { updatedAt: Date }>(tenantId, async (tx) => {
      if (next.useClinicAccount) {
        // MpAccount es solo SELECT para kinesoft_app: la lectura va por la tx con RLS y `tenantId` a mano.
        const clinic = await tx.mpAccount.findFirst({
          where: { tenantId, practitionerId: null, status: "ACTIVE" },
          select: { id: true },
        });
        if (!clinic) return { error: COPY.noClinicAccount };
      }
      const current = await tx.bookingPaymentPolicy.findUnique({ where: { tenantId }, select: POLICY_SELECT });
      if (expected.data === null) {
        if (current) throw new Stale();
      } else if (!current || current.updatedAt.getTime() !== Date.parse(expected.data)) {
        throw new Stale();
      }
      const from = current ? policyOf(current) : DEFAULT_PAYMENT_POLICY;
      if (current && samePolicy(from, next)) return { updatedAt: current.updatedAt };

      let written: Date;
      if (current) {
        // CAS en la misma sentencia: entre el SELECT y el UPDATE pudo guardar otro.
        const u = await tx.bookingPaymentPolicy.updateMany({
          where: { tenantId, updatedAt: current.updatedAt },
          data: { ...next, updatedByUserId: actor.userId },
        });
        if (u.count === 0) throw new Stale();
        written = (await tx.bookingPaymentPolicy.findUniqueOrThrow({ where: { tenantId }, select: { updatedAt: true } })).updatedAt;
      } else {
        written = (
          await tx.bookingPaymentPolicy.create({
            data: { tenantId, ...next, updatedByUserId: actor.userId },
            select: { updatedAt: true },
          })
        ).updatedAt;
      }
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: ONLINE_PAYMENTS_AUDIT.paymentPolicyUpdate,
        entity: "BookingPaymentPolicy",
        entityId: tenantId,
        payload: { from, to: next },
      });
      return { updatedAt: written };
    });
    if ("error" in updatedAt) return { ok: false, error: updatedAt.error };
    revalidatePath("/configuracion");
    return { ok: true, data: { updatedAt: updatedAt.updatedAt.toISOString() } };
  } catch (err) {
    if (err instanceof Stale) return { ok: false, error: COPY.stale };
    // Dos «primer guardado» a la vez: el PK de tenantId deja pasar uno; el otro es stale.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: COPY.stale };
    throw err;
  }
}

/**
 * Lo que necesita el panel «Cobros online» (`tenant.sensitive`). `null` = sin el permiso: la pestaña no existe para
 * ese actor (no es un error que mostrar). Soporte la ve (tiene `tenant.sensitive`) pero no maneja la cuenta.
 */
export async function getOnlinePaymentsSettings(): Promise<OnlinePaymentsSettingsView | null> {
  let actor;
  try {
    actor = await requireTenantSensitive();
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
  const tenantId = actor.tenantId;
  const caps = await capabilitiesForActor(actor);
  const mode = mpConnectMode();

  const { row, practitioners } = await runWithRls(tenantId, async (tx) => {
    const row = await tx.bookingPaymentPolicy.findUnique({ where: { tenantId }, select: POLICY_SELECT });
    const practitioners = await tx.practitioner.findMany({
      where: bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }),
      orderBy: { createdAt: "asc" },
      select: { id: true, user: { select: { fullName: true } } },
    });
    return { row, practitioners };
  });
  const views = await loadAccountViews({ tenantId, practitionerIds: practitioners.map((p) => p.id), includeClinic: true });

  const rows = practitioners.map((p) => {
    const v = views.byPractitioner.get(p.id) ?? null;
    return {
      practitionerId: p.id,
      name: p.user.fullName?.trim() || "Profesional",
      status: v ? v.status : ("NONE" as const),
      linksDelegated: v ? v.status !== "DISCONNECTED" && v.linksDelegated : false,
    };
  });

  return {
    policy: row ? policyOf(row) : DEFAULT_PAYMENT_POLICY,
    policyUpdatedAt: row ? row.updatedAt.toISOString() : null,
    connectMode: mode,
    publicBookingEnabled: actor.entitlements.publicBookingEnabled,
    clinicAccount: mpAccountViewOf(views.clinic, mode),
    canManageClinicAccount: !actor.support && caps.has("account.owner"),
    practitioners: rows,
    withoutMpCount: rows.filter((r) => r.status !== "ACTIVE").length,
  };
}
