/**
 * Servicios y coberturas por profesional (B2.4b CFG-api-2, B-pre) — zod y
 * tipos compartidos cliente/servidor.
 *
 * Va separado de `lib/practitioner-services.ts` / `lib/practitioner-payers.ts`
 * porque esos son `"use server"` y solo pueden exportar funciones async; los
 * editores de Configuración (B3.5: `panels/practitioners/{services,payers}-
 * editor.tsx`) importan de acá los tipos de fila y los límites.
 *
 * Los ids que entran por acá son SOLO forma: que el profesional, el servicio y
 * la obra social sean del tenant lo valida la action dentro de la tx de
 * escritura — las FK saltean RLS y en prod la conexión tiene BYPASSRLS.
 */
import { z } from "zod";
import type { PracticeVisibility } from "@prisma/client";
import { PUBLIC_MIN_LEAD_MAX_MINUTES } from "@/lib/availability/agenda-rules";

/** Id de fila del tenant (cuid). El tope evita payloads absurdos en el where. */
export const EntityId = z.string().trim().min(1).max(64);

// Topes de negocio. Duración: la misma grilla de 5 min que `Service.durationMin`
// (5..480, `lib/services.ts`); el múltiplo de 5 es porque el motor arma slots
// sobre minutos AR y un 47 dejaría huecos de 3 min imposibles de ofrecer.
export const PS_DURATION_MIN = 5;
export const PS_DURATION_MAX = 480;
/**
 * Anticipación mínima: hasta 8 semanas en minutos (CF-D8). Antes 30 días; ahora el mismo tope que la del consultorio
 * (`Tenant.publicMinLeadMinutes`, CHECK de M20), así un servicio puede pedir tanta anticipación como el consultorio.
 */
export const PS_MIN_LEAD_MAX = PUBLIC_MIN_LEAD_MAX_MINUTES;
/** Horizonte: hasta 2 años. */
export const PS_MAX_LEAD_DAYS_MAX = 730;
/** Mismo tope que `Service.maxConcurrent`. */
export const PS_MAX_CONCURRENT_MAX = 50;
/**
 * CF3 (M22, D-CF3-1): precio del profesional para el servicio, en centavos. Mismo rango que el CHECK
 * `PractitionerService_priceCents_check` (0..100 000 000 = $1 000 000): si rebotara en la base saldría un 500 sin decir
 * qué corregir. 0 vale (sesión sin cargo).
 */
export const PS_PRICE_CENTS_MAX = 100_000_000;

/** "" / undefined / null → null; el resto se coerciona a número. */
const nullableInt = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? null : v),
    z.coerce.number().pipe(inner).nullable()
  );

/**
 * Config de un servicio para un profesional. Los null HEREDAN (contrato de
 * `PractitionerServiceRule` en `lib/availability/types.ts`): `durationMin` de
 * Service, `minLeadMinutes` del canal, `maxLeadDays` sin tope. `maxConcurrent`
 * solo cuenta con `concurrencyOverride` (override + null = ilimitado); sin
 * override se guarda null aunque venga un número (la UI puede conservar el
 * valor del input al apagar el switch y no queremos un "cupo fantasma").
 */
