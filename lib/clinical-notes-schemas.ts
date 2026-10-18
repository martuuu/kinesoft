import "server-only";
/**
 * Zod de las notas clínicas (EV2: alta, edición, enmienda, anulación), fuera de `lib/clinical-notes-logic.ts` desde
 * PF1-Z (D-PF5). Por qué: el archivo de lógica lo importan componentes cliente (`clinicalNoteDeepLink`,
 * `bookingTargetDecision`) y con estos schemas adentro zod entero (~13 kB gz) entraba al JS inicial de /sala,
 * /seguimiento/[id] y /pacientes/[id]. Solo los usa `lib/clinical-notes.ts` (server). Movido tal cual.
 */
import { z } from "zod";
import {
  CLINICAL_NOTE_BODY_MAX,
  CLINICAL_NOTE_COPY,
  CLINICAL_NOTE_IMPORT_FILE_NAME_MAX,
  CLINICAL_NOTE_IMPORT_MAX_BYTES,
  CLINICAL_NOTE_IMPORT_PARTS_MAX,
  CLINICAL_NOTE_KINDS,
  CLINICAL_NOTE_TITLE_MAX,
  CLINICAL_NOTE_VOID_REASON_MAX,
  CLINICAL_NOTE_VOID_REASON_MIN,
} from "@/lib/clinical-notes-types";
import { DIAGNOSES_MAX, DIAGNOSIS_COPY, DIAGNOSIS_TEXT_MAX, DIAGNOSIS_TEXT_MIN } from "@/lib/diagnoses-types";
import { HC_DOC_ERROR_COPY, validateHcDoc } from "@/lib/hc-doc";

// ─── Schemas (zod `.strict()`) ───────────────────────────────────────────────

/** Ids de Prisma (cuid) y de los tests: el mismo molde que `UrlIdSchema` de lib/plans-deeplink.ts. */
const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Id inválido");

/** `""` → null: un `<select>` o un input vacío del form llega como string vacío. */
const OptionalIdSchema = z.preprocess((v) => (v === "" ? null : v), IdSchema.nullable()).optional();

const KindSchema = z.enum(CLINICAL_NOTE_KINDS);

/** Título opcional: trim; vacío → null (la base no acepta un título de puros espacios: ClinicalNote_title_check). */
const TitleSchema = z
  .string()
  .nullable()
  .transform((v) => {
    if (v == null) return null;
    const t = v.trim();
    return t === "" ? null : t;
  })
  .refine((v) => v == null || v.length <= CLINICAL_NOTE_TITLE_MAX, {
    message: `El título puede tener hasta ${CLINICAL_NOTE_TITLE_MAX} caracteres.`,
  });

/** Texto clínico: trim y 1..20.000 (el mismo rango que ClinicalNote_body_check, así la base nunca tira 23514). */
const BodySchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length >= 1, { message: "Escribí la ficha." })
  .refine((v) => v.length <= CLINICAL_NOTE_BODY_MAX, {
    message: `La ficha puede tener hasta ${CLINICAL_NOTE_BODY_MAX.toLocaleString("es-AR")} caracteres.`,
  });

/** ISO con zona (el cliente manda `toISOString()`): sin zona sería hora del host, el bug de siempre en Vercel. */
const IsoDateSchema = z
  .string()
  .datetime({ offset: true, message: "Elegí una fecha válida." })
  .transform((s) => new Date(s));

// ─── FC (C-FC3): formato, diagnósticos e importación ─────────────────────────

/**
 * Doc del editor → `{ doc, plainText }`. `validateHcDoc` RE-ARMA un doc nuevo con la allow-list (nunca se guarda lo que
 * mandó el cliente tal cual) y da el texto plano del que el server deriva `body`. El tope de caracteres es el mismo de
 * `body` (ClinicalNote_body_check), así una ficha con formato nunca llega a la base con un `body` que la base rechaza.
 */
export const BodyDocSchema = z.unknown().transform((v, ctx) => {
  const r = validateHcDoc(v, { maxChars: CLINICAL_NOTE_BODY_MAX });
  if (!r.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: HC_DOC_ERROR_COPY[r.reason] });
    return z.NEVER;
  }
  return { doc: r.doc, plainText: r.plainText };
});

const DiagnosisTextSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length >= DIAGNOSIS_TEXT_MIN && v.length <= DIAGNOSIS_TEXT_MAX, { message: DIAGNOSIS_COPY.textLength });

/**
 * La UI manda REFERENCIAS (FC-D27), nunca el título ni el código: el server re-lee cada una en la base y congela el
 * snapshot (`resolveDiagnosesInTx`). Así nadie puede guardar un «CIE-11» con un título inventado (licencia OMS: los
 * títulos no se modifican).
 */
export const DiagnosisRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("icd11"), id: IdSchema }).strict(),
  z.object({ kind: z.literal("tenant"), id: IdSchema }).strict(),
  z.object({ kind: z.literal("kine"), id: IdSchema }).strict(),
  z.object({ kind: z.literal("text"), text: DiagnosisTextSchema }).strict(),
]);

export const DiagnosesSchema = z.array(DiagnosisRefSchema).max(DIAGNOSES_MAX, { message: DIAGNOSIS_COPY.tooMany });

