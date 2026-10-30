"use server";

/**
 * Tenant-level settings — OWNER/ADMIN only (`requireTenantAdmin`, lib/authz.ts;
 * B1.7 sacó de acá la copia local del chequeo de rol).
 *
 * T3 (C-AS1, decisiones 3 y 4 del 19-oct): el horario y la granularidad siguen en `tenant.admin` (la Secretaria con
 * «Configuración» los maneja); el turnero, «quién ve la HC» y los datos del consultorio pasan a
 * `requireTenantSensitive` (Titular, o Administrador/a o Profesional con «Configuración»; nunca la Secretaria ni
 * Facturación). Antes una Secretaria con «Configuración» abría la HC de todo el equipo con un switch.
 *
 * Settings: datos del consultorio, horario, `sharedPatientView` y (EV0, EV-K)
 * el switch del turnero público. Las "funciones del consultorio" (entitlements:
 * vertical, plan, turnero) NO se escriben acá con `tx.tenant.update`: pasan por
 * el escritor único `applyTenantEntitlementsInTx` (C-EV5), que para la source
 * `tenant-settings` solo permite `publicBookingEnabled` (vertical y plan los
 * cambia /plataforma, EV-D5/D6).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import type { SaasPlan, TenantPlan, TenantVertical } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { requireTenantAdmin, requireTenantSensitive } from "@/lib/authz";
import { withSupportWritable } from "@/lib/support-writable";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { auditInTx } from "@/lib/audit";
import { syncDefaultSchedulesToTenantHours } from "@/lib/agenda-defaults";
import { isAgendaSlotMinutes } from "@/lib/tenant-settings-constants";
import { parseBookingCapPair } from "@/lib/booking-cap-config";
import { parseTenantAgendaRules, type TenantAgendaRulesWrite } from "@/lib/agenda-rules-config";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { updateTenantProfileInTx } from "@/lib/tenant-profile-internal";
import { TenantProfileFields } from "@/lib/platform-tenants-schemas";
import type { ActionResult } from "@/lib/validation";

export type TenantSettings = {
  /** Para armar la URL del turnero (`/c/<slug>/booking`) en Configuración. */
  slug: string;
  /** Solo lectura en Configuración: la cambia /plataforma (EV-D5). */
  vertical: TenantVertical;
  /** Legado (lo espeja el escritor desde `saasPlan`, PL-D1). Para mostrar el plan usá `saasPlan`. */
  plan: TenantPlan;
  /** PL-1 (C-PL1): plan SaaS. Solo lectura en Configuración: lo cambia «Cambiar de plan» o /plataforma. */
  saasPlan: SaasPlan;
  /** Switch del turnero público (EV-D2: nace apagado). */
  publicBookingEnabled: boolean;
  name: string;
  legalName: string | null;
  taxId: string | null;
  timezone: string;
  currency: string;
  sharedPatientView: boolean;
  businessHoursStart: number;
  businessHoursEnd: number;
  /** Agenda row granularity: 60 (per hour) or 30 (half-hour rows). */
  agendaSlotMinutes: number;
  /**
   * T3 (C-AS3, M12): tope de turnos por profesional del consultorio, «N cada X min». Los dos o ninguno (null/null =
   * sin tope); lo hereda cada profesional en INHERIT. Se edita con `setTenantBookingCap`.
   */
  bookingCapCount: number | null;
  bookingCapIntervalMin: number | null;
  /**
   * CF (M20, decisiones 3 y 6): reglas de agenda del consultorio, crudas (NULL = default: paso 15 en la agenda,
   * automático en el turnero, anticipación 60'). Las hereda cada profesional sin valor propio. Se editan con
   * `setTenantAgendaRules`. Requeridos (CF-U4): los traen `getTenantSettings` y el `tenant` de
   * `lib/configuracion-page-loader.ts` (mismo select; el test de igualdad de PF2-d lo fija).
   */
  agendaSlotStepMin: number | null;
  publicSlotStepMin: number | null;
  publicMinLeadMinutes: number | null;
  /** BO2-D: ISO de `Tenant.updatedAt`, para el CAS opcional de `updateTenantBasics`. */
  updatedAt: string;
};

