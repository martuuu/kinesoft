/**
 * B5.1 MOD-core — lógica pura del modal de turno nuevo
 * (`lib/booking-modal-state.ts`): modos y permiso de bloqueo, servicios por
 * profesional, duración por defecto (sin 45 fijo), sede/telemedicina y el
 * armado del payload con los flags de los prompts.
 */
import { describe, expect, it } from "vitest";
import {
  availableModes,
  blockPermission,
  buildBatchPayload,
  buildCreatePayload,
  clampDuration,
  coerceMode,
  displayDuration,
  isBatchSubmit,
  isServiceEnabledFor,
  reconcileServiceOnPractitionerChange,
  servicesForPractitioner,
  showLocationPicker,
  submitLabel,
  telemedicineUrlError,
  withConfirmation,
  withNextFree,
  ROOM_CHOICE_DEFAULT,
  ROOM_CHOICE_NONE,
  batchCreatableCounts,
  batchNeedsPrompt,
  batchRoomBusyCounts,
  batchRunInput,
  defaultRoomOptionLabel,
  effectiveLocationId,
  initialRoomChoice,
  reconcileRoomOnLocationChange,
  roomBusyCopy,
  roomBusyLiveLine,
  roomBusyOf,
  roomPayloadValue,
  roomsForModal,
  showRoomPicker,
  type BuildPayloadInput,
} from "@/lib/booking-modal-state";
import { BookingBatchCreate, BookingCreate } from "@/lib/validation";
import { toBatchFields } from "@/lib/sessions-mode-state";

const SERVICES = [
  { id: "s-kine", name: "Kinesiología", durationMin: 45 },
  { id: "s-osteo", name: "Osteopatía", durationMin: 60 },
  { id: "s-rpg", name: "RPG", durationMin: 50 },
];

const BASE: BuildPayloadInput = {
  patientId: "pat-1",
  idempotencyKey: "key-1",
  serviceId: "s-osteo",
  practitionerId: "pr-1",
  scheduledFor: "2027-03-09T10:00:00-03:00",
  durationMin: 60,
  durationEdited: false,
};

describe("modos y permiso de bloqueo", () => {
  it("manageBlocks: bloquea a cualquiera y a todos", () => {
    expect(blockPermission(["agenda.viewAll", "agenda.manageBlocks"], null)).toEqual({
      canBlock: true,
      canBlockAll: true,
      onlyPractitionerId: null,
    });
  });

  it("manageOwnBlocks: solo su propia agenda, y necesita su profesional", () => {
    expect(blockPermission(["agenda.manageOwnBlocks"], "pr-9")).toEqual({
      canBlock: true,
      canBlockAll: false,
      onlyPractitionerId: "pr-9",
    });
    expect(blockPermission(["agenda.manageOwnBlocks"], null).canBlock).toBe(false);
  });

  it("sin capabilities (prop ausente) o BILLING → sin modo bloquear (falla cerrado)", () => {
    expect(blockPermission(undefined, "pr-1").canBlock).toBe(false);
    expect(blockPermission(["agenda.viewAll", "billing.manage"], "pr-1").canBlock).toBe(false);
  });

  it("selector: Turno · Varias sesiones (· Bloquear horario con permiso)", () => {
    expect(availableModes(false)).toEqual(["single", "sessions"]);
    expect(availableModes(true)).toEqual(["single", "sessions", "block"]);
    expect(coerceMode("block", false)).toBe("single");
    expect(coerceMode("block", true)).toBe("block");
    expect(coerceMode("sessions", false)).toBe("sessions");
  });
});

