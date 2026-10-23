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
 *
 * DIR-3c (C-DIR9): la pestaña «Directorio» y el editor de especialidades leen DENTRO de la misma tx (opt-in,
 * descripción y moderación del consultorio salen en la consulta del Tenant que ya estaba; catálogo de especialidades y
 * las asignadas, 2 sentencias más) y, en paralelo con ella, UNA lectura por el canal service: el estado del perfil
 * público de cada profesional (`ProfessionalPublicProfile` es SERVICE_ONLY, DIR-D12: `kinesoft_app` no la ve con ningún
 * GUC). Esa lectura no abre tx (el presupuesto de PF2 sigue en ≤ 3) y filtra por el consultorio a mano a través de la
 * relación (`user.practitioners.some.tenantId`). El `userId` se usa solo para cruzar y NO sale de este archivo: al
 * cliente le llega practitionerId + nombre + estado. Con `DIRECTORY_MODE=off` no se lee nada de esto (la pestaña no
 * existe todavía para nadie).
 *
 * FC-4i (handoff de FC-3i): «Mis fichas» (honorífico, matrícula, ¿hay firma?) y el logo de General se leen DENTRO de
 * la misma tx (antes la página abría una tx chica aparte en paralelo: 1 tx menos por carga). Solo flags y `updatedAt`
 * (el CAS de C-FC9): las claves de Storage no salen de acá; la vista previa se pide aparte con una URL firmada de 60 s.
 *
 * TP-3a (T5, §25.10/§25.11): las pestañas «Cobros online» (`tenant.sensitive`) y «Mi Mercado Pago» (quien tiene
 * profesional propio) leen DENTRO de la misma tx: la política (1 sentencia) y las cuentas de Mercado Pago del
 * consultorio (1 sentencia; `MpAccount` es SELECT para `kinesoft_app` con RLS). Antes de esto, montar los lectores
 * del contrato (`getOnlinePaymentsSettings`, `getMyMpAccount`) sumaba 1 tx + 2 lecturas por el canal service por
 * carga. Las vistas salen con el MISMO criterio que esos lectores (`mpAccountViewOf`, la cuenta viva o la última
 * desconectada) y el test de igualdad de `pf2-config-budget` compara contra los símbolos reales. Ni tokens, ni
 * `webhookRef`, ni `mpUserId`: el select es el de la vista (C-TP4). La vista previa de «¿Cuánto se cobra online?» usa
 * el precio del servicio más usado de los que ya trae la tx (0 sentencias).
 *
 * WA-U1 (T6, §26.5): la pestaña «WhatsApp» NO lee nada acá (0 sentencias, con cualquier modo): solo el modo, el
 * destino del popup del alta (`signupDialogTarget`, para validar `event.origin`) y si el que mira conecta (Titular).
 * La cuenta, las plantillas y el cupo de pruebas los pide el panel al montar (`getWhatsAppPanel`): quien no abre la
 * pestaña no paga la lectura y el presupuesto de PF2 no cambia.
 */
import { runWithRls, type DbClient } from "@/lib/rls";
// DIR-3c: solo para `ProfessionalPublicProfile` (SERVICE_ONLY, DIR-D12); ver la cabecera.
import { prismaService } from "@/lib/db";
import { directoryMode } from "@/lib/directory-mode";
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
import type { PractitionerBookingCapView } from "@/lib/booking-cap-config";
import { isClinicalMember } from "@/lib/roles-core";
import type { Honorific } from "@/lib/directory-constants";
import { mpConnectMode, whatsappMode } from "@/lib/env";
import { signupDialogTarget } from "@/lib/whatsapp/graph";
import type { WaAccountMode } from "@/lib/whatsapp/types";
import { publicPractitionerName } from "@/lib/display-name";
import { DEFAULT_PAYMENT_POLICY, type PaymentPolicyInput } from "@/lib/booking-payment-policy-types";
import { MIN_ONLINE_CHARGE_CENTS } from "@/lib/online-charge-logic";
import {
  MP_ACCOUNT_NONE,
  type MpAccountView,
  type MpConnectMode,
  type OnlinePaymentsSettingsView,
} from "@/lib/mp-connect-types";

