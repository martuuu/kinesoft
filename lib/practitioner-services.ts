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
 * Auth: el propio profesional o `schedule.configure` («Configuración»). Hasta
 * CF2 era solo `schedule.configure`; CF3 (AU-S, D-CF3-7, decisión de Martin del
 * 04-nov) le devuelve al profesional SU config de servicios (habilitar,
 * duración, visibilidad, precio y aviso al reservar) desde «Mi
 * agenda». Gate y validación en la tx: `lib/practitioner-self-scope.ts`. CF3 ZF1 (M2): por el camino propio, el
 * cupo propio por horario, la anticipación y el horizonte DEL SERVICIO no se tocan (son del consultorio). Por el
 * camino propio NO se habilita el servicio propio de OTRO profesional
 * (`Service.practitionerId` ajeno: «servicio propio no habilitado a otros»,
 * §30.5) y la lista no se lo ofrece; con «Configuración», como hasta hoy.
 *
 * Audit (`auditInTx`, en la tx del write, `practitionerService.update`): el
 * camino propio SIEMPRE (es la superficie nueva: alguien sin «Configuración»
 * cambia la disponibilidad del turnero) y cualquier cambio de precio (plata,
 * §20.5.9). Por «Configuración» sin cambio de precio sigue sin audit: ruido
 * operativo del recorte PL-A ([PL-A2]).
 *
 * Aislamiento: `where: { tenantId }` a mano en cada lectura (en prod la
 * conexión tiene BYPASSRLS) y el profesional y el servicio se validan contra
 * el tenant DENTRO de la tx de escritura: las FK de PractitionerService
 * saltean RLS, así que sin esto un admin podría colgar el servicio de otro
 * consultorio de su profesional (IDOR).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { auditInTx } from "@/lib/audit";
import { assertSelfOrScheduleConfigure, writablePractitionerWhere } from "@/lib/practitioner-self-scope";
import { logger } from "@/lib/logger";
import { tags } from "@/lib/cache-tags";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import type { ActionResult } from "@/lib/validation";
import {
  EntityId,
  PractitionerServiceInput,
  type PractitionerServiceInputT,
  type PractitionerServiceRow,
} from "@/lib/practitioner-config-schemas";

// Sin «OWNER/ADMIN» (jerga): desde CF3 el propio profesional también edita lo suyo.
const CONFIG_MSG = "Solo podés cambiar tus propios servicios. Para los de otro profesional hace falta el permiso «Configuración».";
const FOREIGN_OWNED_MSG = "Ese servicio es de otro profesional.";