export const ImportSourceSchema = z
  .object({
    kind: z.literal("docx"),
    fileName: z.string().trim().min(1).max(CLINICAL_NOTE_IMPORT_FILE_NAME_MAX),
    fileSize: z.number().int().min(0).max(CLINICAL_NOTE_IMPORT_MAX_BYTES),
    fileLastModified: z.string().datetime({ offset: true }).nullable(),
    batchId: z.string().uuid(),
    part: z.number().int().min(1),
    parts: z.number().int().min(1).max(CLINICAL_NOTE_IMPORT_PARTS_MAX),
  })
  .strict()
  .refine((v) => v.part <= v.parts, { message: CLINICAL_NOTE_COPY.invalid, path: ["part"] });

/** Refine 1 de C-FC3: exactamente uno de `body` / `bodyDoc` (en edición: a lo sumo uno, ver abajo). */
const exactlyOneBody = (v: { body?: unknown; bodyDoc?: unknown }) => (v.body !== undefined) !== (v.bodyDoc !== undefined);
/** Refine 3: «Usar como diagnóstico activo» exige al menos un diagnóstico (el principal) en ESTE envío. */
const activeNeedsDiagnosis = (v: { setActiveDiagnosis?: boolean; diagnoses?: unknown[] | null }) =>
  !v.setActiveDiagnosis || (v.diagnoses?.length ?? 0) > 0;

// Las refines van en el orden literal del contrato: `invalid()` muestra el primer issue.
export const CreateClinicalNoteSchema = z
  .object({
    patientId: IdSchema,
    bookingId: OptionalIdSchema,
    kind: KindSchema.optional(),
    title: TitleSchema.optional(),
    body: BodySchema.optional(),
    bodyDoc: BodyDocSchema.optional(),
    diagnoses: DiagnosesSchema.optional(),
    setActiveDiagnosis: z.boolean().optional(),
    importSource: ImportSourceSchema.nullable().optional(),
    occurredAt: IsoDateSchema.nullable().optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .refine(exactlyOneBody, { message: CLINICAL_NOTE_COPY.bodyAndDoc })
  // Una importada es «carga tardía» de una consulta vieja: asociarla a un turno mezclaría dos fuentes (§24.3).
  .refine((v) => !v.importSource || !v.bookingId, { message: CLINICAL_NOTE_COPY.importWithBooking, path: ["bookingId"] })
  .refine(activeNeedsDiagnosis, { message: DIAGNOSIS_COPY.activeNeedsPrincipal, path: ["setActiveDiagnosis"] });

export const EditClinicalNoteSchema = z
  .object({
    noteId: IdSchema,
    expectedRevision: z.number().int().min(1),
    kind: KindSchema.optional(),
    title: TitleSchema.optional(),
    body: BodySchema.optional(),
    bodyDoc: BodyDocSchema.optional(),
    // `null` o `[]` borran los diagnósticos; `undefined` no los toca.
    diagnoses: DiagnosesSchema.nullable().optional(),
    setActiveDiagnosis: z.boolean().optional(),
    occurredAt: IsoDateSchema.optional(),
  })
  .strict()
  // En una edición los dos son opcionales (cambiar solo el título): lo prohibido es mandar los dos juntos.
  .refine((v) => v.body === undefined || v.bodyDoc === undefined, { message: CLINICAL_NOTE_COPY.bodyAndDoc })
  .refine(activeNeedsDiagnosis, { message: DIAGNOSIS_COPY.activeNeedsPrincipal, path: ["setActiveDiagnosis"] })
  .refine(
    (v) =>
      v.kind !== undefined ||
      v.title !== undefined ||
      v.body !== undefined ||
      v.bodyDoc !== undefined ||
      v.diagnoses !== undefined ||
      v.occurredAt !== undefined,
    { message: "No hay cambios para guardar." }
  );

export const AmendClinicalNoteSchema = z
  .object({
    noteId: IdSchema,
    title: TitleSchema.optional(),
    body: BodySchema.optional(),
    bodyDoc: BodyDocSchema.optional(),
    diagnoses: DiagnosesSchema.optional(),
    setActiveDiagnosis: z.boolean().optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .refine(exactlyOneBody, { message: CLINICAL_NOTE_COPY.bodyAndDoc })
  .refine(activeNeedsDiagnosis, { message: DIAGNOSIS_COPY.activeNeedsPrincipal, path: ["setActiveDiagnosis"] });

export const VoidClinicalNoteSchema = z
  .object({
    noteId: IdSchema,
    expectedRevision: z.number().int().min(1),
    reason: z
      .string()
      .transform((v) => v.trim())
      .refine((v) => v.length >= CLINICAL_NOTE_VOID_REASON_MIN && v.length <= CLINICAL_NOTE_VOID_REASON_MAX, {
        message: `El motivo tiene que tener entre ${CLINICAL_NOTE_VOID_REASON_MIN} y ${CLINICAL_NOTE_VOID_REASON_MAX} caracteres.`,
      }),
  })
  .strict();

export type CreateClinicalNoteParsed = z.output<typeof CreateClinicalNoteSchema>;
export type EditClinicalNoteParsed = z.output<typeof EditClinicalNoteSchema>;
export type AmendClinicalNoteParsed = z.output<typeof AmendClinicalNoteSchema>;
export type VoidClinicalNoteParsed = z.output<typeof VoidClinicalNoteSchema>;

