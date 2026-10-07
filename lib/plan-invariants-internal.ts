import "server-only";
import { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import { captureException } from "@/lib/observability";

/**
 * Verificador de invariantes de un plan (I1-I8 de PLANES.md §2.3). Firma
 * congelada por P2-C1 (C8, literal), implementación de S11v (ES2b P2.1):
 *
 *   assertProgramInvariantsInTx(tx, {tenantId, programId})
 *
 * Corre DENTRO de la tx de escritura, al final (paso 10 del commit del motor,
 * §5): ve lo que la tx escribió y, si algo no cierra, reporta el diff a Sentry
 * y tira `ProgramInvariantViolation`, que hace rollback de TODA la tx. Nunca
 * corrige: un verificador que "arregla" esconde el bug del write-path.
 *
 * Por qué re-chequea lo que la base ya garantiza (I1, I2, I4 de Booking, I8):
 * los únicos PARCIALES y las FKs compuestas de M1 son drift aceptado que
 * Prisma no expresa; un `migrate dev`/`migrate diff` propone borrarlos y en
 * prod la conexión es BYPASSRLS. Si un día falta el objeto, el verificador es
 * la red. Cuesta poco: los datos ya están cargados para I3/I5/I6.
 *
 * R-LEGACY (§2.3, se mantiene en ES2b): I3, I5 e I6 solo en planes VINCULADOS
 * (`schedule` no nulo o algún turno con `programId`, = `linkedProgramWhere`).
 * En un legacy corre solo I1, I2, I4, I7 e I8: así pausar, cancelar o archivar
 * un alta vieja con `totalSessions` ≠ filas no falla.
 *
 * Costo: 3 sentencias fijas (plan + refs, sesiones, turnos), sin importar la
 * cantidad de filas — el commit del motor tiene presupuesto de ≤ 60 sentencias
 * para 20 filas (§5). SQL crudo a propósito: con `select` anidado Prisma 5
 * (sin `relationJoins`) emite una query por relación (6 en vez de 1).
 *
 * Aislamiento: todo con `tenantId` a mano (en prod BYPASSRLS es la única
 * barrera). La única lectura cruzada es un `count` de turnos de OTRO tenant
 * que apuntan al plan (I4): devuelve un número, nunca filas. Bajo RLS
 * (`kinesoft_app`) las filas ajenas son invisibles: una ref de otro tenant se
 * ve como "no encontrada" (tenantId null) y se reporta igual; el `count`
 * ajeno da 0 (en prod, BYPASSRLS, sí lo ve).
 *
 * Sin PHI en `detail`: solo ids, índices, montos en centavos, fechas ISO y
 * estados. Nunca nombre, DNI, título del plan ni notas (el evento sale a
 * Sentry y a los logs de Vercel).
 */

export type ProgramInvariant = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8";

/** Lo que tira el verificador. `violations` = qué invariante falló y en qué fila (sin PHI). */
export class ProgramInvariantViolation extends Error {
  constructor(
    public readonly programId: string,
    public readonly violations: ReadonlyArray<{ invariant: string; detail: string }>
  ) {
    super(`Invariantes del plan ${programId}: ${violations.map((v) => v.invariant).join(", ")}`);
    this.name = "ProgramInvariantViolation";
  }
}

/** Refs del plan que tienen que ser del tenant (I4). `tenantId` null = no existe o es invisible bajo RLS. */
export type ProgramRefField =
  | "patientId"
  | "practitionerId"
  | "serviceId"
  | "locationId"
  | "templateId"
  | "template.serviceId";

/**
 * Foto del plan que necesita el chequeo puro. La arma el loader (3 queries) y
 * los tests la arman a mano para cubrir estados que la base hoy hace
 * imposibles.
 */
export interface ProgramInvariantSnapshot {
  tenantId: string;
  programId: string;
  /** null = el plan no existe en ESTE tenant. */
  program: {
    patientId: string;
    status: string;
    archivedAt: Date | null;
    hasSchedule: boolean;
    totalSessions: number;
    pricingMode: "PER_SESSION" | "PACKAGE" | null;
    totalPriceCents: number | null;
    /** Solo las refs no nulas. */
    refs: Array<{ field: ProgramRefField; id: string; tenantId: string | null }>;
    /** Turnos de OTRO tenant con `programId` = el plan o `sessionId` en sus sesiones. */
    foreignBookings: number;
  } | null;
  /** Todas las sesiones del plan (vivas y archivadas). */
  sessions: Array<{
    id: string;
    index: number;
    scheduledFor: Date;
    completedAt: Date | null;
    archivedAt: Date | null;
    priceCents: number | null;
    /** tenantId del profesional de la sesión (null = invisible/no existe). */
    practitionerTenantId: string | null;
  }>;
  /** Turnos del tenant con `programId` = el plan o `sessionId` en sus sesiones. */
  bookings: Array<{
    id: string;
    programId: string | null;
    sessionId: string | null;
    patientId: string | null;
    status: string;
    scheduledFor: Date;
    copagoCents: number | null;
    pricedByPlan: boolean;
  }>;
}

type Violation = { invariant: ProgramInvariant; detail: string };

/** Activo para su sesión (I2, C4): todo menos CANCELLED y NO_SHOW. Mismo criterio que `Booking_session_active_key`. */
const isActive = (status: string) => status !== "CANCELLED" && status !== "NO_SHOW";
const iso = (d: Date) => d.toISOString();

/** R-LEGACY: espejo de `linkedProgramWhere` / `isLinkedProgram`. */
function isLinked(s: ProgramInvariantSnapshot): boolean {
  const p = s.program;
  if (!p) return false;
  return p.hasSchedule || p.foreignBookings > 0 || s.bookings.some((b) => b.programId === s.programId);
}

/**
 * Chequeo puro de I1-I8 sobre la foto. Devuelve las violaciones en orden
 * I1..I8 (estable: el diff de Sentry se puede comparar entre eventos). `[]` =
 * el plan cierra.
 */
export function checkProgramInvariants(s: ProgramInvariantSnapshot): Violation[] {
  const p = s.program;
  if (!p) return [{ invariant: "I4", detail: `plan ${s.programId} no encontrado en el consultorio ${s.tenantId}` }];

  const out: Violation[] = [];
  const add = (invariant: ProgramInvariant, detail: string) => out.push({ invariant, detail });
  const linked = isLinked(s);
  const sessionById = new Map(s.sessions.map((x) => [x.id, x]));
  const live = s.sessions.filter((x) => x.archivedAt == null);

  // Turnos activos por sesión (I2, I3, I7).
  const activeBySession = new Map<string, string[]>();
  for (const b of s.bookings) {
    if (!b.sessionId || !isActive(b.status)) continue;
    const list = activeBySession.get(b.sessionId) ?? [];
    list.push(b.id);
    activeBySession.set(b.sessionId, list);
  }

  // I1 · turno de plan = mismo plan y paciente que su sesión.
  for (const b of s.bookings) {
    if (b.programId !== s.programId) {
      add("I1", `turno ${b.id}: sesión ${b.sessionId} de este plan pero programId=${b.programId ?? "null"}`);
      continue;
    }
    if (b.sessionId == null) add("I1", `turno ${b.id}: del plan sin sesión`);
    else if (!sessionById.has(b.sessionId)) add("I1", `turno ${b.id}: la sesión ${b.sessionId} no es de este plan`);
    if (b.patientId !== p.patientId) {
      add("I1", `turno ${b.id}: paciente ${b.patientId ?? "null"} ≠ paciente del plan ${p.patientId}`);
    }
  }

  // I2 · como máximo 1 turno activo por sesión.
  for (const [sessionId, ids] of activeBySession) {
    if (ids.length > 1) {
      const idx = sessionById.get(sessionId)?.index;
      add("I2", `sesión ${sessionId} (index ${idx ?? "?"}): ${ids.length} turnos activos (${ids.join(", ")})`);
    }
  }

  // I3 · fecha de la sesión = fecha del turno activo (solo vinculados; sesiones
  // vivas: una archivada con turno activo ya es I7). Igualdad exacta al ms: el
  // write-through copia el instante, no el día.
  if (linked) {
    const bookingById = new Map(s.bookings.map((b) => [b.id, b]));
    for (const ss of live) {
      for (const bid of activeBySession.get(ss.id) ?? []) {
        const b = bookingById.get(bid)!;
        if (b.scheduledFor.getTime() !== ss.scheduledFor.getTime()) {
          add("I3", `sesión ${ss.id} (index ${ss.index}) en ${iso(ss.scheduledFor)} ≠ turno ${b.id} en ${iso(b.scheduledFor)}`);
        }
      }
    }
  }

  // I4 · ids del tenant. Las refs del plan (lo que valida `validatePlanRefsInTx`)
  // en todo plan; el profesional de cada sesión solo en vinculados: el fixture
  // legacy modela un alta vieja con la 1ª sesión de otro profesional ajeno, que
  // R-LEGACY no exige (no es una ref del plan).
  for (const r of p.refs) {
    if (r.tenantId !== s.tenantId) add("I4", `${r.field} ${r.id} no es del consultorio`);
  }
  if (p.foreignBookings > 0) add("I4", `${p.foreignBookings} turno(s) de otro consultorio apuntan al plan`);
  if (linked) {
    for (const ss of s.sessions) {
      if (ss.practitionerTenantId !== s.tenantId) add("I4", `sesión ${ss.id}: el profesional no es del consultorio`);
    }
  }

  // I5 · totalSessions = sesiones vivas, y `index` vivo único
  // (`Session_programId_index_live_key`, parcial: drift aceptado).
  if (linked) {
    if (p.totalSessions !== live.length) add("I5", `totalSessions=${p.totalSessions} ≠ sesiones vivas=${live.length}`);
    const seen = new Set<number>();
    for (const ss of live) {
      if (seen.has(ss.index)) add("I5", `index ${ss.index} repetido entre sesiones vivas (${ss.id})`);
      seen.add(ss.index);
    }
  }

  // I6 · PACKAGE: Σ Session.priceCents vivas = total. El espejo turno↔cuota NO
  // se verifica a propósito: el copago manual (se deduce de los datos, C5
  // enmienda ES1) y el cobro previo ($0) son estados legítimos con
  // `pricedByPlan` y copago ≠ cuota; chequearlo daría falsos positivos que
  // tirarían el commit. Tampoco PER_SESSION: una fila bloqueada conserva su
  // precio viejo tras un reprecio.
  if (linked && p.pricingMode === "PACKAGE") {
    const unpriced = live.filter((x) => x.priceCents == null);
    for (const ss of unpriced) add("I6", `sesión ${ss.id} (index ${ss.index}) viva sin cuota en un paquete`);
    if (unpriced.length === 0) {
      const sum = live.reduce((acc, x) => acc + (x.priceCents ?? 0), 0);
      if (p.totalPriceCents == null) add("I6", `paquete sin total (Σ cuotas vivas=${sum})`);
      else if (sum !== p.totalPriceCents) add("I6", `Σ cuotas vivas=${sum} ≠ totalPriceCents=${p.totalPriceCents}`);
    }
  }

  // I7 · nada vinculado se borra en duro: se archiva, con las reglas de §2.4.
  // Plan: solo CANCELLED/COMPLETED (si no, D7 → CANCELLED en la misma tx).
  // Sesión: solo no realizada y sin turno activo (un activo impago se cancela
  // en la tx; con cobro o COMPLETED se rechaza). Un archivado que viola esto es
  // un write-path que se saltó la regla y dejó un turno "huérfano" en agenda.
  if (p.archivedAt != null && p.status !== "CANCELLED" && p.status !== "COMPLETED") {
    add("I7", `plan archivado en estado ${p.status}`);
  }
  for (const ss of s.sessions) {
    if (ss.archivedAt == null) continue;
    if (ss.completedAt != null) add("I7", `sesión ${ss.id} (index ${ss.index}) archivada y realizada`);
    const act = activeBySession.get(ss.id);
    if (act?.length) add("I7", `sesión ${ss.id} (index ${ss.index}) archivada con turno activo (${act.join(", ")})`);
  }

  // I8 · `pricedByPlan=true` solo lo escribe el motor y siempre con vínculo y
  // copago (`Booking_priced_by_plan_check`).
  for (const b of s.bookings) {
    if (!b.pricedByPlan) continue;
    if (b.programId == null || b.sessionId == null) add("I8", `turno ${b.id}: pricedByPlan sin vínculo al plan`);
    if (b.copagoCents == null) add("I8", `turno ${b.id}: pricedByPlan sin copago`);
  }

  // Orden estable por invariante (sort es estable en V8); dentro, el de las filas.
  return out.sort((a, b) => Number(a.invariant.slice(1)) - Number(b.invariant.slice(1)));
}

// ─── Loader ──────────────────────────────────────────────────────────────────

type ProgramRow = {
  patientId: string;
  status: string;
  archivedAt: Date | null;
  hasSchedule: boolean;
  totalSessions: number;
  pricingMode: "PER_SESSION" | "PACKAGE" | null;
  totalPriceCents: number | null;
  practitionerId: string | null;
  practitionerTenantId: string | null;
  serviceId: string | null;
  serviceTenantId: string | null;
  locationId: string | null;
  locationTenantId: string | null;
  templateId: string | null;
  templateTenantId: string | null;
  templateServiceId: string | null;
  templateServiceTenantId: string | null;
  patientTenantId: string | null;
  foreignBookings: number;
};

/** Arma la foto con 3 sentencias fijas, todas con `tenantId` a mano. */
export async function loadProgramInvariantSnapshotInTx(
  tx: DbClient,
  o: { tenantId: string; programId: string }
): Promise<ProgramInvariantSnapshot> {
  const { tenantId, programId } = o;
  // Sesiones del plan SOLO si el plan es del tenant: la subconsulta exige
  // `tp."tenantId"`, así un programId ajeno no abre nada (BYPASSRLS).
  const planSessions = Prisma.sql`SELECT s."id" FROM "Session" s JOIN "TreatmentProgram" tp ON tp."id" = s."programId"
    WHERE s."programId" = ${programId} AND tp."tenantId" = ${tenantId}`;

  const programRows = await tx.$queryRaw<ProgramRow[]>`
    SELECT tp."patientId", tp."status"::text AS "status", tp."archivedAt",
           (tp."schedule" IS NOT NULL) AS "hasSchedule", tp."totalSessions",
           tp."pricingMode"::text AS "pricingMode", tp."totalPriceCents",
           tp."practitionerId", pr."tenantId" AS "practitionerTenantId",
           tp."serviceId", sv."tenantId" AS "serviceTenantId",
           tp."locationId", lo."tenantId" AS "locationTenantId",
           tp."templateId", pt."tenantId" AS "templateTenantId",
           pt."serviceId" AS "templateServiceId", psv."tenantId" AS "templateServiceTenantId",
           pa."tenantId" AS "patientTenantId",
           (SELECT count(*)::int FROM "Booking" b
             WHERE b."tenantId" <> ${tenantId}
               AND (b."programId" = tp."id" OR b."sessionId" IN (SELECT s2."id" FROM "Session" s2 WHERE s2."programId" = tp."id"))
           ) AS "foreignBookings"
      FROM "TreatmentProgram" tp
      LEFT JOIN "Practitioner" pr ON pr."id" = tp."practitionerId"
      LEFT JOIN "Service" sv ON sv."id" = tp."serviceId"
      LEFT JOIN "Location" lo ON lo."id" = tp."locationId"
      LEFT JOIN "PlanTemplate" pt ON pt."id" = tp."templateId"
      LEFT JOIN "Service" psv ON psv."id" = pt."serviceId"
      LEFT JOIN "Patient" pa ON pa."id" = tp."patientId"
     WHERE tp."id" = ${programId} AND tp."tenantId" = ${tenantId}`;
  const row = programRows[0];
  if (!row) return { tenantId, programId, program: null, sessions: [], bookings: [] };

  const sessions = await tx.$queryRaw<ProgramInvariantSnapshot["sessions"]>`
    SELECT s."id", s."index", s."scheduledFor", s."completedAt", s."archivedAt", s."priceCents",
           pr."tenantId" AS "practitionerTenantId"
      FROM "Session" s
      JOIN "TreatmentProgram" tp ON tp."id" = s."programId"
      LEFT JOIN "Practitioner" pr ON pr."id" = s."practitionerId"
     WHERE s."programId" = ${programId} AND tp."tenantId" = ${tenantId}
     ORDER BY s."index", s."id"`;

  const bookings = await tx.$queryRaw<ProgramInvariantSnapshot["bookings"]>`
    SELECT b."id", b."programId", b."sessionId", b."patientId", b."status"::text AS "status",
           b."scheduledFor", b."copagoCents", b."pricedByPlan"
      FROM "Booking" b
     WHERE b."tenantId" = ${tenantId}
       AND (b."programId" = ${programId} OR b."sessionId" IN (${planSessions}))
     ORDER BY b."id"`;

  const refs: NonNullable<ProgramInvariantSnapshot["program"]>["refs"] = [];
  const ref = (field: ProgramRefField, id: string | null, refTenant: string | null) => {
    if (id != null) refs.push({ field, id, tenantId: refTenant });
  };
  ref("patientId", row.patientId, row.patientTenantId);
  ref("practitionerId", row.practitionerId, row.practitionerTenantId);
  ref("serviceId", row.serviceId, row.serviceTenantId);
  ref("locationId", row.locationId, row.locationTenantId);
  ref("templateId", row.templateId, row.templateTenantId);
  ref("template.serviceId", row.templateServiceId, row.templateServiceTenantId);

  return {
    tenantId,
    programId,
    program: {
      patientId: row.patientId,
      status: row.status,
      archivedAt: row.archivedAt,
      hasSchedule: row.hasSchedule,
      totalSessions: row.totalSessions,
      pricingMode: row.pricingMode,
      totalPriceCents: row.totalPriceCents,
      refs,
      foreignBookings: row.foreignBookings,
    },
    sessions,
    bookings,
  };
}

/**
 * Verifica I1-I8 (con R-LEGACY) del plan dentro de la tx. Si algo no cierra:
 * evento a Sentry con el diff (`violations`) y tira `ProgramInvariantViolation`
 * para que el caller haga rollback total. No traduce a copy de usuario: eso es
 * del caller (es un bug nuestro, no un error del usuario).
 */
export async function assertProgramInvariantsInTx(
  tx: DbClient,
  o: { tenantId: string; programId: string }
): Promise<void> {
  const snapshot = await loadProgramInvariantSnapshotInTx(tx, o);
  const violations = checkProgramInvariants(snapshot);
  if (violations.length === 0) return;
  const err = new ProgramInvariantViolation(o.programId, violations);
  // Antes de tirar: el rollback borra todo rastro en la base, así que el
  // evento es la única evidencia del write-path que rompió el plan.
  captureException(err, {
    scope: "plan-invariants",
    tenantId: o.tenantId,
    programId: o.programId,
    linked: isLinked(snapshot),
    violations,
  });
  throw err;
}