/** Mismo texto que `READ_MSG` de lib/locations.ts y lib/practitioner-schedule.ts (lo que tiraban sus lectores). */
const AGENDA_READ_MSG = "No tenés permiso para ver la agenda del consultorio.";

/**
 * DIR-3c (C-DIR9): estado del perfil público de un profesional reservable, visto desde el consultorio. El perfil es
 * PERSONAL (se edita en `/cuenta/perfil-publico`): el consultorio lo ve, no lo edita.
 *   published = publicado con consentimiento vigente · hidden = Plataforma lo ocultó · none = sin perfil, sin
 *   publicar o con el consentimiento retirado (para el consultorio es lo mismo: no aparece).
 */
export type DirectoryProfileStatus = "published" | "hidden" | "none";

export type DirectoryPractitionerRow = {
  practitionerId: string;
  /** `displayMemberName`: nunca el email (decisión 19). */
  name: string;
  /** Switch del turnero de ESTE profesional (PL-3b): apagado = no es reservable, no aparece aunque esté publicado. */
  inTurnero: boolean;
  status: DirectoryProfileStatus;
};

/** Pestaña «Directorio» de Configuración (null = modo `off` o sin «Configuración»). */
export type ConfiguracionDirectoryData = {
  mode: "preview" | "public";
  slug: string;
  listed: boolean;
  description: string | null;
  /** Moderación de Plataforma («Plataforma ocultó el consultorio: <motivo>»). */
  hidden: { at: string; reason: string } | null;
  /** Switch del turnero del consultorio: el directorio necesita el turnero prendido (C-DIR4). */
  turneroOn: boolean;
  practitioners: DirectoryPractitionerRow[];
  /** Catálogo global de especialidades (sin archivadas), por nombre: el combobox del editor. */
  specialtyCatalog: { id: string; name: string }[];
  /** practitionerId → ids de sus especialidades (solo las del catálogo vigente). */
  specialtiesByPractitioner: Record<string, string[]>;
};

/** Lo que sale de la tx: igual que lo público, pero con el `userId` para cruzar con el canal service (no sale). */
type DirectoryTxPart = Omit<ConfiguracionDirectoryData, "practitioners"> & {
  practitioners: (Omit<DirectoryPractitionerRow, "status"> & { userId: string })[];
};

type ProfileStatusRow = { userId: string; listed: boolean; consentWithdrawnAt: Date | null; hiddenAt: Date | null };

/** Puro: el estado que ve el consultorio. Oculto gana (aunque esté `listed`): Plataforma lo sacó. */
export function directoryProfileStatus(p: Omit<ProfileStatusRow, "userId"> | null | undefined): DirectoryProfileStatus {
  if (!p) return "none";
  if (p.hiddenAt) return "hidden";
  return p.listed && !p.consentWithdrawnAt ? "published" : "none";
}

/** Fila del resumen de horarios + el tope por intervalo (T3e-2c). Mismas columnas del mismo select: 0 sentencias. */
export type ConfiguracionScheduleRow = PractitionerScheduleSummaryRow & { bookingCap: PractitionerBookingCapView };

/** FC-3i: estado de un asset del consultorio (logo, firma) sin la clave de Storage. */
export type PracticeAssetFlag = { has: boolean; updatedAt: string | null };

/** FC-3i: «Mis fichas» del que mira (null = no es miembro clínico con `Practitioner`, o es soporte). */
export type ConfiguracionFichasData = {
  me: { honorific: Honorific | null; licenseNumber: string | null; signature: PracticeAssetFlag };
  backupScope: { tenantId: string; userId: string };
};

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
  /** T3e-2c (C-AS3): cada fila trae el tope del profesional y el del consultorio (para «Usar el del consultorio»). */
  scheduleSummary: ConfiguracionScheduleRow[];
  rooms: RoomRow[];
  supportSessions: SupportSessionRow[] | null;
  directory: DirectoryTxPart | null;
  /** FC-3i: «Mis fichas» (miembro clínico con `Practitioner`, nunca el soporte). */
  fichas: ConfiguracionFichasData | null;
  /** FC-3i: logo del consultorio en General (`tenant.sensitive`); null = sin la tarjeta. */
  logo: PracticeAssetFlag | null;
  /** TP-3a: pestaña «Cobros online» (= `getOnlinePaymentsSettings()`); null = sin `tenant.sensitive`. */
  onlinePayments: OnlinePaymentsSettingsView | null;
  /** TP-3a: pestaña «Mi Mercado Pago» (= `getMyMpAccount()`); null = sin profesional propio, o soporte. */
  myMp: MpAccountView | null;
  /** TP-3a: precio de referencia de la vista previa de «¿Cuánto se cobra online?»; null = sin servicio con precio. */
  previewServicePriceCents: number | null;
};

