/**
 * Zod schemas shared by client forms and server actions.
 * Keeping them in one place avoids drift between the two layers.
 */
import { z } from "zod";
import { localToARIso } from "@/lib/datetime-ar";

/**
 * A `<input type="date">` value is a bare "YYYY-MM-DD". Parsing it with
 * `new Date(v)` reads it as UTC midnight, which on a UTC host is the previous
 * AR day at 21:00 — so a plan created "on Monday" would schedule session 1 on
 * Sunday. Anchor bare dates to AR midnight; leave values that already carry a
 * time/offset (e.g. a datetime-local already tagged by the client) untouched.
 */
const toARDateOrInstant = (v: string): Date =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(localToARIso(`${v}T00:00:00`)) : new Date(v);

export const PatientCreate = z.object({
  firstName: z.string().trim().min(1, "Nombre requerido").max(80),
  lastName: z.string().trim().min(1, "Apellido requerido").max(80),
  email: z.string().email("Email inválido").optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().min(6).max(30).optional().or(z.literal("").transform(() => undefined)),
  // DNI is required on creation (and unique per tenant). `PatientUpdate`
  // relaxes it back to optional via `.partial()` so editing an existing
  // patient never forces a re-entry.
  documentId: z.string().trim().min(4, "DNI requerido (mín. 4 caracteres)").max(20),
  dateOfBirth: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  notes: z.string().max(2000).optional().or(z.literal("").transform(() => undefined)),
  // Patient-level "active diagnosis": a short title + a longer note that
  // auto-fill every new turno (Booking.title/.description). Set on the patient
  // and propagated at booking creation.
  diagnosisTitle: z.string().max(80).optional().or(z.literal("").transform(() => undefined)),
  diagnosisNote: z.string().max(2000).optional().or(z.literal("").transform(() => undefined)),
  // Optional coverage captured at creation time. `insurerId` resolves to a
  // tenant Insurer row (incl. "Particular"); `insurerName` is the free-form
  // fallback for "Otra". Both are stripped from the Patient row and used to
  // seed the primary Coverage. Not part of the `Patient` model — handled
  // explicitly in createPatient and ignored by updatePatient.
  insurerId: z.string().trim().optional().or(z.literal("").transform(() => undefined)),
  insurerName: z.string().trim().max(80).optional().or(z.literal("").transform(() => undefined)),
});
export type PatientCreateInput = z.input<typeof PatientCreate>;

export const PatientUpdate = PatientCreate.partial().extend({
  id: z.string().min(1),
});
export type PatientUpdateInput = z.input<typeof PatientUpdate>;

// Input for `setPatientCoverage` (replace the patient's single active
// coverage). Either `insurerId` resolves to a tenant Insurer row, or
// `insurerName` is the free-form ("Otra") fallback; both optional so the
// caller can clear coverage by omitting them. String lengths are capped to
// keep free-form values sane. Copago precedence is resolved separately
// (see `resolveBookingCopagoCents`) and is intentionally not set here.
export const CoverageSet = z.object({
  patientId: z.string().min(1),
  insurerId: z.string().trim().max(60).optional().or(z.literal("").transform(() => undefined)),
  insurerName: z.string().trim().max(80).optional().or(z.literal("").transform(() => undefined)),
  planName: z.string().trim().max(80).optional().or(z.literal("").transform(() => undefined)),
  memberId: z.string().trim().max(40).optional().or(z.literal("").transform(() => undefined)),
});
export type CoverageSetInput = z.input<typeof CoverageSet>;

export const BookingCreate = z.object({
  patientId: z.string().min(1).optional(),
  serviceId: z.string().min(1),
  practitionerId: z.string().min(1),
  scheduledFor: z
    .string()
    .min(1, "Fecha y hora requeridas")
    .transform((v) => new Date(v)),
  durationMin: z.coerce.number().int().min(15).max(240).default(45),
  // Per-turno copago override in cents (defaults to the patient's resolved
  // copago when omitted). Null/undefined = compute on read.
  copagoCents: z.coerce.number().int().min(0).max(100_000_00).optional(),
  title: z.string().max(80).optional(),
  description: z.string().max(2000).optional(),
  notes: z.string().max(1000).optional().or(z.literal("").transform(() => undefined)),
  guestName: z.string().max(120).optional().or(z.literal("").transform(() => undefined)),
  guestEmail: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  guestPhone: z.string().max(30).optional().or(z.literal("").transform(() => undefined)),
});
export type BookingCreateInput = z.input<typeof BookingCreate>;

export const BookingUpdate = z.object({
  id: z.string().min(1),
  // Sprint 18: `patientId` is mutable so the BookingDrawer edit flow
  // can swap the patient of an existing booking. The empty string
  // becomes `null` (server clears the link and turns the booking
  // back into a guest slot). The server enforces tenant scope on the
  // target patient before saving.
  patientId: z
    .string()
    .optional()
    .transform((v) => (v === "" ? null : v)),
  scheduledFor: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  durationMin: z.coerce.number().int().min(15).max(240).optional(),
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "NO_SHOW", "COMPLETED"]).optional(),
  notes: z.string().max(1000).optional(),
  title: z.string().max(80).optional(),
  description: z.string().max(2000).optional(),
});
export type BookingUpdateInput = z.input<typeof BookingUpdate>;

