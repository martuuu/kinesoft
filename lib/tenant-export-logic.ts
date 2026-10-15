/**
 * Export completo del consultorio (BO5-C, plan §19.5; BO-D4 de §19.10): la parte PURA.
 *
 * Sin DB, sin `next/*`, sin `process.env`: la usan `lib/tenant-export-internal.ts` (server-only, las queries),
 * `app/api/consultorio/export/route.ts` y `lib/platform-export-request.ts`, y se testea en TZ=UTC y TZ=AR
 * (tests/unit/tenant-export-logic.test.ts).
 *
 * Qué decide este módulo:
 *  - **a qué consultorio** se le baja el export (`chooseExportTenant`): solo a uno donde la sesión es OWNER
 *    aceptado y habilitado, TAMBIÉN si está suspendido o dado de baja (BO-D4: la lectura nunca se bloquea y el
 *    titular se lleva sus datos). ADMIN no: el export completo es la vía más corta para sacar PHI en bloque y la
 *    decisión de llevársela es del titular. Soporte nunca (lo corta la ruta antes de llegar acá).
 *  - **qué columnas** salen de cada tabla (`EXPORT_FIELDS`): es una ALLOWLIST a propósito. Con un `select`
 *    explícito una columna nueva del schema no aparece sola en el archivo; hay que decidir que sale.
 *  - el nombre del archivo y la forma del JSON (`manifest` + `data`).
 *
 * Por qué JSON y no un ZIP de CSVs: no hay lib de zip en package.json y la regla de la ola es no sumar
 * dependencias. Un único JSON además conserva tipos (fechas ISO, montos en centavos, Json anidado) y no tiene el
 * problema de inyección de fórmulas de un CSV abierto en Excel (no hay celdas): por eso acá no hay `csvCell`.
 */
import type { Role } from "@prisma/client";
import { toARDateKey } from "@/lib/datetime-ar";

/** Versión del formato. Se sube si cambia la forma de `data` (no por sumar una columna a la allowlist). */
export const TENANT_EXPORT_VERSION = 1;

/**
 * Filas por página (cursor por id). Cada página es una transacción corta propia: una sola tx para todo el
 * consultorio chocaba con el timeout default de Prisma (5 s) y retenía una conexión del pool todo el export.
 */
export const TENANT_EXPORT_PAGE_SIZE = 1000;

/** Meses de auditoría que entran (el log completo puede ser enorme y casi todo es ruido de lecturas). */
export const TENANT_EXPORT_AUDIT_MONTHS = 12;

/** 3 por hora por consultorio: un export legítimo se baja una vez; más es un script o una sesión robada. */
export const TENANT_EXPORT_RATE_LIMIT = { limit: 3, windowMs: 60 * 60_000 } as const;

/**
 * Columnas que salen por entidad. EXCLUIDAS a propósito (y por qué):
 *  - `Tenant.statusReason`, `seatLimitOverride`: notas y cupos internos de Plataforma.
 *  - `Practitioner.userId`, `Patient.userId` (cuenta del portal), `SupportSession.superadminId`: ids de la cuenta
 *    de Auth (Supabase), que no sirven fuera de KineSoft («sin datos de Auth»). Del equipo sale nombre y email (de
 *    `UserProfile`). EXCEPCIÓN: `team.userId` sí sale, porque es lo único que permite saber quién es el `actorId`
 *    de cada fila de `auditEvents`; es un id opaco, no un secreto (nada de contraseñas, proveedores ni sesiones).
 *  - `Booking.idempotencyKey`, `TreatmentProgram.idempotencyKey`, `ClinicalNote.idempotencyKey`: claves internas de
 *    reintento.
 *  - `Payment.rawPayload`: respuesta cruda de Mercado Pago (datos del pagador y del medio de pago de MP).
 *  - `PatientFile.storageKey`: la ruta en el bucket. Los binarios no viajan (ni URLs firmadas): solo metadatos.
 *  - `AuditEvent.ip/userAgent`, `SupportSession.ip/userAgent`: datos de red de cada persona, no del consultorio.
 *  - `Invitation` entera (tokens), `EmailLog`, `Notification`, `DismissedReminder`, `Favorite`, `UserPreferences`
 *    (preferencias de UI por usuario), `PatientTenantLink` (puede apuntar a pacientes cuyo consultorio «casa» es
 *    otro: sacaría ids ajenos), `TenantSlugAlias` y `PlatformAuditEvent` (de Plataforma).
 */