type Gates = {
  tenantAdmin: boolean;
  /** T3 (C-AS1): lo delicado (equipo, directorio, turnero, quién ve la HC, datos del consultorio). */
  sensitive: boolean;
  team: boolean;
  rooms: boolean;
  diagnostico: boolean;
  support: boolean;
  /**
   * DIR-3c: pestaña «Directorio» + especialidades: `tenant.sensitive` desde T3 (antes `tenant.admin`; soporte la ve
   * en solo lectura) y modo ≠ off.
   */
  directory: boolean;
  /** FC-3i (FC-UI-D3): «Mis fichas» = miembro clínico con `Practitioner`. El soporte nunca (no es miembro). */
  fichas: boolean;
  /**
   * TP-3a: «Cobros online» = `tenant.sensitive` (lo mismo que `getOnlinePaymentsSettings`; soporte la ve en solo
   * lectura). `tenant.admin` también, porque la lista de profesionales sale de la consulta de Profesionales, que corre
   * con `tenant.admin` (hoy uno no existe sin el otro, como en `directory`).
   */
  onlinePayments: boolean;
  /** TP-3a: «Mi Mercado Pago» = profesional propio y no soporte (= `getMyMpAccount`). */
  myMp: boolean;
};

/**
 * Qué lee cada quien (puro). Copia del criterio de la página + el de cada lector:
 *   - `team`: `requireTeamManager` (lib/invitations.ts) = soporte (que tiene `tenant.sensitive` en `SUPPORT_CAPS`) o
 *     `tenant.sensitive` (T3, C-AS1; antes `tenant.admin`). La Secretaria con «Configuración» ya no baja el equipo:
 *     sin esto la página leía filas (emails, roles) de una pestaña cuyas actions la rechazan;
 *   - `directory`: lo mismo (las actions del directorio exigen `tenant.sensitive`);
 *   - `rooms`: la página pide `schedule.configure` y `listRooms` devuelve `[]` sin el módulo `salas`;
 *   - `diagnostico`: `listCustomConditions` devuelve `[]` sin el módulo;
 *   - `support`: «Accesos de soporte» la lee cualquier miembro; el soporte no (su lector lo rechazaba → `null`).
 */
function gatesFor(actor: Actor, caps: ReadonlySet<Capability>): Gates {
  const tenantAdmin = caps.has("tenant.admin");
  const sensitive = caps.has("tenant.sensitive");
  const onlineOn = mpConnectMode() !== "off";
  return {
    tenantAdmin,
    sensitive,
    team: sensitive,
    rooms: caps.has("schedule.configure") && roomsEnabled(actor.entitlements),
    diagnostico: modulesFor(actor.entitlements).has("diagnostico"),
    support: !actor.support,
    // `tenantAdmin` también: la pestaña se arma sobre la fila del Tenant, que se lee con `tenant.admin`. Hoy
    // `tenant.sensitive` sin `tenant.admin` no existe (los dos vienen de «Configuración»), pero no se asume.
    directory: tenantAdmin && sensitive && directoryMode() !== "off",
    fichas: !actor.support && !!actor.practitionerId && !!actor.membership && isClinicalMember(actor.membership),
    // TP-3z (decisión del orquestador, regla de Martin «lo que no tiene funcionalidad se quita»): con
    // `MP_CONNECT_MODE=off` las dos pestañas no existen (ni sus lecturas: las cuentas no se piden).
    onlinePayments: tenantAdmin && sensitive && onlineOn,
    myMp: !actor.support && !!actor.practitionerId && onlineOn,
  };
}

