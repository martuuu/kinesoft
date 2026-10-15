/**
 * Matriz de capabilities por rol (B1.7 AUTHZ, B-pre).
 *
 * Puro (sin DB, sin `server-only`): lo importan tanto `lib/authz.ts` (server)
 * como la UI de la agenda multi-profesional para decidir qué acciones mostrar.
 * La UI solo esconde; la barrera real es `requireCapability` en cada action.
 *
 * Por qué capabilities y no `role === "OWNER"` desparramado: hoy el chequeo de
 * admin está copiado en 6 lugares (services, insurers, tenant-settings,
 * configuracion/page, patients ×3) y la agenda de B-pre suma acciones nuevas
 * (candado de día, recepción, horarios por profesional) que cada rol habilita
 * distinto. Un solo lugar para la matriz = un solo lugar para revisar en C0
 * (roles y Secretaria).
 *
 * Roles: ASSISTANT y BILLING son anticipos de diseño (AUDIT §5.17): se
 * preservan aunque hoy ningún flujo de alta los asigne; la Secretaria de C0 es
 * ASSISTANT.
 */
import type { Role } from "@prisma/client";
import type { MemberAccess } from "@/lib/saas-plans-types";
import { isClinicalMember } from "@/lib/roles";

export const CAPABILITIES = [
  /** Ver la agenda de todos los profesionales del tenant (vista "Por profesional"). */
  "agenda.viewAll",
  /** Candado/bloqueos de agenda de CUALQUIER profesional (incluye "todos"). */
  "agenda.manageBlocks",
  /** Candado/bloqueos solo de la agenda propia (actor.practitionerId; sin profesional no hay agenda propia). */
  "agenda.manageOwnBlocks",
  /** Recepción: marcar llegada (arrivedAt) / en atención (attendingAt). */
  "agenda.reception",
  /** Horarios, sedes y servicios por profesional. */
  "schedule.configure",
  /** Contenido clínico: title/description/notas del turno, HC. */
  "clinical.read",
  /** Cobros, copagos, liquidación de obra social. */
  "billing.manage",
  /** Configuración del consultorio (catálogo, prestadoras, settings, equipo). */
  "tenant.admin",
  /**
   * Operar TODOS los turnos del tenant (crear, reprogramar, cancelar, estado,
   * Recepción) sin depender del nivel de acceso al paciente (Planes E1,
   * PD-09). Es **positiva**: habilita, nunca se usa para negar. Existe porque
   * la Secretaria (ASSISTANT) no tiene `clinical.read` y desde PD-13 nunca
   * llega a acceso "full", así que "operar con full" la dejaría afuera.
   * No habilita campos clínicos: eso lo decide `bookingFieldAccess`.
   */
  "agenda.operateAll",
  /**
   * Planes: crear, editar título/notas, precio, cantidad, ciclo de vida,
   * adoptar, vincular/sacar y re-planificar. La action exige ADEMÁS acceso
   * full + `clinical.read` (`assertPlanManageInTx`, P2-C1): "con full" no va
   * en la matriz.
   */
  "plans.manage",
  /**
   * Planes: agendar una sesión, mover "solo este" / "este y los siguientes",
   * cancelar y Recepción. La action exige ADEMÁS full o `agenda.operateAll`
   * (`assertPlanScheduleInTx`). Sin `clinical.read` solo ve la proyección
   * administrativa (título null).
   */
  "plans.schedule",
  /**
   * Planes: cargar y renovar la autorización de la obra social (PD-16). La
   * action exige ADEMÁS full o `agenda.operateAll` (`assertPlanAuthorizeInTx`).
   */
  "plans.authorize",
  /**
   * PL-1b (C-PL5, decisión 7): «Planes y pagos» de la CUENTA del consultorio con KineSoft (plan SaaS, débito,
   * comprobantes). La tienen el Titular y quien él delegue (`Membership.grantBilling`). No es `billing.manage`
   * (cobros a pacientes). Soporte nunca.
   */
  "account.billing",
  /**
   * PL-1b: acciones que son SOLO del Titular (transferir titularidad, delegar permisos). No se delega ni se revoca
   * (decisión 7: «nadie le revoca la titularidad»). Soporte nunca.
   */
  "account.owner",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Capacidades de la cuenta (C-PL5): fuera de la matriz por rol, solo por titularidad o delegación. */
const ACCOUNT_CAPS: readonly Capability[] = ["account.billing", "account.owner"];

/**
 * Lo que solo tiene quien atiende (PL-D4): leer HC y crear/editar planes. Sacarlas a un Titular/Admin que no
 * atiende lo deja exactamente en la proyección administrativa de la Secretaria (PD-13).
 */
const CLINICAL_ONLY_CAPS: readonly Capability[] = ["clinical.read", "plans.manage"];

/** «Configuración» (`grantSettings`, PL-D5): lo que exigen las actions de Configuración. */
const SETTINGS_CAPS: readonly Capability[] = ["tenant.admin", "schedule.configure"];

const ALL: readonly Capability[] = CAPABILITIES.filter((c) => !ACCOUNT_CAPS.includes(c));

/**
 * La matriz. OWNER/ADMIN: todo. PRACTITIONER: ve todo, recepciona y bloquea
 * SOLO lo propio; lee clínica. ASSISTANT (Secretaria): opera la agenda de
 * todos pero no lee clínica. BILLING: ve la agenda y cobra; no lee clínica.
 *
 * Decisiones (revisables en C0):
 * - `schedule.configure` solo admin: los horarios por profesional afectan la
 *   disponibilidad del turnero público y del batch de Planes.
 * - `billing.manage` no está en PRACTITIONER: hoy ninguna action de cobro lo
 *   exige; antes de adoptarlo en cobros hay que decidir si el profesional
 *   cobra en el consultorio (cambiaría su comportamiento actual).
 */
/*
 * Planes E1 (firmado 03-oct, matriz literal de PLANES.md §8 P0-Ck):
 * - `agenda.operateAll`: OWNER, ADMIN, ASSISTANT. PRACTITIONER no: opera sus
 *   turnos por acceso full al paciente, como hasta hoy. BILLING no.
 * - `plans.manage`: OWNER, ADMIN, PRACTITIONER (el "con full" lo chequea la
 *   action). La Secretaria NO crea ni edita planes (PD-09).
 * - `plans.schedule` y `plans.authorize`: OWNER, ADMIN, PRACTITIONER y
 *   ASSISTANT. BILLING no tiene ninguna de las cuatro (ve el saldo por
 *   `billing.manage`).
 * Hoy (P0.0) ninguna action las consulta: se publican antes para que las
 * sesiones paralelas de P0.1/P0.2 compilen contra la firma congelada.
 */
const MATRIX: Record<Role, readonly Capability[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  PRACTITIONER: [
    "agenda.viewAll",
    "agenda.reception",
    "agenda.manageOwnBlocks",
    "clinical.read",
    "plans.manage",
    "plans.schedule",
    "plans.authorize",
  ],
  ASSISTANT: [
    "agenda.viewAll",
    "agenda.reception",
    "agenda.manageBlocks",
    "agenda.manageOwnBlocks",
    "agenda.operateAll",
    "plans.schedule",
    "plans.authorize",
  ],
  BILLING: ["agenda.viewAll", "billing.manage"],
};

/**
 * BO2-E (plan §19.5, decisión 3 de Martin): capacidades del actor de SOPORTE (un superadmin «como soporte» en un
 * consultorio ajeno). «Ve lo que ve la Secretaria», sin acceso clínico: las de ASSISTANT + `tenant.admin` y
 * `schedule.configure`, que son las que exigen las actions de Configuración que soporte puede usar (usuarios,
 * obras sociales, servicios, sedes/salas, horarios, datos del consultorio, turnero).
 *
 * Las capacidades NO son la barrera de escritura del soporte: con `agenda.operateAll` (de la Secretaria) pasaría el
 * chequeo de crear un turno, pero la transacción va en solo lectura (`runWithRls` + `request-context.readOnly`) salvo
 * dentro de una action de la allowlist `SUPPORT_WRITABLE_ACTIONS` (lib/support-writable.ts). `clinical.read`,
 * `plans.manage` y `account.*` no están nunca (un test lo fija).
 */
export const SUPPORT_CAPS: ReadonlySet<Capability> = new Set<Capability>(
  [...MATRIX.ASSISTANT, "tenant.admin", "schedule.configure"].filter(
    (c): c is Capability =>
      c !== "clinical.read" &&
      c !== "plans.manage" &&
      c !== "billing.manage" &&
      // PL-1b: soporte nunca toca la cuenta (plan, débito, titularidad). Hoy ASSISTANT no tiene `account.*`; el
      // filtro explícito es para que un cambio de la matriz no se la regale (lo fija pl-ownership-guard.test.ts).
      !c.startsWith("account.")
  )
);

/**
 * Capabilities por defecto de un ROL (sin mirar si el miembro atiende ni sus delegaciones). Rol desconocido o
 * ausente (sin membresía) → set vacío: falla cerrado. Nunca incluye `account.*`.
 *
 * @deprecated PL-1b (C-PL5): para un actor usá `capabilitiesForActor` / `memberCapabilitiesForActor`
 * (`lib/authz.ts`) o `capabilitiesForMember`. `capabilitiesFor("OWNER")` le da `clinical.read` a un Titular que
 * no atiende (decisión 8). Queda para la UI y los tests que hablan del rol en abstracto.
 */
export function capabilitiesFor(role: Role | null | undefined): ReadonlySet<Capability> {
  const caps = role ? MATRIX[role] : undefined;
  return new Set(caps ?? []);
}

/**
 * Capabilities de un MIEMBRO concreto (PL-1b, C-PL5; decisiones 7 y 8 de Martin):
 * - OWNER (Titular): todo + `account.*`. Si no atiende, sin lo clínico (ve como la Secretaria).
 * - ADMIN: lo de su rol SIN `tenant.admin`/`schedule.configure` (vienen solo por `grantSettings`; los ADMIN que
 *   existían quedaron en `true` por el backfill de M8) y nunca `account.*` por el rol. Sin lo clínico si no atiende.
 * - Cualquier rol: `grantSettings` suma `tenant.admin` + `schedule.configure`; `grantBilling` suma
 *   `account.billing`. Nunca suman lo clínico: delegar Configuración a la Secretaria no le abre la HC.
 * - `clinical` se lee con `isClinicalMember`: en PRACTITIONER/ASSISTANT/BILLING el flag no cambia nada.
 *
 * El orden importa: lo clínico se saca AL FINAL, así ninguna delegación lo puede devolver.
 */
export function capabilitiesForMember(m: MemberAccess): ReadonlySet<Capability> {
  const caps = new Set<Capability>(capabilitiesFor(m.role));
  if (m.role === "OWNER") {
    for (const c of ACCOUNT_CAPS) caps.add(c);
  }
  if (m.role === "ADMIN") {
    for (const c of SETTINGS_CAPS) caps.delete(c);
  }
  if (m.grantSettings) {
    for (const c of SETTINGS_CAPS) caps.add(c);
  }
  if (m.grantBilling) caps.add("account.billing");
  if (!isClinicalMember(m)) {
    for (const c of CLINICAL_ONLY_CAPS) caps.delete(c);
  }
  return caps;
}

/**
 * `select` de Prisma con lo que necesita `capabilitiesForMember` (la misma fila de `Membership`, sin query extra).
 * Para las lecturas EN tx que hoy hacen `select: { role: true }` + `capabilitiesFor(m?.role)`.
 */
export const MEMBER_ACCESS_SELECT = { role: true, clinical: true, grantSettings: true, grantBilling: true } as const;

/**
 * Reemplazo 1:1 de `capabilitiesFor(m?.role)` cuando `m` es la fila leída con `MEMBER_ACCESS_SELECT`: sin
 * membresía → vacío (falla cerrado, AUDIT §5.35); con ella → `capabilitiesForMember` (H-PL1: un Titular/Admin que
 * no atiende no recibe `clinical.read`).
 */
export function capabilitiesForMembership(m: MemberAccess | null | undefined): ReadonlySet<Capability> {
  return m ? capabilitiesForMember(m) : new Set<Capability>();
}

export function hasCapability(caps: ReadonlySet<Capability>, cap: Capability): boolean {
  return caps.has(cap);
}

/**
 * OWNER/ADMIN: el mismo criterio que el chequeo copiado hoy en tenant-settings/services/insurers.
 * @deprecated PL-1b: por rol no ve `grantSettings` (un ADMIN sin «Configuración» da `true`, una Secretaria con
 * ella da `false`). Para un actor: `(await capabilitiesForActor(actor)).has("tenant.admin")`.
 */
export function isTenantAdminRole(role: Role | null | undefined): boolean {
  return capabilitiesFor(role).has("tenant.admin");
}

/**
 * ¿Puede bloquear/candadear la agenda de `targetPractitionerId`? `null` =
 * candado "todos" (decisión 8: una fila con practitionerId null), que alcanza
 * a profesionales ajenos y futuros → exige `agenda.manageBlocks`.
 */
export function canManageBlocksFor(
  caps: ReadonlySet<Capability>,
  actorPractitionerId: string | null,
  targetPractitionerId: string | null
): boolean {
  if (caps.has("agenda.manageBlocks")) return true;
  // IAM-4a: actor sin profesional (rol no clínico) → no tiene agenda «propia»; nunca `null === null` (que sería
  // el candado de «todos»).
  return (
    actorPractitionerId !== null &&
    targetPractitionerId !== null &&
    targetPractitionerId === actorPractitionerId &&
    caps.has("agenda.manageOwnBlocks")
  );
}

/**
 * Nivel de acceso a un paciente tal como lo ven los predicados puros. Es un
 * superconjunto de `AccessLevel` (`lib/visibility.ts`, server-only): incluye
 * `admin` (nivel "administrativo" de la Secretaria/Facturación, PD-13, que
 * S02p suma a `AccessLevel`) para que el tipo de visibility sea asignable acá
 * antes y después de esa sesión. Se declara aparte porque este módulo lo
 * importa la UI y no puede arrastrar `server-only`.
 */
export type PatientAccessLevel = "full" | "admin" | "basic" | "none";

/**
 * ¿Puede operar (crear, mover, cancelar, cambiar estado de) un turno?
 * Planes E1/C8: `full || agenda.operateAll`.
 *
 * Forma POSITIVA a propósito: E1 la escribió como `access !== 'basic' || …`,
 * pero con el nivel `admin` eso dejaría operar a BILLING en `admin` (y a
 * cualquiera en `none`). Para `full`/`basic` las dos formas coinciden.
 *
 * Turno sin paciente (guest): no pasa por acá; `lib/bookings.ts` usa
 * `guestOperable` (`agenda.operateAll || clinical.read`). P0.Z H-b3: antes el
 * guest se evaluaba como `full` y BILLING lo creaba, borraba y marcaba cobrado.
 *
 * No decide QUÉ campos se escriben: eso es `bookingFieldAccess`
 * (`lib/booking-field-access.ts`). S07k, S02p, S07sb, S07u y S07sp lo usan;
 * no lo reimplementan.
 */
export function canOperateBooking(caps: ReadonlySet<Capability>, access: PatientAccessLevel): boolean {
  return access === "full" || caps.has("agenda.operateAll");
}

/**
 * ¿Puede escribir contenido clínico del paciente (HC, diagnóstico, "Usar como
 * diagnóstico", campos clínicos del turno)? Exige las dos cosas: el rol lee
 * clínica Y el acceso a ESE paciente es full. `admin` nunca habilita
 * escritura clínica (PD-13), y un PRACTITIONER en básico tampoco.
 */
export function canWriteClinical(caps: ReadonlySet<Capability>, access: PatientAccessLevel): boolean {
  return caps.has("clinical.read") && access === "full";
}
