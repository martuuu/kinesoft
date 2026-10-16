import "server-only";
/**
 * PF2-d (C-PF8): datos de `/configuracion` en ≤ 3 transacciones (antes 11 de la página + 2 de plata = 13 por carga
 * del Titular, medido con `tests/integration/pf2-config-budget.test.ts`).
 *
 * Por qué: la página pedía cada pestaña con su lector, y cada lector abría su `runWithRls` (BEGIN + `set_config` +
 * consulta + COMMIT = 4 idas y vueltas por lectura). Con Supavisor en modo transacción eso son 11 conexiones del
 * pool por carga; en misma región cada tx suma ~4 RTT y en una región cruzada el total se iba a 3,3 s (PERF.md,
 * tabla «antes» de PF-0b). Ahora: UNA tx con todas las lecturas de Configuración (en serie sobre la misma conexión)
 * y, en paralelo con ella, los lectores de plata de PL tal como están (`getTenantPlanUsage`, `getBillingOverview`:
 * contrato de plata, no se reescriben) y el catálogo público (`unstable_cache`, canal de servicio, sin tx).
 *
 * Qué NO cambia (el test compara contra los lectores reales, uno por uno):
 *   - qué se lee para quién: las mismas capacidades por pestaña que la página de PL-F1b (`tenant.admin`,
 *     `schedule.configure`, `account.billing`, `!actor.support`) y los mismos chequeos de cada lector (los que
 *     tiraban `ForbiddenError` y daban un 500 de la página, lo siguen haciendo ANTES de abrir la tx; los que
 *     devolvían `null` por `unlessForbidden`, devuelven `null`);
 *   - el módulo: `diagnostico` para las patologías propias, `salas` para las salas (`[]` sin el módulo);
 *   - cada fila: las de services/insurers/locations/rooms/invitations salen de sus `*-read.ts` (los MISMOS que usan
 *     sus lectores); las de tenant-settings, conditions, practitioner-schedule y platform-support (archivos que esta
 *     sesión no toca) se leen acá con la misma consulta, y el test de igualdad es la red contra el desvío.
 *
 * Lo que se pierde a propósito: `listServicesWithCounts`/`listInsurers` estaban detrás de `unstable_cache`; acá van
 * frescos dentro de la tx ya abierta (1 sentencia cada uno, sin tx extra). Configuración es donde se editan: leerlos
 * frescos nunca muestra algo viejo.
 *
 * `where: { tenantId }` a mano en cada consulta (en prod la conexión tiene BYPASSRLS: es la única barrera).
 */
import { runWithRls, type DbClient } from "@/lib/rls";
import { ForbiddenError, getAccessSnapshot, type Actor } from "@/lib/session";
import type { Capability } from "@/lib/capabilities";
import { modulesFor, roomsEnabled } from "@/lib/tenant-modules";
import { displayMemberName } from "@/lib/display-name";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { summarizeWeek, dayKeyToDbDate } from "@/lib/schedule-validate";
import { toARDateKey } from "@/lib/datetime-ar";
import { FALLBACK_WORKING_DOWS } from "@/lib/availability/types";
import { toSupportSessionRow, type SupportSessionRow } from "@/lib/support-session-internal";
import { listInsurersInTx } from "@/lib/insurers-read";
import { listServicesWithCountsInTx } from "@/lib/services-read";
import { listLocationsInTx } from "@/lib/locations-read";
import { listRoomsInTx } from "@/lib/rooms-read";
import { listPendingInvitationsInTx, listTeamMembersInTx } from "@/lib/invitations-read";
import { getTenantPlanUsage } from "@/lib/tenant-plan-usage";
import { getBillingOverview } from "@/lib/saas-billing";
import { getPublicPlanCatalog } from "@/lib/saas-plans-public";
import type { TenantSettings } from "@/lib/tenant-settings";
import type { InsurerRow } from "@/lib/insurers-types";
import type { ServiceRow } from "@/lib/services-types";
import type { InvitationRow, TeamMemberRow } from "@/lib/invitations-types";
import type { CustomConditionRow } from "@/lib/conditions";
import type { LocationRow } from "@/lib/locations-schemas";
import type { RoomRow } from "@/lib/rooms-schemas";
import type { PractitionerScheduleSummaryRow } from "@/lib/practitioner-schedule-schemas";

/** Mismo texto que `READ_MSG` de lib/locations.ts y lib/practitioner-schedule.ts (lo que tiraban sus lectores). */
const AGENDA_READ_MSG = "No tenés permiso para ver la agenda del consultorio.";

