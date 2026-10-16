import "server-only";
/**
 * Estado de cuenta del portal (ES4 S24p, brief §3.5 / §4). Lectura de plata vista por el PACIENTE, por el canal
 * service (BYPASSRLS, sin Actor): cada query va acotada a mano por el par (tenantId, patientId) que devolvió
 * `requirePortalPatient` — es la única barrera.
 *
 * Reglas (por qué):
 *   - Saldo de planes = P7 con `loadPlansInTx` + `balanceOf` (sin editarlos): el mismo número que ve el consultorio en
 *     la PlanCard. Si el portal recalculara, los dos lados podrían contradecirse.
 *   - Un monto sale SOLO de una fuente explícita. En un turno suelto eso es `Booking.copagoCents != null` (override del
 *     profesional, estampado del motor de Planes o congelado al marcar cobrado, Q8). Con `copagoCents` null NO se
 *     resuelve la precedencia de `lib/copago.ts` en lectura: con una OS sin copago configurado cae en
 *     `Insurer.copagoCents` (nace en 0 → «$0», falso) o en el precio de lista del Service (dato comercial del
 *     consultorio, prohibido en el DTO). Para el paciente eso es «A confirmar en el consultorio» (`to_confirm`).
 *   - DTO por allowlist: `select` explícito y proyección campo a campo. `PLAN_READ_SELECT` trae columnas clínicas
 *     (título de sesión, notas, cuotas por sesión) porque es el select compartido del staff: acá solo se usan para el
 *     saldo y nunca se copian al DTO.
 *   - Gate por módulo (`portalSectionsFor`): sin `planes` (Clínica general) no se leen planes aunque haya filas
 *     legacy; la cuenta se muestra igual con los turnos sueltos (ES4-D11).
 */
import type { Prisma } from "@prisma/client";
// Superficie del paciente, sin Actor: canal service (BYPASSRLS). Ver lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import type { DbClient } from "@/lib/rls";
import { balanceOf, loadPlansInTx } from "@/lib/plans-read-internal";
import { portalSectionsFor } from "@/lib/portal-nav";
import type { PortalPatientRef } from "@/lib/portal-identity-internal";
import type { PortalAccountDTO, PortalMoney } from "@/lib/portal-account-types";

/** ES4-D7: turnos sueltos de los últimos 12 meses + futuros, máx. 50. */
export const LOOSE_WINDOW_DAYS = 365;
export const LOOSE_MAX = 50;
/** Tope de planes listados (un paciente real tiene uno o dos; acota el payload ante datos raros). */
const PLANS_MAX = 20;

export function explicitMoney(cents: number | null): PortalMoney {
  return cents == null ? { kind: "to_confirm" } : { kind: "amount", cents };
}

/**
 * Turnos sueltos que se listan: los no cancelados ni ausentes, y además los cancelados/ausentes con plata en juego
 * (cobrados o en proceso), porque esa plata existe aunque el turno no. Un cancelado sin cobrar no es deuda (decisión 3
 * del §16.1: cancelar no genera cargo) y solo confundiría.
 */
const LOOSE_VISIBLE: Prisma.BookingWhereInput = {
  OR: [
    { status: { notIn: ["CANCELLED", "NO_SHOW"] } },
    { paymentStatus: { in: ["PAID", "AUTHORIZED"] } },
    { payment: { is: { status: { in: ["PAID", "AUTHORIZED"] } } } },
  ],
};

const LOOSE_SELECT = {
  id: true,
  scheduledFor: true,
  status: true,
  paymentStatus: true,
  copagoCents: true,
  service: { select: { name: true } },
  payment: { select: { status: true } },
} satisfies Prisma.BookingSelect;

type LooseRow = Prisma.BookingGetPayload<{ select: typeof LOOSE_SELECT }>;

type LooseMoneyRow = Pick<LooseRow, "status" | "paymentStatus" | "copagoCents"> & {
  payment?: { status: LooseRow["paymentStatus"] } | null;
};

/** Cobrado: el estado del turno o el del `Payment` de MP (el webhook puede ir adelante del turno). */
export function looseIsPaid(b: Pick<LooseMoneyRow, "paymentStatus" | "payment">): boolean {
  return b.paymentStatus === "PAID" || b.payment?.status === "PAID";
}

