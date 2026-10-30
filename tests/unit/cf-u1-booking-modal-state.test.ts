import { describe, expect, it } from "vitest";
import * as modalState from "@/lib/booking-modal-state";
import { buildBatchPayload, buildCreatePayload, type BuildPayloadInput } from "@/lib/booking-modal-state";
import { FORCE_FLAG_BY_KIND } from "@/lib/booking-force-flags";
import { BookingCreate } from "@/lib/validation";
import { toBatchFields } from "@/lib/sessions-mode-state";

// CF-U1 (§28, CF-D4): aviso «otro servicio» en el alta de un turno y la marca informativa del lote. Helpers puros
// del modal (`lib/booking-modal-state.ts`); el render vive en `cf-u1-other-service-render.test.tsx`.

const BASE: BuildPayloadInput = {
  patientId: "pat-1",
  idempotencyKey: "key-1",
  serviceId: "s-osteo",
  practitionerId: "pr-1",
  scheduledFor: "2027-03-09T10:00:00-03:00",
  durationMin: 60,
  durationEdited: false,
};

// Forma real del `otherService` de `createBooking` (`BookingOtherServicePrompt`). 13:00Z = 10:00 AR.
const OS = {
  practitionerName: "Ana Pérez",
  serviceName: "Kinesiología",
  existingISO: "2027-03-09T13:00:00.000Z",
  nextFreeISO: "2027-03-09T14:30:00.000Z",
};

describe("[CF-U1] alta de un turno: aviso «otro servicio»", () => {
  it("[CF-U1] un resultado con otherService pide confirmación (no es error a secas)", () => {
    const r = { ok: false as const, error: "Ana Pérez está atendiendo «Kinesiología» en ese horario.", otherService: OS };
    const plain = { ok: false as const, error: "x" };
    const nulled = { ok: false as const, error: "x", otherService: null };
    expect(modalState.otherServicePromptOf(r)).toEqual(OS);
    expect(modalState.otherServicePromptOf(plain)).toBeNull();
    expect(modalState.otherServicePromptOf(nulled)).toBeNull();
  });

  it("[CF-U1] forzar suma allowOtherService, acumula los previos, misma key y pasa el zod", () => {
    const prev = { ...buildCreatePayload(BASE), allowOutOfHours: true, allowOverbooking: true };
    const p = modalState.withConfirmation(prev, "otherService");
    expect(p.allowOtherService).toBe(true);
    expect(p.allowOutOfHours).toBe(true);
    expect(p.allowOverbooking).toBe(true);
    // Flag propio: es el de `FORCE_FLAG_BY_KIND.otherService`, no `allowOverbooking`.
    expect(FORCE_FLAG_BY_KIND.otherService).toBe("allowOtherService");
    const fresh = modalState.withConfirmation(buildCreatePayload(BASE), "otherService");
    expect(fresh.allowOverbooking).toBeUndefined();
    expect(p.idempotencyKey).toBe(BASE.idempotencyKey);
    expect(BookingCreate.safeParse(p).success).toBe(true);
  });

  it("[CF-U1] «Usar próximo libre» saca allowOtherService (el horario nuevo se valida de cero)", () => {
    const p = { ...buildCreatePayload(BASE), allowOtherService: true };
    const moved = modalState.withNextFree(p, "2027-03-09T11:30:00-03:00");
    expect("allowOtherService" in moved).toBe(false);
    expect(moved.idempotencyKey).toBe(BASE.idempotencyKey);
  });

  it("[CF-U1] el lote NO manda allowOtherService (CF-D4: lo pliega en sobreturno)", () => {
    const p = { ...buildCreatePayload(BASE), allowOtherService: true };
    const batch = buildBatchPayload(p, toBatchFields({ count: 3, daysOfWeek: [], frequency: "weekly" }));
    expect("allowOtherService" in batch).toBe(false);
  });

  it("[CF-U1] copy con nombre de servicio: titular del helper, detalle en hora AR, próximo libre y acciones", () => {
    const c = modalState.otherServicePromptCopy(OS);
    expect(c.title).toBe("Ana Pérez está atendiendo «Kinesiología» en ese horario.");
    expect(c.detail).toBe("Ese turno de Kinesiología empieza a las 10:00.");
    expect(c.nextFreeLine).toBe("Próximo horario libre: 11:30");
    expect(c.confirmLabel).toBe("Cargar como sobreturno");
    expect(c.backLabel).toBe("Elegir otro horario");
  });

  it("[CF-U1] copy sin nombre de servicio ni próximo libre: genérico «otro servicio»", () => {
    const c = modalState.otherServicePromptCopy({ ...OS, serviceName: null, nextFreeISO: null });
    expect(c.title).toBe("Ana Pérez está atendiendo otro servicio en ese horario.");
    expect(c.detail).toBe("Ese turno de otro servicio empieza a las 10:00.");
    expect(c.nextFreeLine).toBeNull();
  });

  it("[CF-U1] próximo libre otro día: lleva el día (solo la hora mentiría)", () => {
    const c = modalState.otherServicePromptCopy({ ...OS, nextFreeISO: "2027-03-10T12:00:00.000Z" });
    expect(c.nextFreeLine).toMatch(/^Próximo horario libre: .*10.*09:00$/);
  });
});

describe("[CF-U1] lote: marca «Atiende otro servicio»", () => {
  it("[CF-U1] marca de la fecha solo con el flag", () => {
    expect(modalState.BATCH_OTHER_SERVICE_LABEL).toBe("Atiende otro servicio");
    expect(modalState.batchOtherServiceMark({ otherServiceBusy: true })).toBe("Atiende otro servicio");
    expect(modalState.batchOtherServiceMark({})).toBeNull();
    expect(modalState.batchOtherServiceMark({ otherServiceBusy: false })).toBeNull();
  });

  it("[CF-U1] resultado real: fechas libres en el preflight que chocaron después", () => {
    const dates = [
      { status: "libre", outOfHours: false, blocked: false, otherServiceBusy: true },
      { status: "sobreturno", outOfHours: false, blocked: false, otherServiceBusy: true },
      { status: "libre", outOfHours: false, blocked: false },
    ];
    expect(modalState.batchLateOtherServiceCount(dates)).toBe(1);
    expect(modalState.batchLateOtherServiceLine(1)).toBe("1 fecha se ocupó con otro servicio mientras tanto");
    expect(modalState.batchLateOtherServiceLine(2)).toBe("2 fechas se ocuparon con otro servicio mientras tanto");
  });
});