export type ConfiguracionTxData = {
  tenant: TenantSettings | null;
  insurers: InsurerRow[];
  services: ServiceRow[];
  /** `null` = sin acceso a Usuarios (la pestaña no se muestra), como el `unlessForbidden` de antes. */
  team: TeamMemberRow[] | null;
  pending: InvitationRow[] | null;
  practitioners: { id: string; name: string }[];
  customConditions: CustomConditionRow[];
  locations: LocationRow[];
  scheduleSummary: PractitionerScheduleSummaryRow[];
  rooms: RoomRow[];
  supportSessions: SupportSessionRow[] | null;
};

type Gates = {
  tenantAdmin: boolean;
  team: boolean;
  rooms: boolean;
  diagnostico: boolean;
  support: boolean;
};

/**
 * Qué lee cada quien (puro). Copia del criterio de la página + el de cada lector:
 *   - `team`: `requireTeamManager` (lib/invitations.ts) = soporte (que tiene `tenant.admin` en `SUPPORT_CAPS`) o
 *     `tenant.admin`; la página solo lo pedía con `tenant.admin`, así que nunca caía en el `unlessForbidden`;
 *   - `rooms`: la página pide `schedule.configure` y `listRooms` devuelve `[]` sin el módulo `salas`;
 *   - `diagnostico`: `listCustomConditions` devuelve `[]` sin el módulo;
 *   - `support`: «Accesos de soporte» la lee cualquier miembro; el soporte no (su lector lo rechazaba → `null`).
 */
function gatesFor(actor: Actor, caps: ReadonlySet<Capability>): Gates {
  const tenantAdmin = caps.has("tenant.admin");
  return {
    tenantAdmin,
    team: tenantAdmin,
    rooms: caps.has("schedule.configure") && roomsEnabled(actor.entitlements),
    diagnostico: modulesFor(actor.entitlements).has("diagnostico"),
    support: !actor.support,
  };
}

/**
 * Todas las lecturas de Configuración sobre UNA `tx` (la abre el llamador con `runWithRls(actor.tenantId, …)`).
 * No abre tx propia ni re-resuelve el actor. La autorización que tira (`agenda.viewAll`) se chequea en
 * `loadConfiguracionPage` antes de abrir la tx.
 */
export async function loadConfiguracionInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  now: Date = new Date()
): Promise<ConfiguracionTxData> {
  const g = gatesFor(actor, caps);
  const tenantId = actor.tenantId;
  const today = dayKeyToDbDate(toARDateKey(now));

  // Dentro de una tx interactiva Prisma manda las sentencias en serie por la misma conexión: el `Promise.all` solo
  // las encola sin esperar a que el código de una termine para pedir la siguiente.
  const [tenantRow, insurers, services, team, pending, pracs, customConditions, locations, rooms, supportRows] =
    await Promise.all([
      // = getTenantSettings (lib/tenant-settings.ts); además da el horario del consultorio para el resumen de
      // horarios (= `tenantHours` de lib/practitioner-schedule.ts): una sentencia menos.
      g.tenantAdmin
        ? tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
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
              updatedAt: true,
            },
          })
        : null,
      g.tenantAdmin ? listInsurersInTx(tx, tenantId) : [],
      g.tenantAdmin ? listServicesWithCountsInTx(tx, tenantId) : [],
      g.team ? listTeamMembersInTx(tx, tenantId, actor.userId) : null,
      g.team ? listPendingInvitationsInTx(tx, tenantId, now) : null,
      // = getPractitionerScheduleSummary (lib/practitioner-schedule.ts) y la lista de profesionales de los pickers
      // (antes una consulta aparte con el MISMO where y orden): solo quien atiende (IAM-2e), membresía aceptada.
      g.tenantAdmin
        ? tx.practitioner.findMany({
            where: bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }),
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              user: { select: { fullName: true, email: true } },
              schedules: {
                where: { tenantId, OR: [{ validUntil: null }, { validUntil: { gte: today } }] },
                select: { dow: true, startMin: true, endMin: true, locationId: true },
              },
            },
          })
        : [],
      // = listCustomConditions (lib/conditions.ts): sin el módulo, vacío.
      g.tenantAdmin && g.diagnostico
        ? tx.condition.findMany({
            where: { tenantId },
            orderBy: { name: "asc" },
            select: {
              id: true,
              slug: true,
              name: true,
              cie10: true,
              summary: true,
              severity: true,
              redFlags: true,
              mechanism: true,
              createdById: true,
              createdAt: true,
              updatedAt: true,
            },
          })
        : [],
      // B3.4: archivadas incluidas (el panel de Sedes las lista aparte para poder restaurarlas).
      g.tenantAdmin ? listLocationsInTx(tx, tenantId, { includeArchived: true }) : [],
      // SR-U1: salas de todas las sedes, archivadas incluidas.
      g.rooms ? listRoomsInTx(tx, tenantId, { includeArchived: true }, now) : [],
      // = listSupportSessionsForTenant (lib/platform-support.ts).
      g.support
        ? tx.supportSession.findMany({
            where: { tenantId },
            orderBy: { startedAt: "desc" },
            take: 100,
            select: {
              id: true,
              reason: true,
              startedAt: true,
              endedAt: true,
              endedReason: true,
              superadmin: { select: { email: true } },
            },
          })
        : null,
    ]);

  let tenant: TenantSettings | null = null;
  let scheduleSummary: PractitionerScheduleSummaryRow[] = [];
  if (tenantRow) {
    const { updatedAt, ...t } = tenantRow;
    tenant = { ...t, updatedAt: updatedAt.toISOString() };
    // `tenantHours`: el consultorio existe (findUniqueOrThrow), así que los `?? 8` / `?? 19` no aplican.
    const hours = { startMin: tenantRow.businessHoursStart * 60, endMin: tenantRow.businessHoursEnd * 60 };
    scheduleSummary = pracs.map((p) => {
      const isFallback = p.schedules.length === 0;
      return {
        practitionerId: p.id,
        name: displayMemberName(p.user.fullName),
        summary: isFallback
          ? summarizeWeek(FALLBACK_WORKING_DOWS.map((dow) => ({ dow, ...hours })))
          : summarizeWeek(p.schedules),
        isFallback,
        rangeCount: p.schedules.length,
        locationIds: [...new Set(p.schedules.map((s) => s.locationId))],
      };
    });
  }

  return {
    tenant,
    insurers,
    services,
    team,
    pending,
    practitioners: pracs.map((p) => ({ id: p.id, name: displayMemberName(p.user.fullName) })),
    customConditions,
    locations,
    scheduleSummary,
    rooms,
    supportSessions: supportRows ? supportRows.map(toSupportSessionRow) : null,
  };
}