export const EXPORT_FIELDS = {
  tenant: [
    "id", "slug", "name", "legalName", "taxId", "timezone", "currency", "plan", "subscriptionStatus", "trialEndsAt",
    "vertical", "status", "statusChangedAt", "publicBookingEnabled", "sharedPatientView", "businessHoursStart",
    "businessHoursEnd", "agendaSlotMinutes", "phone", "whatsapp", "publicEmail", "onboardingCompletedAt",
    "createdAt", "updatedAt",
  ],
  locations: [
    "id", "name", "address", "addressLine2", "city", "province", "postalCode", "lat", "lng", "phone", "isPrimary",
    "active", "sortOrder", "createdAt", "updatedAt",
  ],
  rooms: ["id", "locationId", "name", "kind", "capacity", "active", "sortOrder", "createdAt", "updatedAt"],
  services: [
    "id", "practitionerId", "name", "durationMin", "priceCents", "description", "color", "maxConcurrent",
    "practiceId", "discipline",
  ],
  insurers: [
    "id", "name", "copagoCents", "fixedFeeCents", "isParticular", "active", "notes", "payerId", "createdAt",
    "updatedAt",
  ],
  payerPlans: ["id", "payerId", "name", "slug", "archivedAt", "createdAt", "updatedAt"],
  team: ["id", "userId", "role", "invitedAt", "acceptedAt", "disabledAt"],
  practitioners: ["id", "licenseNumber", "specialty", "bio", "yearsExp", "createdAt"],
  practitionerSchedules: [
    "id", "practitionerId", "locationId", "roomId", "dow", "startMin", "endMin", "validFrom", "validUntil",
    "createdAt", "updatedAt",
  ],
  scheduleExceptions: [
    "id", "practitionerId", "date", "kind", "ranges", "reason", "createdById", "createdAt", "updatedAt",
  ],
  timeBlocks: [
    "id", "practitionerId", "locationId", "roomId", "startsAt", "endsAt", "allDay", "reason", "groupId",
    "createdById", "createdAt", "updatedAt", "deletedAt",
  ],
  practitionerServices: [
    "id", "practitionerId", "serviceId", "enabled", "durationMin", "visibility", "minLeadMinutes", "maxLeadDays",
    "concurrencyOverride", "maxConcurrent", "notifyOnBooking", "createdAt", "updatedAt",
  ],
  practitionerPayers: ["id", "practitionerId", "insurerId", "active", "createdAt"],
  practitionerSpecialties: ["id", "practitionerId", "specialtyId"],
  patients: [
    "id", "assignedPractitionerId", "firstName", "lastName", "email", "phone", "dateOfBirth", "documentId", "notes",
    "diagnosisTitle", "diagnosisNote", "archivedAt", "createdAt", "updatedAt",
  ],
  coverages: [
    "id", "patientId", "insurer", "insurerId", "payerPlanId", "planName", "memberId", "copagoCents", "validUntil",
  ],
  emergencyContacts: ["id", "patientId", "name", "relation", "phone"],
  patientShares: ["id", "patientId", "practitionerId", "sharedById", "sharedAt"],
  patientChangeRequests: [
    "id", "patientId", "changes", "status", "decidedById", "decidedAt", "createdAt", "updatedAt",
  ],
  bookings: [
    "id", "patientId", "practitionerId", "serviceId", "locationId", "roomId", "programId", "sessionId", "seriesId",
    "scheduledFor", "durationMin", "status", "paymentStatus", "copagoCents", "copagoPaidAt", "insurerPaidAt",
    "pricedByPlan", "guestName", "guestEmail", "guestPhone", "title", "description", "notes", "isOverbooked",
    "arrivedAt", "calledAt", "attendingAt", "isTelemedicine", "telemedicineUrl", "createdAt", "updatedAt",
  ],
  payments: [
    "id", "bookingId", "provider", "externalId", "status", "expectedAmountCents", "amountCents", "currency",
    "createdAt", "updatedAt",
  ],
  clinicalCases: ["id", "authorId", "patientId", "selectedZones", "refinements", "notes", "createdAt"],
  diagnoses: ["id", "caseId", "conditionId", "matchScore", "confirmed", "rank"],
  treatmentPrograms: [
    "id", "patientId", "caseId", "title", "totalSessions", "frequency", "startDate", "status", "discipline",
    "practitionerId", "serviceId", "locationId", "templateId", "durationMin", "schedule", "pricingMode",
    "pricePerSessionCents", "totalPriceCents", "notes", "archivedAt", "createdAt", "updatedAt",
  ],
  programAuthorizations: [
    "id", "programId", "code", "authorizedSessions", "startsOn", "expiresOn", "createdById", "createdAt",
    "supersededAt",
  ],
  sessions: [
    "id", "programId", "practitionerId", "index", "scheduledFor", "completedAt", "notes", "rpe", "paInPre",
    "paInPost", "title", "priceCents", "archivedAt", "updatedAt",
  ],
  sessionExercises: ["id", "sessionId", "exerciseId", "order", "sets", "reps", "status", "notes"],
  evaScores: ["id", "patientId", "sessionId", "takenAt", "value", "source", "note"],
  // EV2-1b (EV2-D22, C-EV2-7): la HC entera — raíces, enmiendas y ANULADAS (con su motivo), y todas las revisiones
  // (el contenido anterior de cada edición). Portabilidad: mismo criterio que AUDIT §5.50. `authorUserId` y
  // `voidedByUserId` son ids opacos del equipo (se cruzan con `team.userId`, igual que `auditEvents.actorId`).
  // Sin `idempotencyKey` (clave interna de reintento, ya en EXPORT_FORBIDDEN_FIELDS).
  clinicalNotes: [
    "id", "patientId", "bookingId", "amendsNoteId", "kind", "title", "body", "occurredAt", "authorUserId",
    "authorPractitionerId", "authorName", "revision", "voidedAt", "voidedByUserId", "voidReason", "createdAt",
    "updatedAt",
  ],
  clinicalNoteRevisions: ["id", "noteId", "revision", "kind", "title", "body", "occurredAt", "savedAt", "createdAt"],
  planTemplates: [
    "id", "authorId", "name", "description", "totalSessions", "frequency", "exerciseIds", "discipline", "serviceId",
    "durationMin", "schedule", "pricingMode", "pricePerSessionCents", "totalPriceCents", "notes", "archivedAt",
    "createdAt", "updatedAt",
  ],
  customExercises: [
    "id", "slug", "name", "description", "videoUrl", "difficulty", "defaultSets", "defaultReps", "durationSeconds",
    "instructions", "equipment", "muscleGroups", "cues", "kind", "isBasic", "archivedAt", "createdAt",
  ],
  customConditions: [
    "id", "cie10", "slug", "name", "summary", "contra", "severity", "recoveryWeeksMin", "recoveryWeeksMax",
    "mechanism", "redFlags", "createdAt", "updatedAt",
  ],
  patientFiles: ["id", "patientId", "uploaderId", "name", "mime", "sizeBytes", "category", "description", "createdAt"],
  supportSessions: ["id", "scope", "reason", "startedAt", "endedAt", "endedReason"],
  auditEvents: ["id", "actorId", "action", "entity", "entityId", "payload", "createdAt"],
} as const satisfies Record<string, readonly string[]>;