type MpAccountViewRow = {
  practitionerId: string | null;
  status: "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";
  mpNickname: string | null;
  liveMode: boolean;
  linksDelegated: boolean;
  connectedAt: Date;
  disconnectedAt: Date | null;
};

/**
 * Puro (TP-3a): la cuenta que se le muestra a cada dueño, con el criterio de `loadAccountViews`
 * (lib/mp-connect/accounts-internal.ts): filas por `connectedAt` desc; gana la primera, salvo que sea DISCONNECTED y
 * aparezca una viva (la viva manda; si no hay, la última desconectada, para el «Desconectada el …»).
 */
export function pickMpAccountRows<R extends Pick<MpAccountViewRow, "practitionerId" | "status">>(
  rows: readonly R[]
): { clinic: R | null; byPractitioner: Map<string, R> } {
  let clinic: R | null = null;
  const byPractitioner = new Map<string, R>();
  const better = (cur: R | null | undefined, next: R) => !cur || (cur.status === "DISCONNECTED" && next.status !== "DISCONNECTED");
  for (const r of rows) {
    if (r.practitionerId === null) {
      if (better(clinic, r)) clinic = r;
    } else if (better(byPractitioner.get(r.practitionerId), r)) {
      byPractitioner.set(r.practitionerId, r);
    }
  }
  return { clinic, byPractitioner };
}

/** = `mpAccountViewOf` (lib/mp-connect/accounts-internal.ts, server-only con el canal service): la misma vista. */
function mpViewOf(row: MpAccountViewRow | null, mode: MpConnectMode): MpAccountView {
  if (!row) return MP_ACCOUNT_NONE;
  return {
    status: row.status,
    nickname: row.mpNickname,
    connectedAt: row.connectedAt.toISOString(),
    disconnectedAt: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
    linksDelegated: row.linksDelegated,
    badge: row.liveMode ? null : mode === "fake" ? "fake" : "sandbox",
  };
}

/**
 * Puro (TP-3a): precio de referencia de la vista previa de «¿Cuánto se cobra online?». El servicio con más turnos (el
 * que el consultorio más cobra, y el que más va a ver el paciente en el turnero); empate → el primero por nombre (el
 * orden de la lista). Solo precios cobrables online (≥ $1): con un servicio sin precio la vista previa diría «no se
 * cobra nada», que es verdad pero no ayuda a elegir la seña.
 */