export async function getTenantSettings(): Promise<TenantSettings> {
  const actor = await getActor();
  const { updatedAt, ...t } = await runWithRls(actor.tenantId, (tx) => tx.tenant.findUniqueOrThrow({
    where: { id: actor.tenantId },
    select: {
      slug: true,
      vertical: true,
      plan: true,
      saasPlan: true,
      publicBookingEnabled: true,
      name: true,
      legalName: true,
      taxId: true,
      timezone: true,
      currency: true,
      sharedPatientView: true,
      businessHoursStart: true,
      businessHoursEnd: true,
      agendaSlotMinutes: true,
      bookingCapCount: true,
      bookingCapIntervalMin: true,
      agendaSlotStepMin: true,
      publicSlotStepMin: true,
      publicMinLeadMinutes: true,
      updatedAt: true,
    },
  }));
  return { ...t, updatedAt: updatedAt.toISOString() };
}

export async function setBusinessHours(...args: Parameters<typeof setBusinessHoursImpl>): ReturnType<typeof setBusinessHoursImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/tenant-settings.ts#setBusinessHours", () => setBusinessHoursImpl(...args)));
}

async function setBusinessHoursImpl(input: {
  start: number;
  end: number;
  /** Optional so existing callers keep working; only 30 or 60 accepted. */
  slotMinutes?: number;
}): Promise<ActionResult> {
  const actor = await requireTenantAdmin();
  const start = Math.floor(input.start);
  const end = Math.floor(input.end);
  const slotMinutes = input.slotMinutes == null ? null : Math.floor(input.slotMinutes);
  if (slotMinutes != null && !isAgendaSlotMinutes(slotMinutes)) {
    return { ok: false, error: "La vista de agenda admite 15, 30 o 60 minutos." };
  }
  // Constants live in lib/tenant-settings-constants.ts so the UI can
  // import them — "use server" files can only export async functions.
  const MIN = 6;
  const MAX = 23;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < MIN ||
    end > MAX ||
    start >= end
  ) {
    return {
      ok: false,
      error: `Rango inválido. Inicio debe ser entre ${MIN}:00 y ${MAX - 1}:00, fin debe ser mayor que inicio y ≤ ${MAX}:00.`,
    };
  }
  // La plantilla POR DEFECTO de cada profesional (lun-sáb, sede principal, el
  // horario viejo del tenant) sigue al horario del consultorio; una editada no
  // se toca (`syncDefaultSchedulesToTenantHours`, B2.3 → integrador B2). Todo
  // en la misma tx: si el update del tenant falla, las franjas no se mueven.
  const synced = await runWithRls(actor.tenantId, async (tx) => {
    // FOR UPDATE: dos cambios de horario simultáneos se serializan; si no, el
    // segundo leería el horario "viejo" ya pisado y no reconocería la plantilla.
    const [prev] = await tx.$queryRaw<{ businessHoursStart: number; businessHoursEnd: number }[]>`
      SELECT "businessHoursStart", "businessHoursEnd" FROM "Tenant" WHERE "id" = ${actor.tenantId} FOR UPDATE`;
    const syncedIds = prev
      ? await syncDefaultSchedulesToTenantHours(tx, {
          tenantId: actor.tenantId,
          from: { start: prev.businessHoursStart, end: prev.businessHoursEnd },
          to: { start, end },
        })
      : [];
    await tx.tenant.update({
      where: { id: actor.tenantId },
      data: {
        businessHoursStart: start,
        businessHoursEnd: end,
        ...(slotMinutes != null ? { agendaSlotMinutes: slotMinutes } : {}),
      },
    });
    return syncedIds;
  });
  // PL-A2 (§20.5.9): el horario del consultorio es configuración operativa, sin audit.
  // Wide blast radius — every booking surface re-reads the window.
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