export type ExportEntity = keyof typeof EXPORT_FIELDS;

/** Orden de salida: del consultorio hacia lo clínico (el archivo se lee de arriba abajo). */
export const EXPORT_ENTITIES = Object.keys(EXPORT_FIELDS) as ExportEntity[];

/** Columnas que NUNCA pueden entrar a la allowlist (la red del test unitario). */
export const EXPORT_FORBIDDEN_FIELDS = [
  "superadminId",
  "token",
  "priorTokens",
  "idempotencyKey",
  "rawPayload",
  "storageKey",
  "ip",
  "userAgent",
  "statusReason",
  "seatLimitOverride",
] as const;

/** `{ campo: true }` para el `select` de Prisma, desde la allowlist. */
export function selectOf(entity: ExportEntity): Record<string, true> {
  return Object.fromEntries(EXPORT_FIELDS[entity].map((f) => [f, true]));
}

// ── A qué consultorio ───────────────────────────────────────────────────────────────────────────────────────────

export type ExportMembership = {
  tenantId: string;
  role: Role;
  acceptedAt: Date | null;
  disabledAt?: Date | null;
};

export type ExportTenantChoice =
  | { ok: true; tenantId: string }
  | { ok: false; status: 400 | 403; reason: "not_owner" | "choose_tenant" | "user_disabled" };