describe("servicios por profesional", () => {
  const enabled = { "pr-1": ["s-kine", "s-osteo"], "pr-2": ["s-rpg"] };

  it("filtra por los habilitados del profesional", () => {
    expect(servicesForPractitioner(SERVICES, enabled, "pr-1").map((s) => s.id)).toEqual(["s-kine", "s-osteo"]);
    expect(servicesForPractitioner(SERVICES, enabled, "pr-2").map((s) => s.id)).toEqual(["s-rpg"]);
  });

  it("sin mapa o sin entrada del profesional → todos (no esconder por un dato faltante)", () => {
    expect(servicesForPractitioner(SERVICES, undefined, "pr-1")).toHaveLength(3);
    expect(servicesForPractitioner(SERVICES, enabled, "pr-3")).toHaveLength(3);
  });

  it("conserva el servicio ya elegido aunque no esté habilitado", () => {
    expect(servicesForPractitioner(SERVICES, enabled, "pr-2", "s-kine").map((s) => s.id)).toEqual(["s-kine", "s-rpg"]);
  });

  it("isServiceEnabledFor: true/false con mapa, null si no se sabe", () => {
    expect(isServiceEnabledFor(enabled, "pr-1", "s-osteo")).toBe(true);
    expect(isServiceEnabledFor(enabled, "pr-1", "s-rpg")).toBe(false);
    expect(isServiceEnabledFor(undefined, "pr-1", "s-rpg")).toBeNull();
    expect(isServiceEnabledFor(enabled, "pr-1", "")).toBeNull();
  });

  it("cambiar de profesional limpia el servicio que el nuevo no atiende (no lo cambia por otro)", () => {
    expect(reconcileServiceOnPractitionerChange("s-osteo", enabled, "pr-2")).toBe("");
    expect(reconcileServiceOnPractitionerChange("s-rpg", enabled, "pr-2")).toBe("s-rpg");
    expect(reconcileServiceOnPractitionerChange("s-osteo", undefined, "pr-2")).toBe("s-osteo");
  });
});

describe("duración por defecto", () => {
  it("la del profesional (chequeo en vivo) gana sobre la del servicio", () => {
    expect(displayDuration({ serviceId: "s-osteo", services: SERVICES, practitionerDurationMin: 40 })).toBe(40);
    expect(displayDuration({ serviceId: "s-osteo", services: SERVICES })).toBe(60);
  });

  it("sin servicio no hay duración (nunca 45 fijo)", () => {
    expect(displayDuration({ serviceId: "", services: SERVICES, practitionerDurationMin: 30 })).toBeNull();
  });

  it("clampDuration acota a 15..240 y vacío → null", () => {
    expect(clampDuration("5")).toBe(15);
    expect(clampDuration(300)).toBe(240);
    expect(clampDuration("")).toBeNull();
    expect(clampDuration("abc")).toBeNull();
    expect(clampDuration("50")).toBe(50);
  });
});

describe("sede y telemedicina", () => {
  it("el selector de sede aparece solo con >1 sede", () => {
    expect(showLocationPicker(undefined)).toBe(false);
    expect(showLocationPicker([{ id: "l1", name: "Centro", isPrimary: true }])).toBe(false);
    expect(
      showLocationPicker([
        { id: "l1", name: "Centro", isPrimary: true },
        { id: "l2", name: "Norte", isPrimary: false },
      ])
    ).toBe(true);
  });

  it("URL: vacía ok, https ok, http/javascript/basura no, >500 no", () => {
    expect(telemedicineUrlError("")).toBeNull();
    expect(telemedicineUrlError("https://meet.google.com/abc-defg-hij")).toBeNull();
    expect(telemedicineUrlError("http://meet.google.com/x")).toMatch(/https/);
    expect(telemedicineUrlError("javascript:alert(1)")).toMatch(/https/);
    expect(telemedicineUrlError("https://")).toMatch(/válido/);
    expect(telemedicineUrlError("https://x.com/" + "a".repeat(500))).toMatch(/500/);
  });

  it("paridad con el zod del server: lo que el modal acepta, BookingCreate también", () => {
    for (const url of ["https://meet.google.com/abc-defg-hij", "https://zoom.us/j/123?pwd=x"]) {
      expect(telemedicineUrlError(url)).toBeNull();
      const p = buildCreatePayload({ ...BASE, isTelemedicine: true, telemedicineUrl: url });
      expect(BookingCreate.safeParse(p).success).toBe(true);
    }
  });
});