/**
 * Tope de turnos por profesional del consultorio (T3, decisión 6 del 19-oct; C-AS3; plan §23.7): «Máximo de turnos
 * por profesional: N cada 15/30/60 min». `{ count: null, intervalMin: null }` = sin tope. Lo hereda cada profesional
 * en `INHERIT` (`lib/availability/interval-cap.ts#effectiveIntervalCap`).
 *
 * `tenant.admin` como el horario (lo operativo de la agenda: la Secretaria con «Configuración» lo maneja, decisión 3)
 * y `withSupportWritable` como el resto de Configuración operativa. A diferencia del horario, se audita: cambia qué
 * turno entra como sobreturno y qué ofrece el turnero, y «¿quién puso el tope?» es la primera pregunta cuando un
 * paciente no encuentra horario. Audit en la MISMA tx (el evento existe si y solo si el cambio existe); el mismo
 * valor = ni write ni audit. Sin CAS: son dos valores absolutos que se guardan juntos (el último que guarda gana,
 * como el horario); `FOR UPDATE` solo para que el `from` del audit sea el que realmente se pisó.
 */
export async function setTenantBookingCap(...args: Parameters<typeof setTenantBookingCapImpl>): ReturnType<typeof setTenantBookingCapImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/tenant-settings.ts#setTenantBookingCap", () => setTenantBookingCapImpl(...args)));
}

async function setTenantBookingCapImpl(input: { count: number | null; intervalMin: number | null }): Promise<ActionResult> {
  const actor = await requireTenantAdmin();
  // El CHECK `Tenant_bookingCap_check` (M12) rebotaría un par a medias como un 500 sin copy: se valida antes.
  const parsed = parseBookingCapPair(input?.count, input?.intervalMin);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const to = parsed.cap;
  const changed = await runWithRls(actor.tenantId, async (tx) => {
    const [prev] = await tx.$queryRaw<{ bookingCapCount: number | null; bookingCapIntervalMin: number | null }[]>`
      SELECT "bookingCapCount", "bookingCapIntervalMin" FROM "Tenant" WHERE "id" = ${actor.tenantId} FOR UPDATE`;
    const from =
      prev && prev.bookingCapCount != null && prev.bookingCapIntervalMin != null
        ? { count: prev.bookingCapCount, intervalMin: prev.bookingCapIntervalMin }
        : null;
    if (from?.count === to?.count && from?.intervalMin === to?.intervalMin) return false;
    await tx.tenant.update({
      where: { id: actor.tenantId },
      data: { bookingCapCount: to?.count ?? null, bookingCapIntervalMin: to?.intervalMin ?? null },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "tenant.booking_cap",
      entity: "Tenant",
      entityId: actor.tenantId,
      payload: { from, to },
    });
    return true;
  });
  if (changed) {
    // El modal de turnos, el lote y el turnero leen el tope en cada request (sin cache por tenant): alcanza con las
    // rutas que lo muestran ya pintado.
    revalidatePath("/configuracion");
    revalidatePath("/agenda");
    revalidatePath("/dashboard");
  }
  return { ok: true, data: undefined };
}

/**
 * Reglas de agenda del consultorio (CF, §28; M20; decisiones 3 y 6, CF-D8/CF-D11): intervalo de horarios de la
 * agenda (15/30/45/60), del turnero (automático o 15/30/45/60) y anticipación mínima del turnero (0..8 semanas, en
 * minutos). NULL = default (hereda). Se manda el form ENTERO (los tres valores, CF-K): un campo ausente es NULL.
 *
 * Mismo patrón que `setTenantBookingCap` (por eso `tenant.admin` —la Secretaria con «Configuración» lo maneja— y
 * `withSupportWritable`): cambia qué horarios ve el staff y cuáles ofrece el turnero, así que se audita
 * (`tenant.agenda_rules`, con el antes y el después) en la MISMA tx; el mismo valor = ni write ni audit; `FOR UPDATE`
 * solo para que el `from` del audit sea el que se pisó. La regla de cada valor la valida `parseTenantAgendaRules`
 * antes de escribir: el CHECK de M20 rebotaría como un 500 («No pudimos guardar») sin decir qué campo corregir.
 */
export async function setTenantAgendaRules(...args: Parameters<typeof setTenantAgendaRulesImpl>): ReturnType<typeof setTenantAgendaRulesImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/tenant-settings.ts#setTenantAgendaRules", () => setTenantAgendaRulesImpl(...args)));
}

// Forma en el borde (zod): números o strings de dígitos (un <select> manda strings), vacío = NULL. El rango y la
// lista de valores los decide `parseTenantAgendaRules`, que devuelve el copy y el campo.
const AgendaRuleValue = z.union([z.number(), z.string().max(16), z.null()]).optional();
const TenantAgendaRulesInput = z.object({
  agendaSlotStepMin: AgendaRuleValue,
  publicSlotStepMin: AgendaRuleValue,
  publicMinLeadMinutes: AgendaRuleValue,
});