export const SessionNoteCreate = z.object({
  programId: z.string().min(1),
  index: z.coerce.number().int().min(1).max(64),
  scheduledFor: z
    .string()
    .min(1)
    .transform((v) => new Date(v)),
  notes: z.string().max(4000).optional().or(z.literal("").transform(() => undefined)),
  paInPre: z.coerce.number().int().min(0).max(10).optional(),
  paInPost: z.coerce.number().int().min(0).max(10).optional(),
  rpe: z.coerce.number().int().min(0).max(10).optional(),
});

export const EvaScoreCreate = z.object({
  patientId: z.string().min(1),
  value: z.coerce.number().int().min(0).max(10),
  source: z.string().max(40).optional(),
});

export const ProgramCreate = z.object({
  patientId: z.string().min(1),
  title: z.string().min(1).max(120),
  totalSessions: z.coerce.number().int().min(1).max(64).default(8),
  frequency: z.coerce.number().int().min(1).max(7).default(2),
  startDate: z
    .string()
    .min(1)
    .transform(toARDateOrInstant),
});
export type ProgramCreateInput = z.input<typeof ProgramCreate>;

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

// ─────────────────────────────────────────────────────────────────────────────
// Exercise catalog authoring (platform superadmin / "Plataforma" panel).
// String enums are inlined (not z.nativeEnum) to keep this shared client/server
// file free of a runtime @prisma/client value import.
// ─────────────────────────────────────────────────────────────────────────────

/** Optional positive count: "" / null / undefined → undefined (omitted); the
 *  action stores NULL. Reps / series / tiempo are all optional (only `name` is
 *  required). */
const optionalCount = (max: number) =>
  z.preprocess(
    // "" / undefined → undefined (field omitted); null → null (explicit clear,
    // so an update can NULL a previously-set value); else coerce to number.
    (v) => (v === "" || v === undefined ? undefined : v === null ? null : Number(v)),
    z.number().int().min(1).max(max).nullable().optional(),
  );

export const ExerciseKindEnum = z.enum(["EXERCISE", "MANUAL_THERAPY"]);
export const TagKindEnum = z.enum([
  "ZONE", "SUBZONE", "SYMPTOM", "TRIGGER", "PHASE",
  "EQUIPMENT", "GOAL", "CHAIN", "MUSCLE_GROUP", "DISCIPLINE",
]);
export const ExerciseMediaTypeEnum = z.enum(["VIDEO", "IMAGE", "GIF", "YOUTUBE"]);

export const ExerciseAdminCreate = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(120),
  kind: ExerciseKindEnum.default("EXERCISE"),
  description: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
  difficulty: z
    .preprocess((v) => (v === "" || v == null ? 1 : Number(v)), z.number().int().min(1).max(5))
    .default(1),
  defaultSets: optionalCount(10),
  defaultReps: optionalCount(100),
  durationSeconds: optionalCount(3600),
  // Común (isBasic true → visible a FREE/STARTER) vs Pro (false → PRO+). The
  // action converts the form checkbox to a real boolean|undefined so a partial
  // update that omits it leaves the flag unchanged.
  isBasic: z.boolean().optional(),
  instructions: z.string().trim().max(4000).optional().or(z.literal("").transform(() => undefined)),
  cues: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
  // Deprecados: se mantienen mientras el catálogo migra a tags; el editor usa tagSlugs.
  muscleGroups: z.string().trim().max(300).optional().or(z.literal("").transform(() => undefined)),
  equipment: z.string().trim().max(300).optional().or(z.literal("").transform(() => undefined)),
  // Slugs de tags a linkear (MUSCLE_GROUP / EQUIPMENT / DISCIPLINE / GOAL / ...).
  tagSlugs: z.array(z.string().min(1)).optional(),
});
export type ExerciseAdminCreateInput = z.input<typeof ExerciseAdminCreate>;

export const ExerciseAdminUpdate = ExerciseAdminCreate.partial().extend({
  id: z.string().min(1),
});
export type ExerciseAdminUpdateInput = z.input<typeof ExerciseAdminUpdate>;

export const TagAdminCreate = z.object({
  label: z.string().trim().min(1, "Etiqueta requerida").max(60),
  kind: TagKindEnum,
  parentSlug: z.string().trim().optional().or(z.literal("").transform(() => undefined)),
});
export type TagAdminCreateInput = z.input<typeof TagAdminCreate>;

export const ExerciseMediaCreate = z.object({
  exerciseId: z.string().min(1),
  type: ExerciseMediaTypeEnum,
  // Uploads: the action sets `url` to the storage key. YOUTUBE: client sends the
  // watch URL (host validated in the action).
  url: z.string().trim().max(1000).optional(),
  caption: z.string().trim().max(200).optional().or(z.literal("").transform(() => undefined)),
  order: z
    .preprocess((v) => (v == null || v === "" ? 0 : Number(v)), z.number().int().min(0))
    .default(0),
});
export type ExerciseMediaCreateInput = z.input<typeof ExerciseMediaCreate>;

export const ExerciseArticleUpsert = z.object({
  exerciseId: z.string().min(1),
  title: z.string().trim().max(160).optional().or(z.literal("").transform(() => undefined)),
  subtitle: z.string().trim().max(200).optional().or(z.literal("").transform(() => undefined)),
  focus: z.string().trim().max(200).optional().or(z.literal("").transform(() => undefined)),
  readingMinutes: optionalCount(120),
  bodyMarkdown: z.string().max(20000).optional().or(z.literal("").transform(() => undefined)),
  references: z.string().max(5000).optional().or(z.literal("").transform(() => undefined)),
});
export type ExerciseArticleUpsertInput = z.input<typeof ExerciseArticleUpsert>;