describe("armado del payload", () => {
  it("sin tocar la duración NO manda durationMin (el server usa la del profesional)", () => {
    const p = buildCreatePayload(BASE);
    expect("durationMin" in p).toBe(false);
    const parsed = BookingCreate.parse(p);
    expect(parsed.durationMin).toBeUndefined();
  });

  it("con la duración tocada la manda", () => {
    expect(buildCreatePayload({ ...BASE, durationMin: 30, durationEdited: true }).durationMin).toBe(30);
  });

  it("copago: solo si difiere del sugerido", () => {
    expect(buildCreatePayload({ ...BASE, copago: { inputCents: 500000, suggestedCents: 500000 } }).copagoCents).toBeUndefined();
    expect(buildCreatePayload({ ...BASE, copago: { inputCents: 300000, suggestedCents: 500000 } }).copagoCents).toBe(300000);
  });

  it("sede: '' = automática (no se manda); elegida = se manda", () => {
    expect("locationId" in buildCreatePayload({ ...BASE, locationId: "" })).toBe(false);
    expect(buildCreatePayload({ ...BASE, locationId: "loc-2" }).locationId).toBe("loc-2");
  });

  it("telemedicina: la URL solo viaja con el switch prendido", () => {
    const off = buildCreatePayload({ ...BASE, isTelemedicine: false, telemedicineUrl: "https://x.com" });
    expect(off.isTelemedicine).toBeUndefined();
    expect(off.telemedicineUrl).toBeUndefined();
    const on = buildCreatePayload({ ...BASE, isTelemedicine: true, telemedicineUrl: "  https://x.com/a  " });
    expect(on).toMatchObject({ isTelemedicine: true, telemedicineUrl: "https://x.com/a" });
    const onNoUrl = buildCreatePayload({ ...BASE, isTelemedicine: true, telemedicineUrl: "  " });
    expect(onNoUrl.isTelemedicine).toBe(true);
    expect(onNoUrl.telemedicineUrl).toBeUndefined();
  });

  it("título/descripción vacíos → undefined (el server toma el diagnóstico del paciente)", () => {
    const p = buildCreatePayload({ ...BASE, title: "  ", description: "", notes: "" });
    expect(p.title).toBeUndefined();
    expect(p.description).toBeUndefined();
    expect(p.notes).toBeUndefined();
  });

  it("los flags de los prompts se acumulan y conservan la idempotencyKey", () => {
    const p0 = buildCreatePayload(BASE);
    const p1 = withConfirmation(p0, "blocked");
    const p2 = withConfirmation(p1, "outOfHours");
    const p3 = withConfirmation(p2, "patientOverlap");
    expect(p3).toMatchObject({
      allowBlocked: true,
      allowOutOfHours: true,
      allowPatientOverlap: true,
      allowSamePatientDay: true,
      idempotencyKey: "key-1",
    });
    expect(withConfirmation(p0, "overbooking").allowOverbooking).toBe(true);
    expect(withConfirmation(p0, "samePatientDay")).toMatchObject({ allowSamePatientDay: true });
    expect(withConfirmation(p0, "samePatientDay").allowPatientOverlap).toBeUndefined();
    // No muta el original.
    expect(p0.allowBlocked).toBeUndefined();
  });

  it("usar próximo libre: cambia el instante y descarta las confirmaciones del horario viejo", () => {
    const forced = withConfirmation(withConfirmation(buildCreatePayload(BASE), "blocked"), "patientOverlap");
    const next = withNextFree(forced, "2027-03-09T15:00:00.000Z");
    expect(next.scheduledFor).toBe("2027-03-09T15:00:00.000Z");
    expect(next.allowBlocked).toBeUndefined();
    expect(next.allowPatientOverlap).toBeUndefined();
    expect(next.allowSamePatientDay).toBeUndefined();
    expect(next.idempotencyKey).toBe("key-1");
    expect(next.serviceId).toBe("s-osteo");
  });
});