async function setTenantAgendaRulesImpl(input: {
  agendaSlotStepMin: number | string | null;
  publicSlotStepMin: number | string | null;
  publicMinLeadMinutes: number | string | null;
}): Promise<ActionResult> {
  const actor = await requireTenantAdmin();
  const shape = TenantAgendaRulesInput.safeParse(input ?? {});
  if (!shape.success) return { ok: false, error: "Datos inválidos" };
  const parsed = parseTenantAgendaRules(shape.data);
  if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { [parsed.field]: [parsed.error] } };
  const to = parsed.data;
  const changed = await runWithRls(actor.tenantId, async (tx) => {
    const [prev] = await tx.$queryRaw<TenantAgendaRulesWrite[]>`
      SELECT "agendaSlotStepMin", "publicSlotStepMin", "publicMinLeadMinutes"
        FROM "Tenant" WHERE "id" = ${actor.tenantId} FOR UPDATE`;
    if (!prev) return false;
    const from: TenantAgendaRulesWrite = {
      agendaSlotStepMin: prev.agendaSlotStepMin,
      publicSlotStepMin: prev.publicSlotStepMin,
      publicMinLeadMinutes: prev.publicMinLeadMinutes,
    };
    if (
      from.agendaSlotStepMin === to.agendaSlotStepMin &&
      from.publicSlotStepMin === to.publicSlotStepMin &&
      from.publicMinLeadMinutes === to.publicMinLeadMinutes
    ) {
      return false;
    }
    await tx.tenant.update({ where: { id: actor.tenantId }, data: to });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "tenant.agenda_rules",
      entity: "Tenant",
      entityId: actor.tenantId,
      payload: { from, to },
    });
    return true;
  });
  if (changed) {
    // Igual que el tope: el selector del staff y el turnero leen las reglas en cada request (loader sin cache por
    // tenant); alcanza con las rutas que las muestran ya pintadas.
    revalidatePath("/configuracion");
    revalidatePath("/agenda");
    revalidatePath("/dashboard");
  }
  return { ok: true, data: undefined };
}

// EV1-E2 (readonly-residual-actions): el `ReadOnlyModeError` de la tx sale como `{ ok:false, error }` y no
// como excepción, que en prod Next redacta (lib/read-only-result.ts). Sin withSupportWritable: soporte no
// cambia quién ve la HC (fuera de C-BO4).
export async function setSharedPatientView(...args: Parameters<typeof setSharedPatientViewImpl>): ReturnType<typeof setSharedPatientViewImpl> {
  return withReadOnlyResult(() => setSharedPatientViewImpl(...args));
}

async function setSharedPatientViewImpl(value: boolean): Promise<ActionResult> {
  // T3 (C-AS1): decide quién ve la HC de quién: lo delicado, no lo operativo.
  const actor = await requireTenantSensitive();
  // PL-A2 (§20.5.9): abre o cierra el acceso del equipo a pacientes ajenos (seguridad) →
  // audit en la misma tx: el evento existe si y solo si el cambio existe.
  await runWithRls(actor.tenantId, async (tx) => {
    await tx.tenant.update({
      where: { id: actor.tenantId },
      data: { sharedPatientView: value },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "tenant.shared_view",
      entity: "Tenant",
      entityId: actor.tenantId,
      payload: { sharedPatientView: value },
    });
  });
  revalidatePath("/configuracion");
  revalidatePath("/pacientes");
  revalidatePath("/agenda");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

const publicBookingSchema = z.boolean();

/**
 * Prende/apaga el turnero público del consultorio (EV0, EV-K; EV-D2 = opt-in).
 *
 * Sin CAS (`expectedUpdatedAt`): es un booleano absoluto, el último que guarda
 * gana (como `setSharedPatientView`); el CAS de C-EV5 es para el Drawer de
 * /plataforma, que edita varias columnas a la vez. Mismo valor = no-op del
 * escritor: ni write ni audit, y no se revalida nada.
 */
export async function setPublicBookingEnabled(...args: Parameters<typeof setPublicBookingEnabledImpl>): ReturnType<typeof setPublicBookingEnabledImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/tenant-settings.ts#setPublicBookingEnabled", () => setPublicBookingEnabledImpl(...args)));
}

