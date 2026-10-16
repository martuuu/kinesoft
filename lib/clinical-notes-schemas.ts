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
  CLINICAL_NOTE_KINDS,
  CLINICAL_NOTE_TITLE_MAX,
  CLINICAL_NOTE_VOID_REASON_MAX,
  CLINICAL_NOTE_VOID_REASON_MIN,
} from "@/lib/clinical-notes-types";

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
  .refine((v) => v.length >= 1, { message: "Escribí la evolución." })
  .refine((v) => v.length <= CLINICAL_NOTE_BODY_MAX, {
    message: `La evolución puede tener hasta ${CLINICAL_NOTE_BODY_MAX.toLocaleString("es-AR")} caracteres.`,
  });

/** ISO con zona (el cliente manda `toISOString()`): sin zona sería hora del host, el bug de siempre en Vercel. */
const IsoDateSchema = z
  .string()
  .datetime({ offset: true, message: "Elegí una fecha válida." })
  .transform((s) => new Date(s));

export const CreateClinicalNoteSchema = z
  .object({
    patientId: IdSchema,
    bookingId: OptionalIdSchema,
    kind: KindSchema.optional(),
    title: TitleSchema.optional(),
    body: BodySchema,
    occurredAt: IsoDateSchema.nullable().optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export const EditClinicalNoteSchema = z
  .object({
    noteId: IdSchema,
    expectedRevision: z.number().int().min(1),
    kind: KindSchema.optional(),
    title: TitleSchema.optional(),
    body: BodySchema.optional(),
    occurredAt: IsoDateSchema.optional(),
  })
  .strict()
  .refine((v) => v.kind !== undefined || v.title !== undefined || v.body !== undefined || v.occurredAt !== undefined, {
    message: "No hay cambios para guardar.",
  });

export const AmendClinicalNoteSchema = z
  .object({
    noteId: IdSchema,
    title: TitleSchema.optional(),
    body: BodySchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();

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