describe("varias sesiones", () => {
  const base = buildCreatePayload({ ...BASE, isTelemedicine: true, locationId: "loc-2" });

  it("batch = alta + serie (toBatchFields de B5.3): días, frecuencia, mensual sin días", () => {
    const weekly = buildBatchPayload(base, toBatchFields({ count: 8, daysOfWeek: [2, 0], frequency: "weekly" }));
    expect(weekly).toMatchObject({ count: 8, frequency: "weekly", daysOfWeek: [0, 2], locationId: "loc-2", isTelemedicine: true });
    expect(buildBatchPayload(base, toBatchFields({ count: 4, daysOfWeek: [], frequency: "biweekly" })).daysOfWeek).toBeUndefined();
    expect(buildBatchPayload(base, toBatchFields({ count: 4, daysOfWeek: [1], frequency: "monthly" })).daysOfWeek).toBeUndefined();
    expect(BookingBatchCreate.safeParse(weekly).success).toBe(true);
    // Sin duración tocada tampoco viaja en el batch (la del profesional).
    expect("durationMin" in weekly).toBe(false);
  });

  it("el batch no arrastra flags de un alta simple anterior", () => {
    const b = buildBatchPayload(
      withConfirmation(withConfirmation(base, "blocked"), "overbooking"),
      toBatchFields({ count: 2, daysOfWeek: [], frequency: "weekly" })
    );
    expect("allowBlocked" in b).toBe(false);
    expect("allowOverbooking" in b).toBe(false);
  });

  it("una sola sesión va por el alta simple; etiqueta del botón", () => {
    expect(isBatchSubmit("sessions", 1)).toBe(false);
    expect(isBatchSubmit("sessions", 2)).toBe(true);
    expect(isBatchSubmit("single", 5)).toBe(false);
    expect(submitLabel("sessions", 6, false)).toBe("Crear 6 sesiones");
    expect(submitLabel("single", 6, false)).toBe("Crear turno");
    expect(submitLabel("sessions", 2, true)).toBe("Creando…");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SR-U5c — sala en el modal de turno
// ─────────────────────────────────────────────────────────────────────────────

describe("[SR-U5c] sala: select y payload", () => {
  const ROOMS = [
    { id: "r-c1", locationId: "loc-centro", name: "Consultorio 1" },
    { id: "r-c2", locationId: "loc-centro", name: "Consultorio 2" },
    { id: "r-gym", locationId: "loc-norte", name: "Gimnasio" },
  ];
  const LOCS = [
    { id: "loc-centro", name: "Centro", isPrimary: true },
    { id: "loc-norte", name: "Norte", isPrimary: false },
  ];

  it("sin salas no hay select y roomId nunca viaja (payload idéntico al de antes)", () => {
    expect(showRoomPicker(undefined)).toBe(false);
    expect(showRoomPicker([])).toBe(false);
    expect(initialRoomChoice("r-c1", [])).toBe(ROOM_CHOICE_DEFAULT);
    expect(initialRoomChoice(null, undefined)).toBe(ROOM_CHOICE_DEFAULT);
    expect(roomPayloadValue(ROOM_CHOICE_NONE, [])).toBeUndefined();
    const before = buildCreatePayload(BASE);
    const after = buildCreatePayload({ ...BASE, roomId: roomPayloadValue("", []) });
    expect(after).toEqual(before);
    expect("roomId" in after).toBe(false);
    expect(effectiveLocationId("", "r-c1", [])).toBe("");
  });

  it("payload de cada opción: según el horario (ausente), Sin sala (null), una sala (id)", () => {
    expect(showRoomPicker(ROOMS)).toBe(true);
    const def = buildCreatePayload({ ...BASE, roomId: roomPayloadValue(ROOM_CHOICE_DEFAULT, ROOMS) });
    expect("roomId" in def).toBe(false);
    const none = buildCreatePayload({ ...BASE, roomId: roomPayloadValue(ROOM_CHOICE_NONE, ROOMS) });
    expect(none.roomId).toBeNull();
    const c2 = buildCreatePayload({ ...BASE, roomId: roomPayloadValue("r-c2", ROOMS) });
    expect(c2.roomId).toBe("r-c2");
    // Un id que no está en el catálogo no viaja (el server lo rechazaría).
    expect(roomPayloadValue("r-archivada", ROOMS)).toBeUndefined();
    // Los tres pasan el zod real del alta (null ≠ ausente).
    expect(BookingCreate.safeParse(def).success).toBe(true);
    const parsedNone = BookingCreate.safeParse(none);
    expect(parsedNone.success && parsedNone.data.roomId).toBeNull();
    const parsedC2 = BookingCreate.safeParse(c2);
    expect(parsedC2.success && parsedC2.data.roomId).toBe("r-c2");
  });

  it("defaultRoomId desde la celda: id → preseleccionada; null → Sin sala; desconocida → según el horario", () => {
    expect(initialRoomChoice("r-c2", ROOMS)).toBe("r-c2");
    expect(initialRoomChoice(null, ROOMS)).toBe(ROOM_CHOICE_NONE);
    expect(initialRoomChoice(undefined, ROOMS)).toBe(ROOM_CHOICE_DEFAULT);
    expect(initialRoomChoice("r-archivada", ROOMS)).toBe(ROOM_CHOICE_DEFAULT);
  });

  it("opción por defecto nombrada con la sala de la franja", () => {
    expect(defaultRoomOptionLabel("r-c2", ROOMS)).toBe("Según el horario del profesional (Consultorio 2)");
    expect(defaultRoomOptionLabel(null, ROOMS)).toBe("Según el horario del profesional");
    expect(defaultRoomOptionLabel(undefined, ROOMS)).toBe("Según el horario del profesional");
  });

  it("salas ofrecidas: las de la sede elegida; con 'según el horario', las de la sede de la sala por defecto o la principal", () => {
    const ids = (rs: { id: string }[]) => rs.map((r) => r.id);
    expect(ids(roomsForModal(ROOMS, { locationId: "loc-norte", locations: LOCS }))).toEqual(["r-gym"]);
    expect(ids(roomsForModal(ROOMS, { locationId: "", locations: LOCS, defaultRoomId: "r-gym" }))).toEqual(["r-gym"]);
    expect(ids(roomsForModal(ROOMS, { locationId: "", locations: LOCS }))).toEqual(["r-c1", "r-c2"]);
    // Sin sedes ni sala por defecto: todas.
    expect(ids(roomsForModal(ROOMS, { locationId: "" }))).toEqual(["r-c1", "r-c2", "r-gym"]);
    // La elegida se mantiene aunque sea de otra sede.
    expect(ids(roomsForModal(ROOMS, { locationId: "", locations: LOCS, keepRoomId: "r-gym" }))).toEqual([
      "r-c1",
      "r-c2",
      "r-gym",
    ]);
  });

  it("al cambiar de sede, la sala de otra sede se limpia; Sin sala y según el horario se conservan", () => {
    expect(reconcileRoomOnLocationChange("r-c2", ROOMS, "loc-norte")).toBe(ROOM_CHOICE_DEFAULT);
    expect(reconcileRoomOnLocationChange("r-c2", ROOMS, "loc-centro")).toBe("r-c2");
    expect(reconcileRoomOnLocationChange("r-c2", ROOMS, "")).toBe("r-c2");
    expect(reconcileRoomOnLocationChange(ROOM_CHOICE_NONE, ROOMS, "loc-norte")).toBe(ROOM_CHOICE_NONE);
    expect(reconcileRoomOnLocationChange(ROOM_CHOICE_DEFAULT, ROOMS, "loc-norte")).toBe(ROOM_CHOICE_DEFAULT);
  });

  it("sede del payload: la elegida manda; con 'según el horario' + sala, la de la sala", () => {
    expect(effectiveLocationId("loc-centro", "r-c2", ROOMS)).toBe("loc-centro");
    expect(effectiveLocationId("", "r-gym", ROOMS)).toBe("loc-norte");
    expect(effectiveLocationId("", ROOM_CHOICE_NONE, ROOMS)).toBe("");
    expect(effectiveLocationId("", ROOM_CHOICE_DEFAULT, ROOMS)).toBe("");
  });
});

describe("[SR-U5c] sala ocupada: aviso y reenvío", () => {
  it("roomBusy del resultado → copy literal y 'Agendar igual'", () => {
    const rb = roomBusyOf({ conflict: undefined, roomBusy: { roomName: "Consultorio 2", blocked: null } });
    expect(rb).not.toBeNull();
    const copy = roomBusyCopy(rb!);
    expect(copy.title).toBe("Consultorio 2 ya está ocupado a esa hora.");
    expect(copy.confirmLabel).toBe("Agendar igual");
    expect(copy.detail).toContain("No queda como sobreturno");
    expect(roomBusyOf({ conflict: undefined })).toBeNull();
    expect(roomBusyOf({ conflict: undefined, roomBusy: null })).toBeNull();
  });

  it("bloqueo de sala: el motivo va en el titular", () => {
    expect(roomBusyCopy({ roomName: "Consultorio 2", blocked: { reason: "Mantenimiento" } }).title).toBe(
      "Consultorio 2 está bloqueado a esa hora (Mantenimiento)."
    );
    expect(roomBusyCopy({ roomName: "Consultorio 2", blocked: { reason: null } }).title).toBe(
      "Consultorio 2 está bloqueado a esa hora."
    );
    expect(roomBusyLiveLine(null)).toBeNull();
    expect(roomBusyLiveLine({ roomName: "Box 1" })).toBe("Box 1 ya está ocupado a esa hora.");
  });

  it("reenvío con allowRoomConflict: se acumula, no marca sobreturno y pasa el zod", () => {
    const p = withConfirmation({ ...buildCreatePayload({ ...BASE, roomId: "r-c2" }), allowOutOfHours: true }, "roomConflict");
    expect(p.allowRoomConflict).toBe(true);
    expect(p.allowOutOfHours).toBe(true);
    expect(p.allowOverbooking).toBeUndefined();
    expect(p.roomId).toBe("r-c2");
    expect(p.idempotencyKey).toBe(BASE.idempotencyKey);
    expect(BookingCreate.safeParse(p).success).toBe(true);
  });

  it("'Usar próximo libre' y el batch sacan allowRoomConflict (se re-chequea de cero)", () => {
    const p = withConfirmation(buildCreatePayload({ ...BASE, roomId: "r-c2" }), "roomConflict");
    const moved = withNextFree(p, "2026-10-06T13:00:00.000-03:00");
    expect("allowRoomConflict" in moved).toBe(false);
    expect(moved.roomId).toBe("r-c2");
    const batch = buildBatchPayload(p, toBatchFields({ count: 3, daysOfWeek: [], frequency: "weekly" }));
    expect("allowRoomConflict" in batch).toBe(false);
    expect(batch.roomId).toBe("r-c2");
  });
});

describe("[SR-U5c] varias sesiones con la sala ocupada (SR-D7)", () => {
  const d = (status: string, roomBusy?: boolean) => ({
    iso: "2026-10-06T13:00:00.000Z",
    status,
    outOfHours: false,
    blocked: false,
    ...(roomBusy === undefined ? {} : { roomBusy }),
  });

  it("sin roomBusy en ninguna fecha: conteos y prompt como antes", () => {
    const plan = { free: 3, conflicted: 0, duplicates: 0, dates: [d("libre"), d("libre"), d("libre")] };
    expect(batchNeedsPrompt(plan)).toBe(false);
    expect(batchCreatableCounts(plan, false)).toEqual({ all: 3, freeOnly: 3 });
    expect(batchRoomBusyCounts(plan).total).toBe(0);
  });

  it("una fecha libre con la sala ocupada pregunta y, sin forzar, se omite", () => {
    const plan = {
      free: 3,
      conflicted: 1,
      duplicates: 1,
      dates: [d("libre"), d("libre", true), d("libre"), d("sobreturno", true), d("duplicado", true)],
    };
    expect(batchNeedsPrompt({ ...plan, conflicted: 0, duplicates: 0 })).toBe(true);
    expect(batchRoomBusyCounts(plan)).toEqual({ total: 2, free: 1, conflicted: 1 });
    expect(batchCreatableCounts(plan, false)).toEqual({ all: 2, freeOnly: 2 });
    expect(batchCreatableCounts(plan, true)).toEqual({ all: 4, freeOnly: 3 });
  });

  it("batchRunInput: allowRoomConflict solo viaja en true", () => {
    const base = { serviceId: "s", practitionerId: "p", scheduledFor: "x", count: 2 };
    expect(batchRunInput(base, { allowOverbooking: false })).toEqual({ ...base, allowOverbooking: false });
    expect(batchRunInput(base, { allowOverbooking: true, allowRoomConflict: false })).toEqual({
      ...base,
      allowOverbooking: true,
    });
    expect(batchRunInput(base, { allowOverbooking: false, allowRoomConflict: true })).toEqual({
      ...base,
      allowOverbooking: false,
      allowRoomConflict: true,
    });
  });
});