async function setPublicBookingEnabledImpl(enabled: boolean): Promise<ActionResult> {
  // T3 (C-AS1, decisión 3): el turnero online abre la agenda al público; la Secretaria nunca lo prende.
  const actor = await requireTenantSensitive();
  const parsed = publicBookingSchema.safeParse(enabled);
  if (!parsed.success) return { ok: false, error: "Valor inválido para el turnero público." };

  const r = await runWithRls(actor.tenantId, (tx) =>
    applyTenantEntitlementsInTx(tx, {
      tenantId: actor.tenantId,
      source: "tenant-settings",
      patch: { publicBookingEnabled: parsed.data },
      actor: { userId: actor.userId, homeTenantId: actor.tenantId },
    })
  );
  if (!r.ok) {
    // Sin expectedUpdatedAt ni source onboarding, el único motivo posible es
    // `not-found` (tenant borrado entre getActor y la tx).
    return { ok: false, error: "No encontramos el consultorio. Recargá la página." };
  }
  // Después del commit y solo si hubo cambio (contrato EV-C2): los módulos
  // (`turneroPublico`) se leen en el layout y en caches por tenant.
  if (r.changed.length > 0) {
    for (const tag of tenantEntitlementTags(actor.tenantId)) revalidateTag(tag);
    revalidatePath("/", "layout");
  }
  return { ok: true, data: undefined };
}

const TenantBasicsInput = TenantProfileFields.pick({ name: true, legalName: true, taxId: true }).extend({
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

/**
 * Nombre, razón social y CUIT desde Configuración. BO2-D: pasa por el núcleo compartido con /plataforma
 * (`updateTenantProfileInTx`: FOR UPDATE + diff + CAS opcional), porque ahora el superadmin edita las mismas
 * columnas. Sin `expectedUpdatedAt` (el form de hoy no lo manda) el último que guarda gana, como antes; con él,
 * un cambio del superadmin en el medio devuelve el error de «otro cambio» en vez de pisarse. Sin cambios reales
 * no se audita (antes cada submit dejaba un `tenant.update` aunque no cambiara nada).
 */
export async function updateTenantBasics(...args: Parameters<typeof updateTenantBasicsImpl>): ReturnType<typeof updateTenantBasicsImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/tenant-settings.ts#updateTenantBasics", () => updateTenantBasicsImpl(...args)));
}

async function updateTenantBasicsImpl(input: {
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
  expectedUpdatedAt?: string;
}): Promise<ActionResult> {
  // T3 (C-AS1): nombre, razón social y CUIT salen en comprobantes y en el turnero: lo delicado.
  const actor = await requireTenantSensitive();
  const parsed = TenantBasicsInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    const first = Object.values(fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? "Datos inválidos", fieldErrors };
  }
  const { expectedUpdatedAt, ...patch } = parsed.data;
  if (Object.values(patch).every((v) => v === undefined)) return { ok: true, data: undefined };

  const r = await runWithRls(actor.tenantId, async (tx) => {
    const res = await updateTenantProfileInTx(tx, {
      tenantId: actor.tenantId,
      patch,
      expectedUpdatedAt: expectedUpdatedAt ? new Date(expectedUpdatedAt) : undefined,
    });
    if (res.ok && res.changed.length > 0) {
      // En la misma tx: el evento existe si y solo si el cambio existe. Solo las claves (los valores son datos
      // del consultorio, no PHI, pero el log no necesita la foto).
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "tenant.update",
        entity: "Tenant",
        entityId: actor.tenantId,
        payload: { changed: res.changed },
      });
    }
    return res;
  });
  if (!r.ok) {
    if (r.reason === "stale") return { ok: false, error: "Otro cambio se guardó antes. Recargá y revisá." };
    return { ok: false, error: "No encontramos el consultorio. Recargá la página." };
  }
  if (r.changed.length > 0) {
    revalidatePath("/configuracion");
    // El nombre se ve en el shell (selector de consultorio, encabezado).
    if (r.changed.includes("name")) revalidatePath("/", "layout");
  }
  return { ok: true, data: undefined };
}
