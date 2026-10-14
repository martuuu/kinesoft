/**
 * Configuración de agenda por defecto de las ALTAS (B-pre B2.3 BOOT).
 *
 * Por qué existe: la migración `20261001090000_agenda_foundations` backfilleó
 * sede principal, franjas, PractitionerService y PractitionerPayer para todo
 * lo que existía al migrar. Lo que nace DESPUÉS (tenant nuevo, invitación
 * aceptada, obra social o servicio nuevo) tiene que quedar exactamente igual
 * que si el backfill lo hubiera encontrado: mismas reglas y, además, los
 * MISMOS ids determinísticos (md5 con el prefijo `agenda_foundations:`). Así
 *   - el bloque de backfill re-corrido después no duplica ni ve diferencias
 *     (sus `NOT EXISTS` / `ON CONFLICT DO NOTHING` coinciden con estas filas);
 *   - cada helper es idempotente con `createMany({ skipDuplicates })`
 *     (= `ON CONFLICT DO NOTHING`, que cubre también los únicos
 *     `(practitionerId, serviceId|insurerId)` y el único parcial de sede
 *     principal) sin tener que leer antes ni tirar P2002 dentro de la tx;
 *   - `tests/integration/agenda-defaults.test.ts` compara fila por fila con
 *     lo que produce el SQL literal del backfill para el mismo estado.
 * Regla espejo de cada paso: ver el bloque `BACKFILL agenda_foundations`
 * de la migración (los números (1)-(4) de abajo son los mismos).
 *
 * Todos reciben el `tx` del caller: corren dentro de la transacción del alta
 * (si el alta se revierte, no queda una sede o franja huérfana). Canales:
 * `runWithRls` en las actions con Actor (todas las filas llevan el `tenantId`
 * del actor → pasan el WITH CHECK de la policy) y `prismaService` en
 * `bootstrapTenant`/`acceptInvite` (todavía no hay Actor ni GUC). Cada query
 * filtra `tenantId` a mano: en prod la conexión es BYPASSRLS y esa es la
 * única barrera; los ids que entran (practitionerId, serviceId, insurerId)
 * los valida el caller contra el tenant ANTES de llamar acá.
 *
 * Por qué NO lleva `import "server-only"` (aunque es solo de servidor):
 * `lib/tenant-bootstrap.ts` lo importa y `scripts/create-tenant.ts` corre ese
 * módulo con `tsx` fuera de Next, donde `server-only` tira al importarse.
 * Mismo motivo para los imports relativos. No toca secretos ni `env`, y no es
 * `"use server"`: nada de esto es invocable desde el cliente.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";

type Tx = Prisma.TransactionClient;

/** Nombre de la sede que crea el alta (= backfill (1)). */
export const PRIMARY_LOCATION_NAME = "Principal";
/** Lun-sáb en la convención `toARDow` (0=Dom..6=Sáb): domingo cerrado, como hoy. */
export const DEFAULT_WORK_DOWS: readonly number[] = [1, 2, 3, 4, 5, 6];

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** Ids determinísticos IDÉNTICOS a los del backfill (`'loc_' || md5(...)`, etc.). */
export const agendaDefaultIds = {
  location: (tenantId: string) => `loc_${md5(`agenda_foundations:location:${tenantId}`)}`,
  schedule: (practitionerId: string, dow: number) =>
    `psch_${md5(`agenda_foundations:schedule:${practitionerId}:${dow}`)}`,
  service: (practitionerId: string, serviceId: string) =>
    `psvc_${md5(`agenda_foundations:service:${practitionerId}:${serviceId}`)}`,
  payer: (practitionerId: string, insurerId: string) =>
    `ppay_${md5(`agenda_foundations:payer:${practitionerId}:${insurerId}`)}`,
};

/**
 * Horario del tenant utilizable como franja (= filtro del backfill (2)):
 * 0 <= start < end <= 24. Uno inválido NO genera franjas: el loader cae al
 * horario del tenant (red de seguridad permanente, bpre-design §B).
 */
export function isValidTenantHours(start: number, end: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= 24;
}

/**
 * Profesionales del tenant con membresía ACEPTADA en ese tenant (= JOIN
 * Membership del backfill). IAM-2e: solo roles clínicos sin suspender; a la
 * Secretaria y a Facturación no se les habilitan servicios ni obras sociales
 * nuevas (no atienden, §19.2 decisión 2).
 */
export async function acceptedPractitionerIds(tx: Tx, tenantId: string): Promise<string[]> {
  const rows = await tx.practitioner.findMany({
    where: bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }),
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => r.id);
}