export function previewServicePriceOf(services: readonly Pick<ServiceRow, "priceCents" | "bookingsCount">[]): number | null {
  let best: Pick<ServiceRow, "priceCents" | "bookingsCount"> | null = null;
  for (const s of services) {
    if (!Number.isInteger(s.priceCents) || s.priceCents < MIN_ONLINE_CHARGE_CENTS) continue;
    if (!best || s.bookingsCount > best.bookingsCount) best = s;
  }
  return best ? best.priceCents : null;
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
  // FC-3i: ya chequeado no-null (guard IAM-4a: nunca `actor.practitionerId` crudo como valor de una clave).
  const myPractitionerId: string | null = g.fichas ? actor.practitionerId : null;
  // TP-3a: ídem (`g.myMp` ya exige `actor.practitionerId`).
  const myMpPractitionerId: string | null = g.myMp ? actor.practitionerId : null;

  // Dentro de una tx interactiva Prisma manda las sentencias en serie por la misma conexión: el `Promise.all` solo
  // las encola sin esperar a que el código de una termine para pedir la siguiente.
  const [
    tenantRow,
    insurers,
    services,
    team,
    pending,
    pracs,
    customConditions,
    locations,
    rooms,
    supportRows,
    specialtyCatalog,
    specialtyRows,
    logoRow,
    me,
    policyRow,
    mpRows,
  ] = await Promise.all([
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
              // T3e-2c (C-AS3): = getTenantSettings.
              bookingCapCount: true,
              bookingCapIntervalMin: true,
              updatedAt: true,
              // DIR-3c: pestaña «Directorio» (M11). Se separan abajo: `tenant` sigue igual a `getTenantSettings`.
              directoryListed: true,
              directoryHiddenAt: true,
              directoryHiddenReason: true,
              publicDescription: true,
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
              // DIR-3c: `userId` para cruzar con el perfil público (no sale del loader) y el switch del turnero.
              userId: true,
              publicBookingEnabled: true,
              // T3e-2c (C-AS3): el tope de la ficha del profesional, en el mismo select.
              bookingCapMode: true,
              bookingCapCount: true,
              bookingCapIntervalMin: true,
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
      // DIR-3c: catálogo global (GLOBAL_READONLY, SELECT para todos) y las asignadas del consultorio.
      g.directory
        ? tx.specialty.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } })
        : [],
      g.directory
        ? tx.practitionerSpecialty.findMany({
            where: { tenantId, specialty: { archivedAt: null } },
            select: { practitionerId: true, specialtyId: true },
          })
        : [],
      // FC-3i: logo de General (misma regla que `sensitive`). Aparte de la consulta del Tenant de arriba para que
      // `tenant` siga igual a `getTenantSettings` y porque esa solo corre con `tenant.admin`.
      g.sensitive
        ? tx.tenant.findFirst({ where: { id: tenantId }, select: { logoStorageKey: true, logoUpdatedAt: true } })
        : null,
      g.fichas && myPractitionerId
        ? tx.practitioner.findFirst({
            where: { id: myPractitionerId, tenantId },
            select: { honorific: true, licenseNumber: true, signatureStorageKey: true, signatureUpdatedAt: true },
          })
        : null,
      // TP-3a: = la lectura de la política de `getOnlinePaymentsSettings` (lib/booking-payment-policy.ts).
      g.onlinePayments
        ? tx.bookingPaymentPolicy.findUnique({
            where: { tenantId },
            select: {
              mode: true,
              chargeKind: true,
              fixedCents: true,
              percentBps: true,
              useClinicAccount: true,
              cancellationNote: true,
              updatedAt: true,
            },
          })
        : null,
      // TP-3a: cuentas de Mercado Pago. Con «Cobros online», todas las del consultorio (la del consultorio y las de
      // cada profesional; la propia va entre ellas); con solo «Mi Mercado Pago», las del profesional propio. Solo las
      // columnas de la vista: ni `webhookRef`, ni `mpUserId`, ni nada de `MpCredential` (C-TP4).
      g.onlinePayments || (g.myMp && myMpPractitionerId)
        ? tx.mpAccount.findMany({
            where: g.onlinePayments ? { tenantId } : { tenantId, practitionerId: myMpPractitionerId },
            orderBy: [{ connectedAt: "desc" }],
            select: {
              practitionerId: true,
              status: true,
              mpNickname: true,
              liveMode: true,
              linksDelegated: true,
              connectedAt: true,
              disconnectedAt: true,
            },
          })
        : [],
    ]);

  let tenant: TenantSettings | null = null;
  let scheduleSummary: ConfiguracionScheduleRow[] = [];
  let directory: DirectoryTxPart | null = null;
  if (tenantRow) {
    const { updatedAt, directoryListed, directoryHiddenAt, directoryHiddenReason, publicDescription, ...t } = tenantRow;
    tenant = { ...t, updatedAt: updatedAt.toISOString() };
    const mode = directoryMode();
    if (g.directory && mode !== "off") {
      const specialtiesByPractitioner: Record<string, string[]> = {};
      for (const r of specialtyRows) (specialtiesByPractitioner[r.practitionerId] ??= []).push(r.specialtyId);
      directory = {
        mode,
        slug: t.slug,
        listed: directoryListed,
        description: publicDescription,
        hidden: directoryHiddenAt
          ? { at: directoryHiddenAt.toISOString(), reason: directoryHiddenReason ?? "" }
          : null,
        turneroOn: t.publicBookingEnabled,
        practitioners: pracs.map((p) => ({
          practitionerId: p.id,
          userId: p.userId,
          name: displayMemberName(p.user.fullName),
          inTurnero: p.publicBookingEnabled,
        })),
        specialtyCatalog,
        specialtiesByPractitioner,
      };
    }
    // `tenantHours`: el consultorio existe (findUniqueOrThrow), así que los `?? 8` / `?? 19` no aplican.
    const hours = { startMin: tenantRow.businessHoursStart * 60, endMin: tenantRow.businessHoursEnd * 60 };
    const tenantCap =
      tenantRow.bookingCapCount != null && tenantRow.bookingCapIntervalMin != null
        ? { count: tenantRow.bookingCapCount, intervalMin: tenantRow.bookingCapIntervalMin }
        : null;
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
        bookingCap: {
          mode: p.bookingCapMode,
          count: p.bookingCapCount,
          intervalMin: p.bookingCapIntervalMin,
          tenant: tenantCap,
        },
      };
    });
  }

  // TP-3a: mismas vistas que `getOnlinePaymentsSettings` / `getMyMpAccount` (el test de igualdad lo fija).
  const connectMode = mpConnectMode();
  const accounts = pickMpAccountRows(mpRows);
  let onlinePayments: OnlinePaymentsSettingsView | null = null;
  if (g.onlinePayments) {
    const rows = pracs.map((p) => {
      const v = accounts.byPractitioner.get(p.id) ?? null;
      return {
        practitionerId: p.id,
        name: publicPractitionerName(p.user.fullName),
        status: v ? v.status : ("NONE" as const),
        linksDelegated: v ? v.status !== "DISCONNECTED" && v.linksDelegated : false,
      };
    });
    const policy: PaymentPolicyInput = policyRow
      ? {
          mode: policyRow.mode,
          chargeKind: policyRow.chargeKind,
          fixedCents: policyRow.fixedCents,
          percentBps: policyRow.percentBps,
          useClinicAccount: policyRow.useClinicAccount,
          cancellationNote: policyRow.cancellationNote,
        }
      : DEFAULT_PAYMENT_POLICY;
    onlinePayments = {
      policy,
      policyUpdatedAt: policyRow ? policyRow.updatedAt.toISOString() : null,
      connectMode,
      publicBookingEnabled: actor.entitlements.publicBookingEnabled,
      clinicAccount: mpViewOf(accounts.clinic, connectMode),
      canManageClinicAccount: !actor.support && caps.has("account.owner"),
      practitioners: rows,
      withoutMpCount: rows.filter((r) => r.status !== "ACTIVE").length,
      // TP-ZF3 (A1): sale de `insurers` (ya leídos: `onlinePayments` exige `tenant.admin`), sin sentencia extra.
      particularCopagoCents: insurers.find((i) => i.isParticular)?.copagoCents ?? null,
    };
  }
  const myMp =
    g.myMp && myMpPractitionerId ? mpViewOf(accounts.byPractitioner.get(myMpPractitionerId) ?? null, connectMode) : null;

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
    directory,
    logo: logoRow ? { has: !!logoRow.logoStorageKey, updatedAt: logoRow.logoUpdatedAt?.toISOString() ?? null } : null,
    fichas: me
      ? {
          me: {
            honorific: (me.honorific as Honorific | null) ?? null,
            licenseNumber: me.licenseNumber,
            signature: { has: !!me.signatureStorageKey, updatedAt: me.signatureUpdatedAt?.toISOString() ?? null },
          },
          backupScope: { tenantId, userId: actor.userId },
        }
      : null,
    onlinePayments,
    myMp,
    previewServicePriceCents: g.onlinePayments ? previewServicePriceOf(services) : null,
  };
}

