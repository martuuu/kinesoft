"use server";

/**
 * Servicios por profesional (B2.4b CFG-api-2, B-pre): qué servicios ofrece
 * cada profesional y con qué reglas (duración, visibilidad en el turnero,
 * anticipación, horizonte, cupo propio, aviso al reservar).
 *
 * ADR (bpre-design §B): `PractitionerService` cuelga de `Service`, no de la
 * práctica del catálogo — Booking.serviceId, cupo, copago (§5.5), facturación
 * y webhook giran alrededor de Service. El motor (`lib/availability/*`) lee
 * estas filas vía el loader; los null heredan del Service / del canal.
 *
 * Auth: `schedule.configure` (hoy OWNER/ADMIN, `lib/capabilities.ts`): los
 * horarios y servicios por profesional cambian la disponibilidad del turnero
 * público y del batch de Planes.
 *
 * Aislamiento: `where: { tenantId }` a mano en cada lectura (en prod la
 * conexión tiene BYPASSRLS) y el profesional y el servicio se validan contra
 * el tenant DENTRO de la tx de escritura: las FK de PractitionerService
 * saltean RLS, así que sin esto un admin podría colgar el servicio de otro
 * consultorio de su profesional (IDOR).
 */
import { revalidatePath } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { requireCapability } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import type { ActionResult } from "@/lib/validation";
import {
  EntityId,
  PractitionerServiceInput,
  type PractitionerServiceInputT,
  type PractitionerServiceRow,
} from "@/lib/practitioner-config-schemas";

const CONFIG_MSG = "Solo OWNER/ADMIN pueden configurar los servicios de los profesionales.";

export async function listPractitionerServices(
  practitionerId: string
): Promise<ActionResult<PractitionerServiceRow[]>> {
  const { actor } = await requireCapability("schedule.configure", CONFIG_MSG);
  const pid = EntityId.safeParse(practitionerId);
  if (!pid.success) return { ok: false, error: "Profesional inválido." };
  const tenantId = actor.tenantId;

  const rows = await runWithRls(tenantId, async (tx) => {
    const prac = await tx.practitioner.findFirst({
      where: { id: pid.data, tenantId },
      select: { id: true },
    });
    if (!prac) return null;
    const [services, ps] = await Promise.all([
      tx.service.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          color: true,
          durationMin: true,
          maxConcurrent: true,
          practitionerId: true,
        },
      }),
      tx.practitionerService.findMany({
        where: { tenantId, practitionerId: prac.id },
      }),
    ]);
    const byService = new Map(ps.map((r) => [r.serviceId, r]));
    return services.map((s): PractitionerServiceRow => {
      const r = byService.get(s.id);
      return {
        serviceId: s.id,
        serviceName: s.name,
        serviceColor: s.color,
        serviceDurationMin: s.durationMin,
        serviceMaxConcurrent: s.maxConcurrent,
        serviceOwnerPractitionerId: s.practitionerId,
        hasRow: !!r,
        // Sin fila: el default del backfill (ver PractitionerServiceRow).
        enabled: r ? r.enabled : s.practitionerId === null || s.practitionerId === prac.id,
        durationMin: r?.durationMin ?? null,
        visibility: r?.visibility ?? "PUBLIC",
        minLeadMinutes: r?.minLeadMinutes ?? null,
        maxLeadDays: r?.maxLeadDays ?? null,
        concurrencyOverride: r?.concurrencyOverride ?? false,
        maxConcurrent: r?.maxConcurrent ?? null,
        notifyOnBooking: r?.notifyOnBooking ?? false,
      };
    });
  });
  if (!rows) return { ok: false, error: "Profesional no encontrado." };
  return { ok: true, data: rows };
}

// EV1-E2 (readonly-residual-actions): el `ReadOnlyModeError` de la tx sale como `{ ok:false, error }` y no
// como excepción, que en prod Next redacta (lib/read-only-result.ts). Fuera de la allowlist de soporte.
export async function upsertPractitionerService(...args: Parameters<typeof upsertPractitionerServiceImpl>): ReturnType<typeof upsertPractitionerServiceImpl> {
  return withReadOnlyResult(() => upsertPractitionerServiceImpl(...args));
}

async function upsertPractitionerServiceImpl(
  practitionerId: string,
  serviceId: string,
  raw: PractitionerServiceInputT
): Promise<ActionResult<{ id: string }>> {
  const { actor } = await requireCapability("schedule.configure", CONFIG_MSG);
  const pid = EntityId.safeParse(practitionerId);
  const sid = EntityId.safeParse(serviceId);
  if (!pid.success || !sid.success) return { ok: false, error: "Datos inválidos" };
  const parsed = PractitionerServiceInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const data = parsed.data;
  const tenantId = actor.tenantId;

  let result:
    | { kind: "ok"; id: string; before: Record<string, unknown> | null }
    | { kind: "error"; error: string };
  try {
    result = await runWithRls(tenantId, async (tx) => {
      // Ambos ids contra el tenant, en la misma tx que escribe (las FK
      // saltean RLS: el servicio de OTRO consultorio pasaría la FK).
      const [prac, svc] = await Promise.all([
        tx.practitioner.findFirst({ where: { id: pid.data, tenantId }, select: { id: true } }),
        tx.service.findFirst({ where: { id: sid.data, tenantId }, select: { id: true } }),
      ]);
      if (!prac) return { kind: "error" as const, error: "Profesional no encontrado." };
      if (!svc) return { kind: "error" as const, error: "Servicio no encontrado." };

      const before = await tx.practitionerService.findUnique({
        where: { practitionerId_serviceId: { practitionerId: prac.id, serviceId: svc.id } },
      });
      // Defensa en profundidad: la clave única es (practitionerId, serviceId)
      // y ambos ya son del tenant, así que una fila existente también lo es;
      // si no (dato corrupto), no la pisamos.
      if (before && before.tenantId !== tenantId) {
        return { kind: "error" as const, error: "Servicio no encontrado." };
      }
      const row = await tx.practitionerService.upsert({
        where: { practitionerId_serviceId: { practitionerId: prac.id, serviceId: svc.id } },
        create: { tenantId, practitionerId: prac.id, serviceId: svc.id, ...data },
        update: data,
        select: { id: true },
      });
      return {
        kind: "ok" as const,
        id: row.id,
        before: before
          ? {
              enabled: before.enabled,
              durationMin: before.durationMin,
              visibility: before.visibility,
              minLeadMinutes: before.minLeadMinutes,
              maxLeadDays: before.maxLeadDays,
              concurrencyOverride: before.concurrencyOverride,
              maxConcurrent: before.maxConcurrent,
              notifyOnBooking: before.notifyOnBooking,
            }
          : null,
      };
    });
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    logger.error("practitionerService.upsert.failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: "No pudimos guardar el servicio del profesional." };
  }
  if (result.kind === "error") return { ok: false, error: result.error };

  await audit({
    tenantId,
    actorId: actor.userId,
    action: "practitionerService.upsert",
    entity: "PractitionerService",
    entityId: result.id,
    payload: { practitionerId: pid.data, serviceId: sid.data, before: result.before, after: data },
  });
  // Sin tag de disponibilidad todavía (B3.3 lo crea con getAgendaAvailability):
  // la agenda y Configuración se re-renderizan por path.
  revalidatePath("/agenda");
  revalidatePath("/configuracion");
  return { ok: true, data: { id: result.id } };
}