/**
 * Decide el consultorio del export.
 * - `requestedTenantId` (`?tenant=` de la URL): tiene que ser uno donde la sesión es OWNER; si no, 403 (nunca se
 *   «cae» a otro: el usuario pidió ese).
 * - Sin pedido y con consultorio activo (hay Actor): ese, si ahí es OWNER; si es ADMIN/otro rol, 403.
 * - Sin Actor (p. ej. su único consultorio está suspendido o dado de baja: `getActor` no entra ahí): el único
 *   consultorio donde es OWNER; con varios, 400 (que elija con `?tenant=`).
 * Las membresías llegan crudas (`loadAccessMemberships`): incluyen las de consultorios bloqueados, que es justo
 * lo que BO-D4 necesita. Una membresía no aceptada o deshabilitada nunca cuenta.
 */
export function chooseExportTenant(p: {
  memberships: readonly ExportMembership[];
  userDisabled: boolean;
  activeTenantId: string | null;
  requestedTenantId: string | null;
}): ExportTenantChoice {
  if (p.userDisabled) return { ok: false, status: 403, reason: "user_disabled" };
  const owned = new Set(
    p.memberships.filter((m) => m.role === "OWNER" && m.acceptedAt && !m.disabledAt).map((m) => m.tenantId)
  );
  if (p.requestedTenantId) {
    return owned.has(p.requestedTenantId)
      ? { ok: true, tenantId: p.requestedTenantId }
      : { ok: false, status: 403, reason: "not_owner" };
  }
  if (p.activeTenantId) {
    return owned.has(p.activeTenantId)
      ? { ok: true, tenantId: p.activeTenantId }
      : { ok: false, status: 403, reason: "not_owner" };
  }
  if (owned.size === 1) return { ok: true, tenantId: [...owned][0] };
  if (owned.size === 0) return { ok: false, status: 403, reason: "not_owner" };
  return { ok: false, status: 400, reason: "choose_tenant" };
}

// ── Archivo ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `kinesoft-<slug>-<YYYY-MM-DD AR>.json`. El slug ya es [a-z0-9-]; se limpia igual (va a un header). */
export function exportFilename(slug: string, now: Date): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60) || "consultorio";
  return `kinesoft-${safe}-${toARDateKey(now)}.json`;
}

/**
 * Una fila a JSON. `JSON.stringify` ya pasa `Date` a ISO (UTC, con Z: el instante exacto, sin depender del TZ del
 * host). Los `@db.Date` (sin hora) también salen como ISO de medianoche UTC, que es lo que guarda Postgres.
 */
export function serializeRow(row: unknown): string {
  return JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export type TenantExportManifest = {
  version: number;
  generatedAt: string;
  completedAt: string;
  tenant: { id: string; slug: string; name: string };
  counts: Record<ExportEntity, number>;
  /** Lo que NO trae el archivo, para quien lo abra sin leer la pantalla. */
  excludes: string[];
  auditSince: string;
};

export const EXPORT_EXCLUDES_COPY = [
  "Archivos adjuntos (PDF, imágenes): solo sus datos (nombre, tipo, tamaño, fecha). Los archivos se descargan desde la ficha de cada paciente.",
  "Contraseñas, tokens de invitación y datos de las cuentas de acceso.",
  "Respuestas crudas de Mercado Pago (los pagos sí están, con monto y estado).",
  "Registro de auditoría de más de 12 meses.",
];

/**
 * Pedazos del JSON. El manifest va AL FINAL a propósito: los conteos son los de lo que efectivamente se escribió
 * (contar antes con `count()` podía no coincidir si alguien carga un turno mientras se arma el archivo), y un
 * archivo cortado a la mitad (timeout, red) queda como JSON inválido en vez de parecer completo.
 */
export const exportChunks = {
  open: () => `{"data":{`,
  entityOpen: (entity: ExportEntity, first: boolean) => `${first ? "" : ","}${JSON.stringify(entity)}:[`,
  row: (row: unknown, first: boolean) => `${first ? "" : ","}\n${serializeRow(row)}`,
  entityClose: () => `]`,
  close: (manifest: TenantExportManifest) => `},"manifest":${JSON.stringify(manifest)}}\n`,
};

/** Desde cuándo entra la auditoría (12 meses calendario hacia atrás; el borde exacto no importa). */
export function auditSince(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - TENANT_EXPORT_AUDIT_MONTHS);
  return d;
}

// ── Mail de Plataforma: «pedí tu export» ────────────────────────────────────────────────────────────────────────
