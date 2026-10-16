import "server-only";
/**
 * Zod de entrada de `lib/availability-actions.ts` (B3.3), fuera de `lib/availability-actions-types.ts` desde PF1-Z
 * (D-PF5). Por qué: el archivo de tipos lo importan los componentes de la agenda y del modal de turno; con estos
 * schemas adentro, zod entero (~13 kB gz) entraba al JS inicial de /agenda (`check-bundle-budget.mjs --explain`). Solo
 * los usa la action (server), así que van con `server-only`. Semántica sin cambios.
 */
import { z } from "zod";
import { dayKeyDiff, isDayKey } from "@/lib/availability/day";
import { RECURRENCE_MAX_COUNT } from "@/lib/availability/recurrence";
import { AGENDA_AVAILABILITY_MAX_DAYS, AVAILABILITY_MAX_PRACTITIONERS } from "@/lib/availability-actions-types";

// ─────────────────────────────────────────────────────────────────────────────
// Entrada (zod), movido tal cual desde availability-actions-types.ts
// ─────────────────────────────────────────────────────────────────────────────

const Id = z.string().trim().min(1).max(64);
const OptId = Id.nullish().or(z.literal("").transform(() => null));
const DayKeyZ = z.string().refine((s) => isDayKey(s), "Fecha inválida (YYYY-MM-DD)");
// ISO con offset o Z: `new Date()` de un "2027-03-09T10:00" sin zona lo lee
// en la TZ del host (UTC en Vercel) → 3 h corrido. Se exige la zona.
const IsoInstant = z
  .string()
  .max(40)
  .refine((s) => /(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)), "Instante inválido (ISO con zona)");
const DurationMin = z.number().int().min(5).max(480);

export const AgendaAvailabilityQuery = z
  .object({
    from: DayKeyZ,
    to: DayKeyZ,
    practitionerIds: z.array(Id).max(AVAILABILITY_MAX_PRACTITIONERS).optional(),
    locationId: OptId,
  })
  .superRefine((v, ctx) => {
    if (!isDayKey(v.from) || !isDayKey(v.to)) return;
    const span = dayKeyDiff(v.from, v.to);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "La fecha final es anterior a la inicial." });
    else if (span + 1 > AGENDA_AVAILABILITY_MAX_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Máximo ${AGENDA_AVAILABILITY_MAX_DAYS} días.` });
    }
  });
export type AgendaAvailabilityQueryInput = z.input<typeof AgendaAvailabilityQuery>;

export const ListSlotsQuery = z.object({
  /** Un profesional, o "any" = cualquiera habilitado para el servicio. */
  practitionerId: z.union([z.literal("any"), Id]),
  serviceId: Id,
  dayKey: DayKeyZ,
  locationId: OptId,
  /** Cobertura del paciente (`Insurer.id`): con "any", filtra por PractitionerPayer. */
  insurerId: OptId,
  /** Marca los slots donde el paciente ya está ocupado (no sale en la respuesta). */
  patientId: OptId,
  /** Duración forzada; sin ella, la del profesional para el servicio (o la del servicio). */
  durationMin: DurationMin.optional(),
  /** Uno de `STAFF_SLOT_STEPS`; sin él, `STAFF_SLOT_STEP_MIN`. */
  stepMin: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]).optional(),
});
export type ListSlotsQueryInput = z.input<typeof ListSlotsQuery>;

export const ClassifyInstantQuery = z.object({
  practitionerId: Id,
  serviceId: Id,
  scheduledFor: IsoInstant,
  durationMin: DurationMin.optional(),
  locationId: OptId,
  patientId: OptId,
  /** Edición: el turno que se mueve no cuenta contra sí mismo. */
  excludeBookingId: OptId,
  /**
   * SR: sala a chequear. AUSENTE (undefined) = la sala por defecto de la franja
   * (`defaultRoomFor`), que vuelve en `InstantCheck.defaultRoomId`; null (o "")
   * = "Sin sala" explícito: no se chequea ocupación. El modal NO manda el campo
   * con "Según el horario del profesional". Hasta SR3a la action lo ignora.
   */
  roomId: OptId,
});
export type ClassifyInstantQueryInput = z.input<typeof ClassifyInstantQuery>;

export const RecurrencePreviewQuery = z.object({
  /** Primera sesión (fecha y hora de pared que se repite). */
  anchor: IsoInstant,
  count: z.number().int().min(1).max(RECURRENCE_MAX_COUNT),
  /** 0=Lun … 6=Dom (convención del batch/UI, NO el `Dow` 0=Dom del motor).
   *  Vacío/ausente = el día del ancla. Ignorado en mensual. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  frequency: z.enum(["weekly", "biweekly", "monthly"]),
  practitionerId: Id,
  serviceId: Id,
  patientId: OptId,
  durationMin: DurationMin.optional(),
  locationId: OptId,
});
export type RecurrencePreviewQueryInput = z.input<typeof RecurrencePreviewQuery>;