/**
 * DIR-3c: estado del perfil público de las personas que atienden en el consultorio. Canal service (SERVICE_ONLY) sin
 * tx; `tenantId` a mano por la relación. Solo las columnas de estado: ni nombre público, ni matrícula, ni bio (son de
 * la persona y se editan en su cuenta).
 */
async function loadProfileStatuses(tenantId: string): Promise<ProfileStatusRow[]> {
  return prismaService.professionalPublicProfile.findMany({
    where: { user: { practitioners: { some: { tenantId } } } },
    select: { userId: true, listed: true, consentWithdrawnAt: true, hiddenAt: true },
  });
}

/** Cruza la parte de la tx con los estados y saca el `userId` (no viaja al cliente). */
function finishDirectory(part: DirectoryTxPart | null, statuses: ProfileStatusRow[]): ConfiguracionDirectoryData | null {
  if (!part) return null;
  const byUser = new Map(statuses.map((s) => [s.userId, s]));
  return {
    ...part,
    practitioners: part.practitioners.map(({ userId, ...p }) => ({ ...p, status: directoryProfileStatus(byUser.get(userId)) })),
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

/** WA-U1: lo que la pestaña «WhatsApp» necesita antes de pedir sus datos. Sin secretos ni ids de Meta. */
export type ConfiguracionWhatsAppData = {
  mode: WaAccountMode;
  dialog: NonNullable<ReturnType<typeof signupDialogTarget>>;
  /** Conectar / continuar / desconectar: Titular y no soporte (la action lo vuelve a exigir, con step-up). */
  canManage: boolean;
};

/**
 * WA-U1 (puro sobre env + capacidades, 0 queries): la pestaña existe con `tenant.sensitive` y `WHATSAPP_MODE` ≠ off
 * (con off no hay nada que configurar: «lo que no tiene funcionalidad se quita», TP-3z). El soporte la ve en solo
 * lectura (tiene `tenant.sensitive` en `SUPPORT_CAPS`); sin destino de popup (sin `NEXT_PUBLIC_APP_URL` en fake) no
 * hay alta posible y tampoco se muestra.
 */
export function whatsappTabFor(actor: Pick<Actor, "support">, caps: ReadonlySet<Capability>): ConfiguracionWhatsAppData | null {
  if (!caps.has("tenant.sensitive")) return null;
  const mode = whatsappMode();
  if (mode === "off") return null;
  const dialog = signupDialogTarget();
  if (!dialog) return null;
  return { mode, dialog, canManage: !actor.support && caps.has("account.owner") };
}

export type ConfiguracionPageData = Omit<ConfiguracionTxData, "directory"> & {
  /**
   * T3 (C-AS1): `tenant.sensitive` del actor, para que la UI esconda lo delicado (turnero, «quién ve la HC», datos del
   * consultorio, directorio, equipo, diagnósticos propios) a la Secretaria con «Configuración». Es UX: cada action
   * exige lo suyo (`requireTenantSensitive`).
   */
  sensitive: boolean;
  /** DIR-3c: pestaña «Directorio» (null = modo `off` o sin «Configuración»). */
  directory: ConfiguracionDirectoryData | null;
  planUsage: Awaited<ReturnType<typeof getTenantPlanUsage>> | null;
  billingOverview: Awaited<ReturnType<typeof getBillingOverview>> | null;
  catalog: Awaited<ReturnType<typeof getPublicPlanCatalog>>;
  /** Foto de acceso del request (la misma que usó el gate; el soporte no la baja). */
  snapshot: Awaited<ReturnType<typeof getAccessSnapshot>>;
  /** WA-U1: pestaña «WhatsApp» (null = modo off o sin `tenant.sensitive`). */
  whatsapp: ConfiguracionWhatsAppData | null;
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
  const needsTx = g.tenantAdmin || g.rooms || g.support || g.sensitive || g.fichas || g.onlinePayments || g.myMp;
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
    directory: null,
    fichas: null,
    logo: null,
    onlinePayments: null,
    myMp: null,
    previewServicePriceCents: null,
  };
  const [data, planUsage, billingOverview, catalog, snapshot, profileStatuses] = await Promise.all([
    needsTx ? runWithRls(actor.tenantId, (tx) => loadConfiguracionInTx(tx, actor, caps)) : empty,
    // «Plan y uso»: `getTenantPlanUsage` acepta `account.billing` o `tenant.admin` (PL-3).
    billing ? unlessForbidden(() => getTenantPlanUsage()) : null,
    // PL-3a: Facturación y el drawer de cambio de plan (`requireAccountBilling`).
    billing ? getBillingOverview() : null,
    billing ? getPublicPlanCatalog() : [],
    // [BO-Z B6] El soporte no baja PHI.
    actor.support ? null : getAccessSnapshot(),
    // DIR-3c: en paralelo con la tx (sin tx propia).
    g.directory ? loadProfileStatuses(actor.tenantId) : [],
  ]);
  return {
    ...data,
    sensitive: g.sensitive,
    directory: finishDirectory(data.directory, profileStatuses),
    planUsage,
    billingOverview,
    catalog,
    snapshot,
    whatsapp: whatsappTabFor(actor, caps),
  };
}