/**
 * (1) Sede principal del tenant; la crea si no hay. Devuelve su id.
 * Carrera (dos invitaciones aceptadas a la vez en un tenant sin sede, solo
 * posible en tenants creados entre el deploy de la migración y B2.3): el
 * segundo INSERT espera al único parcial `(tenantId) WHERE isPrimary`, no
 * inserta (skipDuplicates) y la relectura (READ COMMITTED) ve la del primero.
 */
export async function ensurePrimaryLocation(tx: Tx, tenantId: string): Promise<string> {
  const existing = await tx.location.findFirst({
    where: { tenantId, isPrimary: true },
    select: { id: true },
  });
  if (existing) return existing.id;
  await tx.location.createMany({
    data: [
      {
        id: agendaDefaultIds.location(tenantId),
        tenantId,
        name: PRIMARY_LOCATION_NAME,
        isPrimary: true,
        active: true,
        sortOrder: 0,
      },
    ],
    skipDuplicates: true,
  });
  const row = await tx.location.findFirstOrThrow({
    where: { tenantId, isPrimary: true },
    select: { id: true },
  });
  return row.id;
}

/**
 * (2) Franjas lun-sáb con el horario del tenant en la sede indicada, SOLO si
 * el profesional no tiene ninguna franja (no pisa una configuración cargada).
 * Devuelve cuántas creó.
 */