export const PractitionerServiceInput = z
  .object({
    enabled: z.boolean(),
    durationMin: nullableInt(
      z
        .number()
        .int("Duración en minutos enteros")
        .min(PS_DURATION_MIN, `Mínimo ${PS_DURATION_MIN} minutos`)
        .max(PS_DURATION_MAX, `Máximo ${PS_DURATION_MAX} minutos`)
        .refine((n) => n % 5 === 0, "La duración va de a 5 minutos")
    ).optional(),
    visibility: z.enum(["PUBLIC", "PRIVATE"]),
    minLeadMinutes: nullableInt(
      z.number().int().min(0, "La anticipación no puede ser negativa").max(PS_MIN_LEAD_MAX, "Máximo 8 semanas de anticipación")
    ).optional(),
    maxLeadDays: nullableInt(
      z.number().int().min(0, "El horizonte no puede ser negativo").max(PS_MAX_LEAD_DAYS_MAX)
    ).optional(),
    concurrencyOverride: z.boolean(),
    maxConcurrent: nullableInt(
      z.number().int().min(1, "Mínimo 1").max(PS_MAX_CONCURRENT_MAX)
    ).optional(),
    notifyOnBooking: z.boolean(),
    /**
     * CF3 (D-CF3-1): centavos enteros (el cliente convierte con `parseARS`; acá no se coerciona texto para no
     * aceptar «12,5» como 12). `null` = hereda (Service / plan de la OS); OMITIDO = no se toca: el editor de
     * Profesionales anterior a CF3 no lo manda y no tiene que borrar el precio que el profesional cargó en «Mi agenda».
     */
    priceCents: z
      .number({ invalid_type_error: "Precio inválido" })
      .int("El precio va en centavos enteros")
      .min(0, "El precio no puede ser negativo")
      .max(PS_PRICE_CENTS_MAX, "Máximo $ 1.000.000")
      .nullable()
      .optional(),
  })
  .transform((v) => ({
    enabled: v.enabled,
    durationMin: v.durationMin ?? null,
    visibility: v.visibility as PracticeVisibility,
    minLeadMinutes: v.minLeadMinutes ?? null,
    maxLeadDays: v.maxLeadDays ?? null,
    concurrencyOverride: v.concurrencyOverride,
    maxConcurrent: v.concurrencyOverride ? (v.maxConcurrent ?? null) : null,
    notifyOnBooking: v.notifyOnBooking,
    // `undefined` sale tal cual: Prisma lo omite del update (no se toca).
    priceCents: v.priceCents,
  }));

export type PractitionerServiceInputT = z.input<typeof PractitionerServiceInput>;

/** Reemplazo del set de coberturas. Duplicados se colapsan en la action. */
export const PractitionerPayersInput = z.object({
  practitionerId: EntityId,
  insurerIds: z.array(EntityId).max(500),
});

/**
 * Fila de `listPractitionerServices`: TODOS los servicios del tenant, con la
 * fila `PractitionerService` si existe o el default si no (`hasRow: false`).
 *
 * Default sin fila (decisión 7 + backfill de agenda_foundations): habilitado
 * si el servicio es compartido (`Service.practitionerId` null) o es de este
 * profesional; deshabilitado si es de OTRO profesional (el backfill no le
 * creó fila). PUBLIC, sin overrides.
 */
export type PractitionerServiceRow = {
  serviceId: string;
  serviceName: string;
  serviceColor: string | null;
  /** Valores del Service (lo que se hereda cuando el override es null). */
  serviceDurationMin: number;
  serviceMaxConcurrent: number | null;
  /** Dueño legacy del servicio (`Service.practitionerId`); null = compartido. */
  serviceOwnerPractitionerId: string | null;
  hasRow: boolean;
  enabled: boolean;
  durationMin: number | null;
  visibility: PracticeVisibility;
  minLeadMinutes: number | null;
  maxLeadDays: number | null;
  concurrencyOverride: boolean;
  maxConcurrent: number | null;
  notifyOnBooking: boolean;
  /** CF3 (M22): precio de este profesional en centavos; null = hereda (sin fila, null). */
  priceCents: number | null;
  /** CF3: `Service.priceCents` (lo que se hereda cuando `priceCents` es null; para el «hereda $ X» del editor). */
  servicePriceCents: number;
};

/**
 * Fila de `listPractitionerPayers`: todas las obras sociales del tenant (incl.
 * inactivas, marcadas) con el estado para el profesional. Sin fila = activa
 * (decisión 7: insurer nuevo habilitado por defecto para todos). Particular
 * siempre activa.
 */
export type PractitionerPayerRow = {
  insurerId: string;
  name: string;
  isParticular: boolean;
  /** `Insurer.active`: una OS desactivada en el consultorio no se ofrece igual. */
  insurerActive: boolean;
  hasRow: boolean;
  active: boolean;
};