/** Pago en proceso (AUTHORIZED) y todavía no cobrado. */
export function looseInProcess(b: Pick<LooseMoneyRow, "paymentStatus" | "payment">): boolean {
  return !looseIsPaid(b) && (b.paymentStatus === "AUTHORIZED" || b.payment?.status === "AUTHORIZED");
}

/**
 * Deuda de un turno suelto: solo uno REALIZADO, con monto explícito y sin cobrar (ni en proceso). Un futuro todavía
 * no se debe; uno «a confirmar» no tiene cifra honesta para sumar.
 *
 * ES4-Z (B3, decisión con default): REFUNDED NO reabre la deuda. Un reintegro lo decide el consultorio (devolvió la
 * plata por algo); mostrarle al paciente «Te falta pagar» por un turno que le devolvieron sería falso. Si el
 * consultorio quiere volver a cobrarlo, lo marca impago.
 */
export function loosePendingCents(b: LooseMoneyRow): number {
  if (b.status !== "COMPLETED" || b.copagoCents == null) return 0;
  if (b.paymentStatus === "PAID" || b.paymentStatus === "AUTHORIZED" || b.paymentStatus === "REFUNDED") return 0;
  if (looseIsPaid(b) || looseInProcess(b)) return 0;
  return b.copagoCents;
}

export async function loadPortalAccount(
  ref: Pick<PortalPatientRef, "tenantId" | "patientId" | "modules" | "tenant">,
  now: Date = new Date()
): Promise<PortalAccountDTO> {
  const { tenantId, patientId } = ref;
  const withPlans = portalSectionsFor(ref.modules).has("plan");
  const sessionWord: "sesión" | "turno" = ref.tenant.vertical === "KINESIOLOGY" ? "sesión" : "turno";

  const [rawPlans, loose] = await Promise.all([
    withPlans
      ? // `loadPlansInTx` pone el tenantId en un AND aparte; el patientId va en el fragmento.
        loadPlansInTx(prisma as unknown as DbClient, tenantId, { patientId, archivedAt: null }, { take: PLANS_MAX })
      : Promise.resolve([]),
    prisma.booking.findMany({
      where: {
        AND: [
          { tenantId, patientId, programId: null },
          { scheduledFor: { gte: new Date(now.getTime() - LOOSE_WINDOW_DAYS * 86_400_000) } },
          LOOSE_VISIBLE,
        ],
      },
      orderBy: [{ scheduledFor: "desc" }, { id: "asc" }],
      take: LOOSE_MAX,
      select: LOOSE_SELECT,
    }),
  ]);

  const plans: PortalAccountDTO["plans"] = [];
  for (const p of rawPlans) {
    // Defensa en profundidad sobre BYPASSRLS: la fila tiene que ser de ESTE paciente.
    if (p.patientId !== patientId) continue;
    const b = balanceOf(p);
    // Un plan cancelado sin plata en juego no aporta nada a un estado de cuenta.
    if (p.status === "CANCELLED" && b.collectedCents + b.pendingCents + b.creditCents + b.inProcessCents === 0) continue;
    plans.push({
      programId: p.id,
      title: p.title,
      sessionWord,
      // `agreedCents` null = plan sin precio pactado (p. ej. lo cubre la OS): a confirmar, no $0.
      agreed: explicitMoney(b.agreedCents),
      collectedCents: b.collectedCents,
      pendingCents: b.pendingCents,
      creditCents: b.creditCents,
      inProcessCents: b.inProcessCents,
    });
  }

  const looseBookings: PortalAccountDTO["looseBookings"] = loose.map((b) => ({
    id: b.id,
    date: b.scheduledFor.toISOString(),
    serviceName: b.service.name,
    amount: explicitMoney(b.copagoCents),
    paid: looseIsPaid(b),
    inProcess: looseInProcess(b),
    pending: loosePendingCents(b) > 0,
    cancelled: b.status === "CANCELLED" || b.status === "NO_SHOW",
  }));

  const pendingCents =
    plans.reduce((a, p) => a + p.pendingCents, 0) + loose.reduce((a, b) => a + loosePendingCents(b), 0);
  const creditCents = plans.reduce((a, p) => a + p.creditCents, 0);

  return { plans, looseBookings, totals: { pendingCents, creditCents } };
}
