import "server-only";
/**
 * Reparto de % entre profesionales (CF2 · P.3, plan §29 D-CF2-18) · helpers de DB de las actions de
 * `lib/revenue-share.ts`. `server-only` y sin `"use server"`: ninguno es un RPC (todos asumen el gate y el `tx` de
 * `runWithRls` del caller).
 *
 * Aislamiento: cada query lleva `tenantId` a mano. En prod la conexión es BYPASSRLS y las FK compuestas de M21
 * (`(practitionerId, tenantId)` → Practitioner) frenan un id ajeno recién al escribir y con un 23503 sin copy; por eso
 * los ids de entrada se validan antes acá (`assertSharePractitionersInTx`).
 */
import { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import { auditInTx } from "@/lib/audit";
import { displayMemberName, displayUserName } from "@/lib/display-name";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import type {
  RevenueShareListView,
  RevenueShareReceiverOption,
  RevenueShareRuleView,
  RevenueShareSources,
} from "@/lib/revenue-share-types";

type Tx = Prisma.TransactionClient;

/** Clave del advisory lock del reparto de un consultorio (la exportamos para los tests de carrera). */
export function revenueShareLockKey(tenantId: string): string {
  return `kinesoft:rshare:${tenantId}`;
}

/**
 * Lock EXCLUSIVO del reparto del consultorio (patrón `lib/location-lock.ts`), con alcance de tx: se suelta en el
 * COMMIT/ROLLBACK. Es de TODO el tenant y no del profesional que destina porque las reglas se validan como grafo
 * (D-CF2-18: sin mutuos ni cadenas): A→B y B→A en paralelo tocan filas distintas, y con un lock por profesional
 * las dos leerían «nadie destina» y quedaría un ciclo. Se toma ANTES de leer las vigentes.
 */
export async function lockRevenueSharesInTx(tx: DbClient, tenantId: string): Promise<void> {
  // CF2-ZF3 (ZA-1): orden de locks Tenant → reparto en TODOS los caminos. Los escritores de equipo que cierran reglas
  // (`closeRevenueSharesForPractitionerInTx`) pueden llegar acá con la fila del Tenant ya `FOR UPDATE` (cambio de
  // plan, cambio de rol con cupo); `setRevenueShare`, con el lock del reparto tomado, toca el Tenant recién en el
  // INSERT (KEY SHARE del chequeo de FK). Con el orden al revés eran un deadlock: uno esperando el advisory y el otro
  // la fila. `FOR KEY SHARE` no frena a nadie más (solo un `FOR UPDATE` del Tenant) y en la misma tx que ya la tiene
  // `FOR UPDATE` no espera.
  await tx.$queryRaw`SELECT 1 FROM "Tenant" WHERE "id" = ${tenantId} FOR KEY SHARE`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${revenueShareLockKey(tenantId)}, 0))`;
}

export type OpenShareRow = {
  id: string;
  giverPractitionerId: string;
  receiverPractitionerId: string;
  shareBps: number;
  appliesManual: boolean;
  appliesOnline: boolean;
  appliesInsurer: boolean;
  effectiveFrom: Date;
};

/** Las reglas VIGENTES del consultorio (`effectiveTo` null). Leer bajo `lockRevenueSharesInTx`. */
export async function openSharesInTx(tx: Tx, tenantId: string): Promise<OpenShareRow[]> {
  return tx.practitionerRevenueShare.findMany({
    where: { tenantId, effectiveTo: null },
    select: {
      id: true,
      giverPractitionerId: true,
      receiverPractitionerId: true,
      shareBps: true,
      appliesManual: true,
      appliesOnline: true,
      appliesInsurer: true,
      effectiveFrom: true,
    },
  });
}

export function sourcesOf(r: Pick<OpenShareRow, "appliesManual" | "appliesOnline" | "appliesInsurer">): RevenueShareSources {
  return { manual: r.appliesManual, online: r.appliesOnline, insurer: r.appliesInsurer };
}

/**
 * El que destina tiene que ser un profesional DEL consultorio (cualquier estado: a uno suspendido se le puede seguir
 * cerrando o cambiando la regla, lo cobrado antes sigue siendo suyo). El que recibe, además, reservable: membresía
 * aceptada que atiende, sin suspender y usuario habilitado (D-CF2-18: «recibe solo un profesional activo del
 * consultorio»; mismo criterio que coberturas/servicios, `bookablePractitionerWhere`).
 * Un id de otro consultorio cae en el mismo `null` que uno inexistente: no se le dice al cliente si existe.
 */
export async function assertSharePractitionersInTx(
  tx: Tx,
  tenantId: string,
  ids: { giverPractitionerId: string; receiverPractitionerId?: string },
): Promise<"ok" | "giverNotFound" | "receiverNotBookable"> {
  const giver = await tx.practitioner.findFirst({
    where: { id: ids.giverPractitionerId, tenantId },
    select: { id: true },
  });
  if (!giver) return "giverNotFound";
  if (ids.receiverPractitionerId === undefined) return "ok";
  const receiver = await tx.practitioner.findFirst({
    where: { id: ids.receiverPractitionerId, ...bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }) },
    select: { id: true },
  });
  return receiver ? "ok" : "receiverNotBookable";
}

/**
 * CF3 ZF5 (B, default de Martin pendiente): ¿el que destina es el Practitioner del Titular PRINCIPAL de este consultorio
 * (membresía OWNER)? Una regla así reparte la plata del principal («la cuenta del principal», CT-K1): la crea o la
 * cierra solo él (`account.owner`). 1 sentencia (la membresía con la relación al profesional como subconsulta), con el
 * `tenantId` a mano en las dos tablas; el llamador la corre solo si quien actúa NO es el principal.
 */
export async function isPrincipalOwnerPractitionerInTx(tx: Tx, tenantId: string, practitionerId: string): Promise<boolean> {
  const n = await tx.membership.count({
    where: { tenantId, role: "OWNER", user: { practitioners: { some: { id: practitionerId, tenantId } } } },
  });
  return n > 0;
}

/**
 * Todas las reglas (vigentes e históricas, `effectiveFrom` desc) + los receptores posibles, con nombres visibles
 * (`displayMemberName`, nunca el email). Quién creó/cerró se resuelve por las membresías DEL consultorio: un usuario
 * que ya no es miembro queda `null` (no se busca su nombre en otro tenant). 3 sentencias en la tx del caller.
 */
export async function listRevenueSharesInTx(tx: Tx, tenantId: string): Promise<RevenueShareListView> {
  const [rows, receivers] = await Promise.all([
    tx.practitionerRevenueShare.findMany({
      where: { tenantId },
      orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
      select: {
        id: true,
        giverPractitionerId: true,
        receiverPractitionerId: true,
        shareBps: true,
        appliesManual: true,
        appliesOnline: true,
        appliesInsurer: true,
        effectiveFrom: true,
        effectiveTo: true,
        createdById: true,
        closedById: true,
        giver: { select: { user: { select: { fullName: true } } } },
        receiver: { select: { user: { select: { fullName: true } } } },
      },
    }),
    tx.practitioner.findMany({
      where: bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }),
      select: { id: true, user: { select: { fullName: true } } },
    }),
  ]);

  const userIds = [...new Set(rows.flatMap((r) => [r.createdById, r.closedById]).filter((x): x is string => !!x))];
  const members = userIds.length
    ? await tx.membership.findMany({
        where: { tenantId, userId: { in: userIds } },
        select: { userId: true, user: { select: { fullName: true } } },
      })
    : [];
  const nameOf = new Map(members.map((m) => [m.userId, displayUserName(m.user.fullName)]));

  const rules: RevenueShareRuleView[] = rows.map((r) => ({
    id: r.id,
    giverPractitionerId: r.giverPractitionerId,
    giverName: displayMemberName(r.giver.user.fullName),
    receiverPractitionerId: r.receiverPractitionerId,
    receiverName: displayMemberName(r.receiver.user.fullName),
    shareBps: r.shareBps,
    sources: sourcesOf(r),
    effectiveFrom: r.effectiveFrom.toISOString(),
    effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString() : null,
    createdByName: r.createdById ? (nameOf.get(r.createdById) ?? null) : null,
    closedByName: r.closedById ? (nameOf.get(r.closedById) ?? null) : null,
  }));
  const receiverOptions: RevenueShareReceiverOption[] = receivers
    .map((p) => ({ practitionerId: p.id, name: displayMemberName(p.user.fullName) }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  return { rules, receivers: receiverOptions };
}

/** SQLSTATE de un error de Postgres que atraviesa Prisma (mismo parseo que `lib/patient-documents-internal.ts`). */
function pgErrorCode(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = (e.meta as { code?: unknown } | undefined)?.code;
    if (typeof meta === "string") return meta;
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) {
    const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
    return m?.[1] ?? m?.[2] ?? null;
  }
  return null;
}

/** Mensaje del trigger de solo cierre de M21 (`practitioner_revenue_share_guard`); viaja en el error de Prisma. */
const SHARE_GUARD_MESSAGE = "PractitionerRevenueShare: solo se cierra una regla vigente";

/** Texto del error de Postgres como lo deja Prisma (el `message` y, en los raw, `meta.message`). */
function pgErrorText(e: unknown): string {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError)) return "";
  const meta = e instanceof Prisma.PrismaClientKnownRequestError ? (e.meta as { message?: unknown } | undefined)?.message : null;
  return `${e.message} ${typeof meta === "string" ? meta : ""}`;
}

/**
 * ¿El error es una carrera contra otra escritura del reparto? P2002/23505 = el único parcial «una vigente por
 * profesional» (`PractitionerRevenueShare_giver_open_key`); 23514 SOLO si es el trigger de solo cierre (alguien cerró
 * la vigente entre la lectura y el UPDATE). Con el lock y el CAS no debería pasar por la action; queda como red para
 * un escritor que no tome el lock. La tx ya está abortada: el caller devuelve «Cambió mientras lo editabas».
 *
 * CF2-ZF3 (ZA-8): antes CUALQUIER 23514 era «Cambió mientras lo editabas», también un CHECK de M21 (`bps_check`,
 * `period_check`, `sources_check`, `not_self_check`). Esos no son una carrera sino un bug (zod o el `now` corregido
 * deberían frenarlos antes): con el copy de conflicto el usuario reintentaba en loop y nadie se enteraba. Ahora caen
 * en el error genérico, que `runShareTx` loguea. Se distingue por el mensaje del trigger (los CHECK traen el nombre de
 * la constraint, el trigger su texto fijo).
 */
export function isRevenueShareConflict(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return true;
  const code = pgErrorCode(e);
  if (code === "23505") return true;
  return code === "23514" && pgErrorText(e).includes(SHARE_GUARD_MESSAGE);
}

/** Por qué se cerró una regla sin que nadie tocara el editor (va en el payload del audit `revenueShare.end`). */
export type RevenueShareCloseReason =
  | "member.suspend"
  | "member.remove"
  | "member.nonClinical"
  | "plan.downgrade"
  | "user.disable";

/**
 * CF2-ZF3 (ZA-1): cierra en `now` las reglas VIGENTES donde `practitionerId` destina o recibe. Lo llama, en la MISMA
 * tx, cada camino que saca a un profesional del equipo activo: suspender, quitar, pasarlo a un rol que no atiende (o
 * «no atiende» del Titular), deshabilitarlo al bajar de plan y deshabilitar al usuario desde Plataforma.
 *
 * Por qué: D-CF2-18 dice «recibe solo un profesional activo del consultorio», pero eso se validaba solo al GUARDAR la
 * regla. Un receptor suspendido (o que dejó el equipo) seguía cobrando el % de cada copago del que destinaba, sin que
 * nadie lo viera en la agenda; y un giver suspendido dejaba una regla viva que se reactivaba sola al volver. Cerrarla
 * es lo mismo que «Dejar de destinar» (`endRevenueShare`): lo cobrado antes de `now` sigue repartido (la caja usa
 * `[from, to)`), desde `now` no. Reactivar NO la reabre (el trigger no deja y una regla cerrada es historia): si
 * vuelve, se arma otra desde el editor.
 *
 * Concurrencia: toma el lock del reparto ANTES de leer (el mismo que `setRevenueShare`). Si el editor guardaba en
 * paralelo una regla hacia este receptor, o esa tx ganó el lock y commiteó (este SELECT, de READ COMMITTED, ya la ve
 * y la cierra) o la ganamos nosotros y su `assertSharePractitionersInTx` lee la membresía ya suspendida. Sin
 * deadlock: `setRevenueShare` no lockea filas de Membership ni de Tenant.
 * Trigger: solo `effectiveTo` NULL→valor + `closedById`, y CAS `effectiveTo: null` en el where. Si la vigente empieza
 * «después» (reloj de otra instancia) se cierra en su `effectiveFrom` (`period_check`), como en `setRevenueShare`.
 *
 * Costo: 2 sentencias (lock + lectura) y, por regla cerrada, UPDATE + audit. `actorUserId` va a `closedById` y al
 * audit (el superadmin en Plataforma; `closedByName` lo resuelve por membresía, así que ahí queda `null`).
 */
export async function closeRevenueSharesForPractitionerInTx(
  tx: Tx,
  tenantId: string,
  practitionerId: string,
  actorUserId: string,
  reason?: RevenueShareCloseReason,
): Promise<number> {
  await lockRevenueSharesInTx(tx, tenantId);
  const open = await tx.practitionerRevenueShare.findMany({
    where: {
      tenantId,
      effectiveTo: null,
      OR: [{ giverPractitionerId: practitionerId }, { receiverPractitionerId: practitionerId }],
    },
    select: {
      id: true,
      giverPractitionerId: true,
      receiverPractitionerId: true,
      shareBps: true,
      appliesManual: true,
      appliesOnline: true,
      appliesInsurer: true,
      effectiveFrom: true,
    },
    orderBy: { id: "asc" },
  });
  let closedCount = 0;
  for (const r of open) {
    const now = new Date();
    const at = r.effectiveFrom > now ? r.effectiveFrom : now;
    const closed = await tx.practitionerRevenueShare.updateMany({
      where: { id: r.id, tenantId, effectiveTo: null },
      data: { effectiveTo: at, closedById: actorUserId },
    });
    // Bajo el lock no debería pasar; si otro escritor sin lock la cerró, ya está cerrada (que es lo que queríamos).
    if (closed.count !== 1) continue;
    closedCount += 1;
    await auditInTx(tx, {
      tenantId,
      actorId: actorUserId,
      action: "revenueShare.end",
      entity: "PractitionerRevenueShare",
      entityId: r.id,
      payload: {
        giverPractitionerId: r.giverPractitionerId,
        receiverPractitionerId: r.receiverPractitionerId,
        shareBps: r.shareBps,
        sources: sourcesOf(r),
        effectiveTo: at.toISOString(),
        ...(reason ? { reason } : {}),
      },
    });
  }
  return closedCount;
}

/**
 * Variante por usuario para los escritores de membresías (que tienen el `userId`, no el profesional): resuelve el
 * `Practitioner` de ese usuario EN ese consultorio y cierra sus reglas. Sin profesional (Secretaria, Facturación, un
 * Admin que nunca atendió) no hace nada y no toma el lock: 1 sentencia.
 */
export async function closeRevenueSharesForUserInTx(
  tx: Tx,
  tenantId: string,
  userId: string,
  actorUserId: string,
  reason: RevenueShareCloseReason,
): Promise<number> {
  const prac = await tx.practitioner.findFirst({ where: { tenantId, userId }, select: { id: true } });
  if (!prac) return 0;
  return closeRevenueSharesForPractitionerInTx(tx, tenantId, prac.id, actorUserId, reason);
}