export async function listPractitionerServices(
  practitionerId: string
): Promise<ActionResult<PractitionerServiceRow[]>> {
  const actor = await getActor();
  const pid = EntityId.safeParse(practitionerId);
  if (!pid.success) return { ok: false, error: "Profesional inválido." };
  // CF3 AU-S: propio o «Configuración» (la lectura del editor es la misma superficie que su escritura: con
  // `agenda.viewAll` un kine leería los precios y reglas de los demás, que no edita).
  const { via } = await assertSelfOrScheduleConfigure(actor, pid.data, CONFIG_MSG);
  const tenantId = actor.tenantId;

  const rows = await runWithRls(tenantId, async (tx) => {
    // T3c-1s (AS-1s): solo profesionales RESERVABLES (ver `bookablePractitionerWhere`); la lista de Configuración ya
    // no muestra al suspendido ni al deshabilitado, y su escritura se rechaza igual: leer su config no sirve de nada.
    // CF3: por el camino propio, además, del usuario del actor (`writablePractitionerWhere`).
    const prac = await tx.practitioner.findFirst({
      where: writablePractitionerWhere(actor, pid.data, via),
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
          priceCents: true,
        },
      }),
      tx.practitionerService.findMany({
        where: { tenantId, practitionerId: prac.id },
      }),
    ]);
    const byService = new Map(ps.map((r) => [r.serviceId, r]));
    // CF3: por el camino propio no se ofrece el servicio propio de OTRO profesional (tampoco se puede habilitar).
    const offered = via === "self" ? services.filter((s) => s.practitionerId === null || s.practitionerId === prac.id) : services;
    return offered.map((s): PractitionerServiceRow => {
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
        priceCents: r?.priceCents ?? null,
        servicePriceCents: s.priceCents,
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
  const actor = await getActor();
  const pid = EntityId.safeParse(practitionerId);
  const sid = EntityId.safeParse(serviceId);
  if (!pid.success || !sid.success) return { ok: false, error: "Datos inválidos" };
  const { via } = await assertSelfOrScheduleConfigure(actor, pid.data, CONFIG_MSG);
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
        // T3c-1s (AS-1s, §23.2): + reservable (membresía aceptada que atiende, sin suspender, usuario no
        // deshabilitado en Plataforma). Antes alcanzaba el tenant: se le habilitaban servicios a un suspendido o a la
        // Secretaria con su fila `Practitioner` vieja. Mismo EXISTS en la misma sentencia.
        // CF3: con `via: "self"`, además, del usuario del actor (`writablePractitionerWhere`).
        tx.practitioner.findFirst({
          where: writablePractitionerWhere(actor, pid.data, via),
          select: { id: true },
        }),
        tx.service.findFirst({ where: { id: sid.data, tenantId }, select: { id: true, practitionerId: true } }),
      ]);
      if (!prac) return { kind: "error" as const, error: "Profesional no encontrado." };
      if (!svc) return { kind: "error" as const, error: "Servicio no encontrado." };
      if (via === "self" && svc.practitionerId !== null && svc.practitionerId !== prac.id) {
        return { kind: "error" as const, error: FOREIGN_OWNED_MSG };
      }

      const before = await tx.practitionerService.findUnique({
        where: { practitionerId_serviceId: { practitionerId: prac.id, serviceId: svc.id } },
      });
      // Defensa en profundidad: la clave única es (practitionerId, serviceId)
      // y ambos ya son del tenant, así que una fila existente también lo es;
      // si no (dato corrupto), no la pisamos.
      if (before && before.tenantId !== tenantId) {
        return { kind: "error" as const, error: "Servicio no encontrado." };
      }
      // CF3 ZF1 (M2, D-CF3-7): por el camino propio la capacidad del servicio (cupo propio por horario) y su ventana de
      // reserva (anticipación y horizonte) siguen siendo del consultorio: se conservan las de la fila (o los defaults
      // sin fila) aunque el pedido traiga otras. La anticipación del profesional va por «Mi agenda» (por profesional,
      // no por servicio). El aviso al reservar sí es suyo.
      const write =
        via === "self"
          ? {
              ...data,
              concurrencyOverride: before?.concurrencyOverride ?? false,
              maxConcurrent: before?.maxConcurrent ?? null,
              minLeadMinutes: before?.minLeadMinutes ?? null,
              maxLeadDays: before?.maxLeadDays ?? null,
            }
          : data;
      const row = await tx.practitionerService.upsert({
        where: { practitionerId_serviceId: { practitionerId: prac.id, serviceId: svc.id } },
        create: { tenantId, practitionerId: prac.id, serviceId: svc.id, ...write },
        update: write,
        select: { id: true },
      });
      const fromPrice = before?.priceCents ?? null;
      const priceChanged = data.priceCents !== undefined && data.priceCents !== fromPrice;
      if (via === "self" || priceChanged) {
        // Ver la cabecera: el camino propio siempre; por «Configuración» solo la plata. Ids y valores de config (sin PHI).
        await auditInTx(tx, {
          tenantId,
          actorId: actor.userId,
          action: "practitionerService.update",
          entity: "PractitionerService",
          entityId: row.id,
          payload: {
            via,
            practitionerId: prac.id,
            serviceId: svc.id,
            from: before ? configSnapshot(before) : null,
            to: configSnapshot({ ...write, priceCents: data.priceCents === undefined ? fromPrice : data.priceCents }),
          },
        });
      }
      return {
        kind: "ok" as const,
        id: row.id,
        before: before ? configSnapshot(before) : null,
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

  // Sin tag de disponibilidad todavía (B3.3 lo crea con getAgendaAvailability):
  // la agenda y Configuración se re-renderizan por path.
  revalidatePath("/agenda");
  revalidatePath("/configuracion");
  // DIR-2b (C-DIR4): la visibilidad PUBLIC de un servicio decide si el profesional es reservable (directorio).
  revalidateTag(tags.directory());
  return { ok: true, data: { id: result.id } };
}

/** Lo que se audita de una fila (y el `before` del resultado): solo config, sin ids del tenant ni timestamps. */
function configSnapshot(r: {
  enabled: boolean;
  durationMin: number | null;
  visibility: string;
  minLeadMinutes: number | null;
  maxLeadDays: number | null;
  concurrencyOverride: boolean;
  maxConcurrent: number | null;
  notifyOnBooking: boolean;
  priceCents: number | null;
}): Record<string, unknown> {
  return {
    enabled: r.enabled,
    durationMin: r.durationMin,
    visibility: r.visibility,
    minLeadMinutes: r.minLeadMinutes,
    maxLeadDays: r.maxLeadDays,
    concurrencyOverride: r.concurrencyOverride,
    maxConcurrent: r.maxConcurrent,
    notifyOnBooking: r.notifyOnBooking,
    priceCents: r.priceCents,
  };
}