export async function ensureDefaultSchedule(
  tx: Tx,
  args: { tenantId: string; practitionerId: string; locationId: string; startHour: number; endHour: number }
): Promise<number> {
  if (!isValidTenantHours(args.startHour, args.endHour)) return 0;
  const has = await tx.practitionerSchedule.findFirst({
    where: { tenantId: args.tenantId, practitionerId: args.practitionerId },
    select: { id: true },
  });
  if (has) return 0;
  const r = await tx.practitionerSchedule.createMany({
    data: DEFAULT_WORK_DOWS.map((dow) => ({
      id: agendaDefaultIds.schedule(args.practitionerId, dow),
      tenantId: args.tenantId,
      practitionerId: args.practitionerId,
      locationId: args.locationId,
      dow,
      startMin: args.startHour * 60,
      endMin: args.endHour * 60,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

/** (3) Filas PractitionerService (PUBLIC + enabled por default de la tabla) para pares (P, S). */
async function insertPractitionerServices(
  tx: Tx,
  tenantId: string,
  pairs: ReadonlyArray<{ practitionerId: string; serviceId: string }>
): Promise<number> {
  if (pairs.length === 0) return 0;
  const r = await tx.practitionerService.createMany({
    data: pairs.map((p) => ({
      id: agendaDefaultIds.service(p.practitionerId, p.serviceId),
      tenantId,
      practitionerId: p.practitionerId,
      serviceId: p.serviceId,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

/** (4) Filas PractitionerPayer (active por default de la tabla) para pares (P, I). */
async function insertPractitionerPayers(
  tx: Tx,
  tenantId: string,
  pairs: ReadonlyArray<{ practitionerId: string; insurerId: string }>
): Promise<number> {
  if (pairs.length === 0) return 0;
  const r = await tx.practitionerPayer.createMany({
    data: pairs.map((p) => ({
      id: agendaDefaultIds.payer(p.practitionerId, p.insurerId),
      tenantId,
      practitionerId: p.practitionerId,
      insurerId: p.insurerId,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

/**
 * Alta de un profesional en el tenant (bootstrap del OWNER, invitación
 * aceptada): sede principal (si falta) + franjas por defecto + los servicios
 * que hoy atendería (compartidos y los propios) + todas las coberturas
 * activas (incl. Particular). Idempotente. El caller garantiza que el
 * profesional pertenece al tenant y tiene la membresía aceptada en la tx.
 */
export async function provisionPractitionerAgenda(
  tx: Tx,
  args: { tenantId: string; practitionerId: string }
): Promise<{ locationId: string; schedules: number; services: number; payers: number }> {
  const { tenantId, practitionerId } = args;
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { businessHoursStart: true, businessHoursEnd: true },
  });
  const locationId = await ensurePrimaryLocation(tx, tenantId);
  const schedules = await ensureDefaultSchedule(tx, {
    tenantId,
    practitionerId,
    locationId,
    startHour: tenant.businessHoursStart,
    endHour: tenant.businessHoursEnd,
  });
  const services = await tx.service.findMany({
    where: { tenantId, OR: [{ practitionerId: null }, { practitionerId }] },
    select: { id: true },
  });
  const insurers = await tx.insurer.findMany({
    where: { tenantId, active: true },
    select: { id: true },
  });
  return {
    locationId,
    schedules,
    services: await insertPractitionerServices(
      tx,
      tenantId,
      services.map((s) => ({ practitionerId, serviceId: s.id }))
    ),
    payers: await insertPractitionerPayers(
      tx,
      tenantId,
      insurers.map((i) => ({ practitionerId, insurerId: i.id }))
    ),
  };
}

/**
 * Servicio nuevo (o que cambió de dueño): con `practitionerId` → solo ese
 * profesional; sin (compartido) → todos los aceptados (decisión 7). Solo
 * AGREGA: no deshabilita a nadie (lo que un profesional dejó de atender se
 * maneja con `enabled` en su editor, B2.4b). Devuelve cuántas filas creó.
 */
export async function enableServiceForPractitioners(
  tx: Tx,
  args: { tenantId: string; serviceId: string; practitionerId: string | null }
): Promise<number> {
  const ids = args.practitionerId
    ? [args.practitionerId]
    : await acceptedPractitionerIds(tx, args.tenantId);
  return insertPractitionerServices(
    tx,
    args.tenantId,
    ids.map((practitionerId) => ({ practitionerId, serviceId: args.serviceId }))
  );
}

/**
 * Obra social nueva (o reactivada): la aceptan todos los profesionales
 * aceptados (decisión 7). El caller la llama solo si el Insurer está ACTIVO
 * (el backfill (4) solo toma activos). Devuelve cuántas filas creó.
 */
export async function enableInsurerForPractitioners(
  tx: Tx,
  args: { tenantId: string; insurerId: string }
): Promise<number> {
  const ids = await acceptedPractitionerIds(tx, args.tenantId);
  return insertPractitionerPayers(
    tx,
    args.tenantId,
    ids.map((practitionerId) => ({ practitionerId, insurerId: args.insurerId }))
  );
}

/**
 * Sincroniza con un cambio de `Tenant.businessHours*` las franjas que siguen
 * siendo la plantilla POR DEFECTO (mientras no exista el editor por
 * profesional el único lugar para cambiar el horario es Configuración →
 * General y el paso 3 del onboarding, que corre DESPUÉS de bootstrapTenant).
 *
 * "Por defecto" = exactamente 6 filas, dow 1..6, todas en la sede principal,
 * sin vigencia (validFrom/validUntil null) y todas con el horario VIEJO del
 * tenant. Un profesional cuya plantilla fue editada (otro horario, otra sede,
 * cortes, sábado libre) NO se toca. Uno sin franjas tampoco: ya sigue al
 * tenant por el fallback del loader.
 *
 * Lo llama `setBusinessHours` dentro de su tx, ANTES de actualizar el tenant
 * (handoff al integrador: lib/tenant-settings.ts no es de B2.3). Devuelve los
 * profesionales actualizados.
 */
export async function syncDefaultSchedulesToTenantHours(
  tx: Tx,
  args: { tenantId: string; from: { start: number; end: number }; to: { start: number; end: number } }
): Promise<string[]> {
  const { tenantId, from, to } = args;
  if (!isValidTenantHours(from.start, from.end) || !isValidTenantHours(to.start, to.end)) return [];
  if (from.start === to.start && from.end === to.end) return [];
  const primary = await tx.location.findFirst({
    where: { tenantId, isPrimary: true },
    select: { id: true },
  });
  if (!primary) return [];
  const rows = await tx.practitionerSchedule.findMany({
    where: { tenantId },
    select: {
      practitionerId: true,
      locationId: true,
      dow: true,
      startMin: true,
      endMin: true,
      validFrom: true,
      validUntil: true,
    },
  });
  const byPrac = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byPrac.get(r.practitionerId) ?? [];
    list.push(r);
    byPrac.set(r.practitionerId, list);
  }
  const synced: string[] = [];
  for (const [practitionerId, list] of byPrac) {
    const dows = new Set(list.map((r) => r.dow));
    const isDefault =
      list.length === DEFAULT_WORK_DOWS.length &&
      DEFAULT_WORK_DOWS.every((d) => dows.has(d)) &&
      list.every(
        (r) =>
          r.locationId === primary.id &&
          r.validFrom === null &&
          r.validUntil === null &&
          r.startMin === from.start * 60 &&
          r.endMin === from.end * 60
      );
    if (isDefault) synced.push(practitionerId);
  }
  if (synced.length) {
    // El `where` repite la condición de "por defecto" (integrador B2): si un
    // `saveWeek` del profesional commiteó entre el findMany y acá (READ
    // COMMITTED), sus filas nuevas no matchean y no se pisan.
    await tx.practitionerSchedule.updateMany({
      where: {
        tenantId,
        practitionerId: { in: synced },
        locationId: primary.id,
        validFrom: null,
        validUntil: null,
        startMin: from.start * 60,
        endMin: from.end * 60,
      },
      data: { startMin: to.start * 60, endMin: to.end * 60 },
    });
  }
  return synced;
}