/** Lecturas que el server puede negar por permiso: `null` en vez de un 500 de la página (solo `ForbiddenError`). */
async function unlessForbidden<T>(p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch (err) {
    if (err instanceof ForbiddenError) return null;
    throw err;
  }
}

export type ConfiguracionPageData = ConfiguracionTxData & {
  planUsage: Awaited<ReturnType<typeof getTenantPlanUsage>> | null;
  billingOverview: Awaited<ReturnType<typeof getBillingOverview>> | null;
  catalog: Awaited<ReturnType<typeof getPublicPlanCatalog>>;
  /** Foto de acceso del request (la misma que usó el gate; el soporte no la baja). */
  snapshot: Awaited<ReturnType<typeof getAccessSnapshot>>;
};

/**
 * Lo que la página necesita, con el actor y las capacidades ya resueltos por ella (`getActor()` +
 * `getCapabilities()`). 1 tx de Configuración + (con «Planes y pagos») las 2 de los lectores de plata de PL.
 */
export async function loadConfiguracionPage(
  actor: Actor,
  caps: ReadonlySet<Capability>
): Promise<ConfiguracionPageData> {
  const billing = caps.has("account.billing");
  // `listLocations` y `getPractitionerScheduleSummary` exigían `agenda.viewAll` y tiraban (500 de la página). Hoy
  // todo `tenant.admin` la tiene (lib/capabilities.ts), pero si la matriz cambia, el resultado sigue siendo el mismo.
  if (caps.has("tenant.admin") && !caps.has("agenda.viewAll")) throw new ForbiddenError(AGENDA_READ_MSG);
  const g = gatesFor(actor, caps);
  const needsTx = g.tenantAdmin || g.rooms || g.support;
  const empty: ConfiguracionTxData = {
    tenant: null,
    insurers: [],
    services: [],
    team: null,
    pending: null,
    practitioners: [],
    customConditions: [],
    locations: [],
    scheduleSummary: [],
    rooms: [],
    supportSessions: null,
  };
  const [data, planUsage, billingOverview, catalog, snapshot] = await Promise.all([
    needsTx ? runWithRls(actor.tenantId, (tx) => loadConfiguracionInTx(tx, actor, caps)) : empty,
    // «Plan y uso»: `getTenantPlanUsage` acepta `account.billing` o `tenant.admin` (PL-3).
    billing ? unlessForbidden(() => getTenantPlanUsage()) : null,
    // PL-3a: Facturación y el drawer de cambio de plan (`requireAccountBilling`).
    billing ? getBillingOverview() : null,
    billing ? getPublicPlanCatalog() : [],
    // [BO-Z B6] El soporte no baja PHI.
    actor.support ? null : getAccessSnapshot(),
  ]);
  return { ...data, planUsage, billingOverview, catalog, snapshot };
}
