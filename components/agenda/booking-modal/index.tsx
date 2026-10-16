"use client";

/**
 * Modal (drawer) de TURNO NUEVO de la agenda. Solo alta: la edición de un
 * turno existente vive en `booking-drawer/` (A2b-S-ui borró la rama muerta
 * `mode="edit"` de este archivo, que ya nadie montaba y mandaba cambios de
 * estado sin optimistic lock).
 *
 * B1.5a partió el antiguo `booking-modal.tsx` en esta carpeta sin cambiar
 * comportamiento. B5.1 (MOD-core) lo convirtió en la herramienta diaria de la
 * Secretaria: selector de modo, servicios por profesional, duración del
 * profesional, sede/telemedicina, slot picker, varias sesiones con
 * frecuencia, bloquear horario y los prompts de bloqueado/fuera de horario.
 *
 * ── Contratos entre archivos ──
 *
 * - `index.tsx` (este): DUEÑO de todo el estado, del `<form>` y del submit.
 *   Es el único que llama a actions de ESCRITURA de turnos (`createPatient`
 *   → `createBooking` | `createBookingsBatch` dryRun → real →
 *   `setPatientDefaultCopago`). Una `idempotencyKey` por instancia del modal,
 *   compartida por el alta simple, el batch y todos los reintentos de los
 *   prompts. La lógica pura (payload, flags, modos, servicios por profesional,
 *   duración) está en `lib/booking-modal-state.ts` (unit).
 *   Las secciones de LECTURA llaman sus propias actions de disponibilidad
 *   (slot-picker → `listAvailableSlots`, schedule-section →
 *   `classifyBookingInstant`, sessions-mode → `previewRecurrence`,
 *   block-mode → `createTimeBlock`, que es su propio alta).
 * - Nombres de inputs que lee `submit` del FormData: `patientId`
 *   (PatientPicker), `newFirstName`, `newLastName`, `newDocumentId`,
 *   `newPhone` (patient-section), `scheduledFor` (hidden de schedule-section,
 *   "YYYY-MM-DDTHH:mm" de pared AR), `title`, `description`, `notes` (este
 *   archivo). Profesional, servicio, duración, sede, telemedicina y la serie
 *   salen del ESTADO (son controlados).
 * - Dirty-guard: `useFormDirty(formRef, extra)` toma la foto de los inputs con
 *   `name` del `<form>` + `extra`. Todo estado nuevo que el usuario pueda
 *   cambiar y que no viva en un input con `name` tiene que sumarse a `extra`.
 *   El modo "Bloquear horario" suma `blockDirty` (lo reporta BlockMode).
 * - `service-section.tsx`: Profesional + Servicio (controlados; servicios ya
 *   filtrados por profesional) + aviso "No atiende este servicio".
 * - `patient-section.tsx`: picker o alta inline («Nuevo paciente»).
 * - `billing-section.tsx` + `use-patient-billing.ts`: obra social + copago
 *   editable (preview; la precedencia real es del server, `lib/copago.ts`).
 * - `schedule-section.tsx` (B5.2): fecha/hora manual + duración + SlotPicker
 *   (prop `slotPicker`) + aviso en vivo (`classify`).
 * - `multi-section.tsx` + `sessions-mode.tsx` (B5.3): «Varias sesiones».
 * - `block-mode.tsx` (B5.4): «Bloquear horario», con sus propios botones.
 * - `telemedicine-section.tsx`: sede (>1 activa) + sala (SR-U5c, solo con
 *   salas) + telemedicina.
 * - `conflict-prompts.tsx`: prompts (las acciones de cada botón son de acá).
 * - `types.ts`: payloads y estados de prompts compartidos.
 *
 * Orden en el DOM (no cambiarlo sin QA): modo, profesional, servicio,
 * paciente, copago, título, fecha/duración (+ slots), varias sesiones,
 * sede/telemedicina, descripción, notas, error, prompts (batch → bloqueado →
 * fuera de horario → superposición → mismo día → sobreturno → sala), footer.
 *
 * SR-U5c (salas): props `rooms` (catálogo del bootstrap) y `defaultRoomId`
 * (click en una celda de "Por sala": id = esa sala, null = columna "Sin
 * sala"). Estado `roomChoice` ("" = según el horario → `roomId` no viaja;
 * "none" → null; id). Sin salas, el modal y el payload quedan idénticos.
 *
 * Handoff (B4.3, `agenda-client.tsx`): pasar `enabledServiceIds`
 * (`initialAvailability?.enabledServiceIds`), `locations`, `capabilities`
 * (array) y `viewerPractitionerId`. Todas opcionales: sin ellas el modal
 * muestra todos los servicios, no muestra sede ni el modo bloquear.
 */
import { useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { Skel } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { FormField } from "@/components/ui/form-field";
import styles from "./booking-modal.module.css";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { IconArrow } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { createBooking, createBookingsBatch } from "@/lib/bookings";
import { createPatient, setPatientDefaultCopago } from "@/lib/patients";
import { bookingFieldAccess } from "@/lib/booking-field-access";
import { capabilitySet } from "@/lib/agenda-client-state";
import { classifyBookingInstant } from "@/lib/availability-actions";
import { isoToARLocalInput, localToARIso, toARDateKey } from "@/lib/datetime-ar";
import type { Frequency } from "@/lib/availability/types";
import type { InstantCheck } from "@/lib/availability-actions-types";
import type { RoomOption } from "@/lib/rooms-types";
import { toBatchFields } from "@/lib/sessions-mode-state";
import { todayDayKey } from "@/lib/slot-picker-state";
import {
  availableModes,
  batchNeedsPrompt,
  batchRunInput,
  blockPermission,
  bookingModalModeLabel,
  buildBatchPayload,
  buildCreatePayload,
  coerceMode,
  displayDuration,
  effectiveLocationId,
  initialRoomChoice,
  isBatchSubmit,
  isServiceEnabledFor,
  reconcileRoomOnLocationChange,
  reconcileServiceOnPractitionerChange,
  roomBusyOf,
  roomPayloadValue,
  roomsForModal,
  servicesForPractitioner,
  submitLabel,
  telemedicineUrlError,
  withConfirmation,
  withNextFree,
  type BookingModalMode,
  type ModalLocation,
  type PromptConfirmation,
} from "@/lib/booking-modal-state";
import type { Props } from "../agenda-client";
import { Select } from "../controls";
import { ServiceSection, initialPractitionerId } from "./service-section";
import { PatientSection } from "./patient-section";
import { BillingSection } from "./billing-section";
import { ScheduleSection } from "./schedule-section";
import { SlotPicker } from "./slot-picker";
import { TelemedicineSection } from "./telemedicine-section";
import {
  BatchConflictPrompt,
  BlockedPrompt,
  ConflictPrompt,
  OutOfHoursPrompt,
  PatientOverlapPrompt,
  RoomBusyPrompt,
  focusRoomSelect,
  promptFocusTarget,
  SamePatientPrompt,
  type RoomBusyState,
} from "./conflict-prompts";
import { usePatientBilling } from "./use-patient-billing";
import type {
  BatchConflictState,
  BatchPayload,
  BlockedState,
  ConflictState,
  CreatePayload,
  OutOfHoursState,
  PatientOverlapState,
  PatientRef,
  SamePatientState,
} from "./types";

/** Campos del alta inline → nombre del input en este formulario (para `fieldErrors`). */
// [PF1.2 · C-PF2] «Varias sesiones» (con su preview por fecha) y «Bloquear horario» solo aparecen al cambiar de modo:
// van en chunks aparte para que abrir «Nuevo turno» (siempre en «Turno») no los espere. Se precargan al pasar el
// puntero o el foco por el selector de modo (`preloadModeChunks`), así el click no espera red. Skeleton con alto
// parecido al real para que el drawer no salte.
const loadMultiSection = () => import("./multi-section");
const loadBlockMode = () => import("./block-mode");
const MultiSection = dynamic(() => loadMultiSection().then((m) => m.MultiSection), {
  ssr: false,
  loading: () => <Skel h={180} r={12} />,
});
const BlockMode = dynamic(() => loadBlockMode().then((m) => m.BlockMode), {
  ssr: false,
  loading: () => <Skel h={220} r={12} />,
});
function preloadModeChunks() {
  void loadMultiSection();
  void loadBlockMode();
}

const INLINE_PATIENT_FIELDS = {
  firstName: "newFirstName",
  lastName: "newLastName",
  documentId: "newDocumentId",
  phone: "newPhone",
} as const;

/** Visual del input de duración SIN servicio elegido: nunca se manda (el
 *  payload solo lleva `durationMin` si el usuario la tocó). */
const NO_SERVICE_DURATION_PLACEHOLDER = 45;

/** Espera antes de preguntar la regla profesional × servicio (duración/habilitado). */
const RULE_PROBE_DEBOUNCE_MS = 200;

export function BookingModal({
  defaultISO,
  defaultPatientId,
  defaultPractitionerId,
  services,
  practitioners,
  patients,
  insurers,
  onClose,
  onSaved,
  enabledServiceIds,
  locations,
  capabilities,
  viewerPractitionerId,
  defaultLocationId,
  rooms,
  defaultRoomId,
}: {
  defaultISO?: string;
  defaultPatientId?: string | null;
  /** Filtro de profesional de la agenda, o el profesional del usuario. */
  defaultPractitionerId?: string | null;
  services: Props["services"];
  practitioners: Props["practitioners"];
  patients: Props["patients"];
  insurers: Props["insurers"];
  onClose: () => void;
  onSaved: () => void;
  /** B5.1: servicios habilitados por profesional (`AgendaAvailability.enabledServiceIds`). */
  enabledServiceIds?: Record<string, string[]> | null;
  /** B5.1: sedes activas (principal primero). El selector sale con >1. */
  locations?: ModalLocation[] | null;
  /** B5.1: capabilities del actor (`getCapabilities()` como array). Habilita «Bloquear horario». */
  capabilities?: readonly string[] | null;
  /** B5.1: profesional del usuario (para `agenda.manageOwnBlocks`). */
  viewerPractitionerId?: string | null;
  /** Handoff de B4.3: sede filtrada en la agenda → sede preelegida del turno.
   *  Solo si está entre las `locations` activas (una pref vieja con una sede
   *  archivada no debe terminar en "Sede inválida" al guardar). */
  defaultLocationId?: string | null;
  /** SR: salas activas del consultorio (`AgendaBootstrapProps.rooms`). Sin
   *  salas (o sin la prop) no aparece el select "Sala" ni viaja `roomId`. */
  rooms?: RoomOption[] | null;
  /** SR: sala de la celda clickeada en "Por sala" (null = columna "Sin
   *  sala"; ausente = según el horario del profesional). */
  defaultRoomId?: string | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  // EV1-C1: en Clínica general no hay diagnóstico; título/descripción del
  // turno se rotulan como motivo de consulta (mismo campo, mismo payload).
  const hasDiagnostico = useTenantModules().has("diagnostico");

  // ── Modo ───────────────────────────────────────────────────────────────────
  const perm = blockPermission(capabilities, viewerPractitionerId);
  const modes = availableModes(perm.canBlock);
  const [modeRaw, setMode] = useState<BookingModalMode>("single");
  const mode = coerceMode(modeRaw, perm.canBlock);
  // BlockMode avisa si tiene algo cargado (su estado es interno).
  const [blockDirty, setBlockDirty] = useState(false);

  // ── Prompts ────────────────────────────────────────────────────────────────
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  // Soft confirm when the patient already has a (non-overlapping) turno today.
  const [samePatient, setSamePatient] = useState<SamePatientState | null>(null);
  // Soft confirm when the new turno OVERLAPS one the patient already has.
  const [patientOverlap, setPatientOverlap] = useState<PatientOverlapState | null>(null);
  // Varias sesiones preflight: what the batch would do, awaiting the user's choice.
  const [batchConflict, setBatchConflict] = useState<BatchConflictState | null>(null);
  // B5.1: sobre un bloqueo de agenda / fuera de la franja del profesional.
  const [blockedPrompt, setBlockedPrompt] = useState<BlockedState | null>(null);
  const [outOfHoursPrompt, setOutOfHoursPrompt] = useState<OutOfHoursState | null>(null);
  // SR-U5c: la sala está llena o bloqueada (re-llamar con `allowRoomConflict`).
  const [roomBusyPrompt, setRoomBusyPrompt] = useState<RoomBusyState | null>(null);
  const clearPrompts = () => {
    setConflict(null);
    setSamePatient(null);
    setPatientOverlap(null);
    setBatchConflict(null);
    setBlockedPrompt(null);
    setOutOfHoursPrompt(null);
    setRoomBusyPrompt(null);
  };
  // Every prompt renders below the form fields inside a scrolling drawer, so
  // bring whichever one appears into view instead of leaving it off-screen.
  // PF1-Z-F1 (#1): el `nearest` lo dejaba DEBAJO del footer sticky (botones
  // del aviso no clickeables); ahora el Drawer reserva el alto del footer como
  // `scroll-padding-bottom` (`data-drawer-footer`) y el scroll lo respeta.
  // Además el foco va a la primaria del aviso: quien venía con teclado quedaba
  // en el submit, debajo. Se enfoca UNA vez por aviso y recién sin `pending`
  // (el aviso se pinta con la transición todavía viva y los botones disabled).
  const promptRef = useRef<HTMLDivElement | null>(null);
  const activePrompt =
    conflict ?? samePatient ?? patientOverlap ?? batchConflict ?? blockedPrompt ?? outOfHoursPrompt ?? roomBusyPrompt;
  const focusedPrompt = useRef<object | null>(null);
  useEffect(() => {
    if (activePrompt) {
      promptRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activePrompt]);
  useEffect(() => {
    if (!activePrompt || pending || focusedPrompt.current === activePrompt) return;
    const target = promptFocusTarget(promptRef.current);
    if (!target) return;
    focusedPrompt.current = activePrompt;
    target.focus({ preventScroll: true });
  }, [activePrompt, pending]);

  // Stable idempotency key for THIS create attempt (one per modal instance):
  // a double-submit / retry converges to one turno, while a deliberate new
  // turno opens a fresh modal → fresh key → its own row. Guards against the
  // duplicate/overwrite class of bug at the DB's @unique column.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  );

  // ── Varias sesiones (batch con frecuencia; NO un plan/TreatmentProgram) ──
  const [count, setCount] = useState(2);
  const [weekdays, setWeekdays] = useState<number[]>([]); // 0=Mon..6=Sun
  const [frequency, setFrequency] = useState<Frequency>("weekly");

  // ── Paciente ───────────────────────────────────────────────────────────────
  const [isGuest, setIsGuest] = useState(false);
  // Coverage (obra social) for the inline "Nuevo paciente" form.
  //   "particular"  → no obra social (default)
  //   "ins:<id>"    → a tenant Insurer row
  //   "other"       → free-form name typed by the kine
  const [newCoverage, setNewCoverage] = useState("particular");
  const [newOtherInsurer, setNewOtherInsurer] = useState("");
  // Alta inline de paciente (A2b-S-ui): la ficha creada se guarda acá y un
  // reintento del submit (p. ej. después de un sobreturno rechazado o de un
  // error de red al crear el turno) la REUSA en vez de llamar otra vez a
  // `createPatient`. Antes cada reintento creaba otra ficha o rebotaba por
  // DNI duplicado con la primera ya guardada.
  const [createdPatient, setCreatedPatient] = useState<PatientRef | null>(null);
  const [inlineErrors, setInlineErrors] = useState<Record<string, string>>({});

  // ── Profesional y servicio ─────────────────────────────────────────────────
  // Profesional por defecto (A2b-S-ui): filtro de la agenda → el del usuario →
  // el primero. Antes siempre era el primero de la lista y la secretaria que
  // estaba mirando la agenda de otro kine le cargaba el turno al equivocado.
  // IAM-4b: sin default válido y con varios profesionales, ninguno (obliga a
  // elegir; ver `initialPractitionerId`).
  const [practitionerId, setPractitionerId] = useState<string>(() =>
    initialPractitionerId(defaultPractitionerId, practitioners)
  );
  const [serviceId, setServiceId] = useState("");
  // Duración: `null` = la del profesional para el servicio (no se manda; el
  // server la resuelve, contrato post-B3.1). Un número = la tocó el usuario.
  // Antes se mandaba siempre lo que tuviera el input (45 fijo hasta elegir
  // servicio) y pisaba la duración propia del profesional.
  const [durationOverride, setDurationOverride] = useState<number | null>(null);

  // Paciente elegido + preview de cobro / copago editable (ver el hook).
  const {
    selectedPatient,
    billing,
    copagoInput,
    copagoEdited,
    copagoLoading,
    updateDefaultCopago,
    setUpdateDefaultCopago,
    onCopagoInput,
    fetchBilling,
    loadPatientBilling,
  } = usePatientBilling({ defaultPatientId, patients, isGuest, serviceId });

  const applyService = (id: string) => {
    setServiceId(id);
    // Elegir servicio vuelve a la duración por defecto (comportamiento de
    // siempre: "Osteopatía 60' tiene que poner 60").
    setDurationOverride(null);
    if (!isGuest && selectedPatient) fetchBilling(selectedPatient.id, id);
  };
  const onPractitionerChange = (id: string) => {
    setPractitionerId(id);
    const next = reconcileServiceOnPractitionerChange(serviceId, enabledServiceIds, id);
    if (next !== serviceId) applyService(next);
  };
  const visibleServices = useMemo(
    () => servicesForPractitioner(services, enabledServiceIds, practitionerId, serviceId),
    [services, enabledServiceIds, practitionerId, serviceId]
  );

  // ── Fecha/hora (controlada por schedule-section; acá el ISO para el resto) ─
  const [instantIso, setInstantIso] = useState<string | null>(() => {
    const local = defaultISO ? isoToARLocalInput(defaultISO) : "";
    return local ? localToARIso(local) : null;
  });
  const instantRef = useRef(instantIso);
  instantRef.current = instantIso;
  const [pickerDay, setPickerDay] = useState<string>(() =>
    instantIso ? toARDateKey(instantIso) : todayDayKey(new Date())
  );
  const onInstantChange = (iso: string | null) => {
    setInstantIso(iso);
    if (iso) setPickerDay(toARDateKey(iso));
  };
  const onSlotPicked = (iso: string, pid: string) => {
    setInstantIso(iso);
    if (pid && pid !== practitionerId) onPractitionerChange(pid);
  };

  // Regla profesional × servicio (duración propia y si lo atiende), con la
  // misma action que el aviso en vivo pero SIN `durationMin`: así responde la
  // duración del profesional. Secuencia: solo aplica la última respuesta.
  const [rule, setRule] = useState<{ key: string; durationMin: number; serviceEnabled: boolean } | null>(null);
  const ruleSeq = useRef(0);
  const ruleKey = practitionerId && serviceId ? `${practitionerId}|${serviceId}` : null;
  useEffect(() => {
    if (!ruleKey) return;
    const n = ++ruleSeq.current;
    const [pid, sid] = ruleKey.split("|");
    const t = setTimeout(() => {
      classifyBookingInstant({
        practitionerId: pid,
        serviceId: sid,
        scheduledFor: instantRef.current ?? new Date().toISOString(),
      })
        .then((r) => {
          if (n !== ruleSeq.current || !r.ok) return;
          setRule({ key: ruleKey, durationMin: r.data.durationMin, serviceEnabled: r.data.serviceEnabled });
        })
        .catch(() => {
          // Sin regla: queda la duración del servicio y el aviso del mapa.
        });
    }, RULE_PROBE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ruleKey]);
  const ruleHit = rule && rule.key === ruleKey ? rule : null;
  const serviceEnabled = ruleHit?.serviceEnabled ?? isServiceEnabledFor(enabledServiceIds, practitionerId, serviceId);
  const defaultDuration = displayDuration({
    serviceId,
    services,
    practitionerDurationMin: ruleHit?.durationMin ?? null,
  });
  const shownDuration = durationOverride ?? defaultDuration ?? NO_SERVICE_DURATION_PLACEHOLDER;

  // ── Sede y telemedicina ────────────────────────────────────────────────────
  // "" = según el horario del profesional.
  const [locationId, setLocationId] = useState(() =>
    defaultLocationId && (locations ?? []).some((l) => l.id === defaultLocationId) ? defaultLocationId : ""
  );
  // ── Sala (SR-U5c) ──────────────────────────────────────────────────────────
  // "" = según el horario del profesional (no viaja), "none" = Sin sala, id.
  const [roomChoice, setRoomChoice] = useState(() => initialRoomChoice(defaultRoomId, rooms));
  // Sala de la franja según el último chequeo en vivo (`InstantCheck.defaultRoomId`):
  // nombra la opción "Según el horario del profesional (Consultorio 2)" y
  // define la sede de las salas ofrecidas con sede "Según el horario".
  const [checkDefaultRoomId, setCheckDefaultRoomId] = useState<string | null | undefined>(undefined);
  const onInstantStatus = (c: InstantCheck | null) => {
    if (!c) return setCheckDefaultRoomId(undefined);
    // Ausente = el server no la calculó: se conserva la anterior.
    if (c.defaultRoomId !== undefined) setCheckDefaultRoomId(c.defaultRoomId);
  };
  const onLocationChange = (id: string) => {
    setLocationId(id);
    // Una sala de otra sede se limpia (vuelve a "según el horario").
    setRoomChoice((cur) => reconcileRoomOnLocationChange(cur, rooms, id));
  };
  const roomOptions = useMemo(
    () =>
      roomsForModal(rooms, {
        locationId,
        locations,
        defaultRoomId: checkDefaultRoomId,
        keepRoomId: roomChoice,
      }),
    [rooms, locationId, locations, checkDefaultRoomId, roomChoice]
  );
  const roomIdValue = roomPayloadValue(roomChoice, rooms);
  // Sede que viaja (y que miran el aviso en vivo y los slots): la elegida, o
  // la de la sala elegida con "Según el horario" (ver `effectiveLocationId`).
  const effLocationId = effectiveLocationId(locationId, roomChoice, rooms);

  const [isTelemedicine, setIsTelemedicine] = useState(false);
  const [telemedicineUrl, setTelemedicineUrl] = useState("");
  // El error del link se muestra recién después de intentar enviar (no mientras tipea).
  const [showUrlError, setShowUrlError] = useState(false);
  const urlError = isTelemedicine ? telemedicineUrlError(telemedicineUrl) : null;

  const patientRefId = isGuest ? createdPatient?.id ?? null : selectedPatient?.id ?? null;

  // P0-S07u (E1): campos de texto visibles en el alta. Misma regla que el server
  // (`bookingFieldAccess`: un campo se escribe si y solo si se puede leer):
  // sin `clinical.read` no hay título ni descripción, y las notas solo se
  // ocultan cuando hay paciente (elegido o «Nuevo paciente»: el turno va a
  // tener paciente igual), porque en ese turno la nota puede ser clínica. Se
  // pasa `access: "full"` porque el modal no conoce el nivel sobre el paciente
  // elegido: el server re-filtra con el real y saca lo que no corresponda.
  // Sin capabilities (no llegaron) falla cerrado: sin campos clínicos.
  const hasClinical = useMemo(() => capabilitySet(capabilities).has("clinical.read"), [capabilities]);
  const fieldAccess = bookingFieldAccess({
    clinical: hasClinical,
    access: "full",
    hasPatient: isGuest || !!selectedPatient,
  });
  const insurerForSlots = isGuest && newCoverage.startsWith("ins:") ? newCoverage.slice(4) : null;
  const practitionerLabels = useMemo(
    () => Object.fromEntries(practitioners.map((p) => [p.id, p.name])),
    [practitioners]
  );

  // Dirty-guard del drawer: la foto incluye los inputs con `name` + el estado
  // que vive fuera de ellos (modo, switches, días, obra social del alta inline…).
  const formRef = useRef<HTMLFormElement | null>(null);
  const { dirty, onFormInput } = useFormDirty(formRef, {
    mode,
    isGuest,
    count,
    weekdays: weekdays.join(","),
    frequency,
    newCoverage,
    newOtherInsurer,
    patient: selectedPatient?.id ?? null,
    practitionerId,
    serviceId,
    durationOverride,
    instantIso,
    locationId,
    roomChoice,
    isTelemedicine,
    telemedicineUrl,
    copagoEdited,
    updateDefaultCopago,
  });

  const changeMode = async (next: BookingModalMode) => {
    if (next === mode) return;
    if (mode === "block" && blockDirty) {
      const ok = await confirm({
        title: "¿Descartar el bloqueo?",
        message: "El bloqueo que estabas cargando todavía no se guardó.",
        confirmLabel: "Descartar",
        cancelLabel: "Seguir editando",
        tone: "danger",
      });
      if (!ok) return;
    }
    setBlockDirty(false);
    clearPrompts();
    setError(null);
    setMode(next);
  };

  /**
   * "Actualizar el copago del paciente" (prompt del CopagoRow): se aplica
   * después de crear el/los turno(s). Un fallo no deshace los turnos, pero se
   * avisa (antes se tragaba el error).
   */
  const applyDefaultCopago = async () => {
    if (!updateDefaultCopago || !selectedPatient || isGuest) return;
    const r = await setPatientDefaultCopago({ patientId: selectedPatient.id, copagoCents: copagoInput });
    if (!r.ok) {
      toast.error("El turno se creó, pero no pudimos actualizar el copago del paciente", {
        description: r.error,
      });
    }
  };

  const finalizeCreate = async (payload: CreatePayload) => {
    const result = await createBooking(payload);
    clearPrompts();
    if (!result.ok) {
      // Precedencia del server: bloqueado > fuera de horario > superposición
      // del paciente > mismo día > cupo. Cada prompt guarda el payload (con
      // los flags ya confirmados) para re-llamar sumando el suyo.
      if (result.blocked) {
        setBlockedPrompt({ ...result.blocked, payload });
        setError(null);
        return;
      }
      if (result.outOfHours) {
        setOutOfHoursPrompt({ ...result.outOfHours, payload });
        setError(null);
        return;
      }
      if (result.samePatientDay) {
        // Soft confirm: the patient already has another turno today (no
        // overlap). Ask before adding a second one; re-call on confirm.
        setSamePatient({
          count: result.samePatientDay.count,
          existingISO: result.samePatientDay.existingISO,
          payload,
        });
        setError(null);
        return;
      }
      if (result.patientOverlap) {
        // The new turno runs over one the patient already has. Confirmable —
        // two services in parallel is normal in kinesiología.
        setPatientOverlap({ existingISO: result.patientOverlap.existingISO, payload });
        setError(null);
        return;
      }
      if (result.conflict) {
        setConflict({
          practitionerName: result.conflict.practitionerName,
          nextFreeISO: result.conflict.nextFreeISO,
          payload,
        });
        setError(null);
        return;
      }
      // SR: la sala va ÚLTIMA (`FORCE_PROMPT_ORDER`): el server la chequea
      // después del cupo y del paciente.
      const roomBusy = roomBusyOf(result);
      if (roomBusy) {
        setRoomBusyPrompt({ ...roomBusy, payload });
        setError(null);
        return;
      }
      if (result.fieldErrors?.telemedicineUrl?.[0]) setShowUrlError(true);
      setError(result.error);
      toast.error("No pudimos crear el turno", { description: result.error });
      return;
    }
    // "Ambas opciones": the turno already carries its own copago override;
    // if the kine confirmed the prompt, also make it the patient's default.
    await applyDefaultCopago();
    toast.success("Turno creado");
    onSaved();
  };

  /** Execute the batch after the user picked what to do with the conflicts. */
  const runBatch = async (payload: BatchPayload, allowOverbooking: boolean, allowRoomConflict = false) => {
    // SR-D7: sin `allowRoomConflict`, las fechas con la sala ocupada se omiten.
    const r = await createBookingsBatch(batchRunInput(payload, { allowOverbooking, allowRoomConflict }));
    if (!r.ok) {
      setError(r.error);
      toast.error("No pudimos crear los turnos", { description: r.error });
      return;
    }
    const d = r.data;
    if (d.created > 0) await applyDefaultCopago();
    const parts = [`${d.created} de ${d.requested} turnos creados`];
    if (d.sobreturnos > 0) parts.push(`${d.sobreturnos} como sobreturno`);
    if (d.omitted > 0) parts.push(`${d.omitted} omitidos`);
    if (d.duplicates > 0) parts.push(`${d.duplicates} ya existían`);
    toast.success(d.created > 0 ? "Turnos creados" : "No se creó ningún turno", {
      description: parts.join(" · "),
    });
    setBatchConflict(null);
    onSaved();
  };

  const submit = (formData: FormData) => {
    if (mode === "block") return; // BlockMode tiene su propio botón (y no está en este form).
    setError(null);
    setInlineErrors({});
    clearPrompts();
    // IAM-4b: sin profesional elegido no se manda nada (y antes de crear la
    // ficha inline, que quedaría asignada a nadie). El select es `required`;
    // esto cubre el submit sin validación nativa.
    if (!practitionerId) {
      setError("Elegí el profesional del turno.");
      return;
    }
    // El link de telemedicina se valida ANTES de crear la ficha del paciente
    // inline: si no, un link mal escrito dejaba la ficha creada y el turno no.
    if (urlError) {
      setShowUrlError(true);
      setError(urlError);
      return;
    }
    start(async () => {
      let patientId = String(formData.get("patientId") ?? "") || undefined;

      // "Nuevo paciente" switch: register the patient first, then book
      // the turno against the freshly-created id. Every booking links a
      // real Patient.
      if (isGuest) {
        if (createdPatient) {
          // Reintento: la ficha ya existe (ver `createdPatient`).
          patientId = createdPatient.id;
        } else {
          const firstName = String(formData.get("newFirstName") ?? "").trim();
          const lastName = String(formData.get("newLastName") ?? "").trim();
          const documentId = String(formData.get("newDocumentId") ?? "").trim();
          if (!firstName || !lastName) {
            setError("Cargá nombre y apellido del nuevo paciente.");
            return;
          }
          if (documentId.length < 4) {
            setInlineErrors({ newDocumentId: "Mínimo 4 caracteres." });
            setError("El DNI es obligatorio (mín. 4 caracteres).");
            return;
          }
          const created = await createPatient({
            firstName,
            lastName,
            documentId,
            phone: String(formData.get("newPhone") ?? "").trim() || undefined,
            // Obra social chosen in the inline form. "particular" → no
            // coverage; "ins:<id>" → tenant insurer; "other" → free-form.
            insurerId: newCoverage.startsWith("ins:") ? newCoverage.slice(4) : undefined,
            insurerName: newCoverage === "other" ? newOtherInsurer.trim() || undefined : undefined,
          },
          // P0-S07sp: el paciente queda a cargo del profesional del turno.
          // Sin clinical.read es obligatorio (antes quedaba asignado a la
          // Secretaria, con full, y el kine en básico); a un PRACTITIONER el
          // server se lo ignora y OWNER/ADMIN lo asignan al del turno.
          practitionerId ? { assignTo: practitionerId } : undefined);
          if (!created.ok) {
            // `fieldErrors` de zod al lado de cada campo.
            const fe: Record<string, string> = {};
            for (const [k, msgs] of Object.entries(created.fieldErrors ?? {})) {
              const input = INLINE_PATIENT_FIELDS[k as keyof typeof INLINE_PATIENT_FIELDS];
              if (input && msgs?.[0]) fe[input] = msgs[0];
            }
            setInlineErrors(fe);
            setError(created.error);
            return;
          }
          setCreatedPatient({ id: created.data.id, name: `${firstName} ${lastName}` });
          patientId = created.data.id;
        }
      }

      if (!patientId) {
        setError("Elegí un paciente o activá «Nuevo paciente» para registrarlo.");
        return;
      }

      const payload: CreatePayload = buildCreatePayload({
        patientId,
        idempotencyKey,
        serviceId,
        practitionerId,
        // AR-tagged: prevents the +3h shift to UTC on the server.
        scheduledFor: localToARIso(String(formData.get("scheduledFor") ?? "")),
        durationMin: durationOverride,
        durationEdited: durationOverride !== null,
        // Mini-diagnóstico opcional. Vacío → undefined, y el server toma
        // el diagnóstico del paciente (alta simple y batch). Un campo oculto
        // (P0-S07u, `fieldAccess`) no está en el FormData → "" → no viaja.
        title: String(formData.get("title") ?? ""),
        description: String(formData.get("description") ?? ""),
        notes: String(formData.get("notes") ?? ""),
        // Per-turno copago override — only when the kine actually changed
        // it from the patient's pre-established value.
        copago: !isGuest && billing ? { inputCents: copagoInput, suggestedCents: billing.copagoCents } : null,
        locationId: effLocationId,
        roomId: roomIdValue,
        isTelemedicine,
        telemedicineUrl,
      });

      // Varias sesiones: preflight first so the user is TOLD about conflicts
      // (sobreturno, bloqueado, fuera de horario, duplicado) and chooses what
      // to do, instead of slots being dropped silently.
      if (isBatchSubmit(mode, count)) {
        const batchPayload: BatchPayload = buildBatchPayload(
          payload,
          toBatchFields({ count, daysOfWeek: weekdays, frequency })
        );
        const preview = await createBookingsBatch({ ...batchPayload, dryRun: true });
        if (!preview.ok) {
          setError(preview.error);
          toast.error("No pudimos crear los turnos", { description: preview.error });
          return;
        }
        const p = preview.data;
        // SR-D7: una fecha con la sala ocupada también pregunta (sin forzar se omite).
        const needsPrompt = batchNeedsPrompt(p);
        // Nothing in the way → just create.
        if (!needsPrompt) {
          await runBatch(batchPayload, false);
          return;
        }
        setBatchConflict({ plan: p, payload: batchPayload });
        setError(null);
        return;
      }
      await finalizeCreate(payload);
    });
  };

  /** Re-llamar con la confirmación del prompt sumada a las anteriores. */
  const confirmWith = (payload: CreatePayload | undefined, kind: PromptConfirmation) => {
    if (!payload) return;
    start(async () => {
      await finalizeCreate(withConfirmation(payload, kind));
    });
  };

  /** "Usar próximo libre": mismo turno en el instante sugerido, confirmaciones de cero. */
  const applyNextFree = (payload: CreatePayload | undefined, iso: string | null | undefined) => {
    if (!payload || !iso) return;
    // El formulario muestra el instante nuevo (y un reintento manual lo usa).
    onInstantChange(iso);
    start(async () => {
      await finalizeCreate(withNextFree(payload, iso));
    });
  };

  const blockPractitionerId = perm.onlyPractitionerId ?? practitionerId;
  // Fijo por instancia: un `new Date()` por render cambiaría la `key` de
  // BlockMode en cada render y lo remontaría (perdiendo lo cargado).
  const [openedAtIso] = useState(() => new Date().toISOString());
  const blockStartIso = instantIso ?? (defaultISO || openedAtIso);

  return (
    <Drawer
      open={true}
      onClose={onClose}
      title={mode === "block" ? "Bloquear horario" : "Nuevo turno"}
      // Wide enough that the form doesn't scroll sideways AND the
      // sobreturno / mismo-día prompts land above the fold.
      width={580}
      dirty={dirty || (mode === "block" && blockDirty)}
      dirtyMessage={
        mode === "block"
          ? "El bloqueo todavía no se guardó. Si cerrás, se pierde lo que cargaste."
          : createdPatient
            ? `La ficha de ${createdPatient.name} ya quedó creada, pero el turno todavía no. Si cerrás, se pierde lo que cargaste del turno.`
            : "El turno todavía no se creó. Si cerrás, se pierde lo que cargaste."
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <ModeSelector modes={modes} value={mode} onChange={changeMode} disabled={pending} />

        {mode === "block" && (
          <div style={{ display: "grid", gap: 10 }}>
            {perm.onlyPractitionerId ? (
              <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                Bloqueás tu agenda:{" "}
                <strong style={{ color: "var(--navy-900)" }}>
                  {practitionerLabels[perm.onlyPractitionerId] ?? "tu agenda"}
                </strong>
              </div>
            ) : (
              <Select
                label="Profesional"
                name="blockPractitionerId"
                value={practitionerId}
                onChange={onPractitionerChange}
              >
                {/* IAM-4b: sin elegir (Secretaria sin filtro), placeholder en vez de mostrar el primero. */}
                {practitionerId === "" && (
                  <option value="" disabled>
                    — Elegí un profesional —
                  </option>
                )}
                {practitioners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
            <BlockMode
              key={blockStartIso + blockPractitionerId}
              practitionerId={blockPractitionerId}
              startIso={blockStartIso}
              canBlockAll={perm.canBlockAll}
              onDone={onSaved}
              onCancel={onClose}
              onDirtyChange={setBlockDirty}
            />
          </div>
        )}

        {/* El form queda montado (oculto) en el modo bloquear: volver a
            «Turno» no pierde lo cargado. */}
        <form
          ref={formRef}
          action={submit}
          onInput={onFormInput}
          onChange={onFormInput}
          style={{ display: mode === "block" ? "none" : "grid", gap: 10 }}
          aria-hidden={mode === "block" ? true : undefined}
        >
          <ServiceSection
            practitioners={practitioners}
            practitionerId={practitionerId}
            onPractitionerChange={onPractitionerChange}
            services={visibleServices}
            serviceId={serviceId}
            onServiceChange={applyService}
            serviceEnabled={serviceEnabled}
            durationHint={ruleHit?.durationMin ?? null}
          />
          {/* Patient / Guest selector */}
          <PatientSection
            isGuest={isGuest}
            onToggleGuest={() => setIsGuest((v) => !v)}
            createdPatient={createdPatient}
            inlineErrors={inlineErrors}
            insurers={insurers}
            newCoverage={newCoverage}
            onNewCoverageChange={setNewCoverage}
            newOtherInsurer={newOtherInsurer}
            onNewOtherInsurerChange={setNewOtherInsurer}
            selectedPatient={selectedPatient}
            patients={patients}
            onPatientChange={loadPatientBilling}
          />

          {/* Cobertura + copago del paciente seleccionado (editable). */}
          <BillingSection
            isGuest={isGuest}
            hasPatient={!!selectedPatient}
            billing={billing}
            copagoLoading={copagoLoading}
            copagoInput={copagoInput}
            onCopagoInput={onCopagoInput}
            updateDefaultCopago={updateDefaultCopago}
            setUpdateDefaultCopago={setUpdateDefaultCopago}
            serviceId={serviceId}
          />

          <ScheduleSection
            defaultISO={defaultISO}
            durationMin={shownDuration}
            onDurationMinChange={setDurationOverride}
            value={instantIso}
            onInstantChange={onInstantChange}
            classify={{
              practitionerId: practitionerId || null,
              serviceId: serviceId || null,
              patientId: patientRefId,
              locationId: effLocationId || null,
              roomId: roomIdValue,
            }}
            onInstantStatus={onInstantStatus}
            // En «Bloquear horario» el form queda oculto: no pedir slots.
            slotPicker={
              mode === "block" ? null : serviceId && practitionerId ? (
                <SlotPicker
                  practitionerId={practitionerId}
                  serviceId={serviceId}
                  dayKey={pickerDay}
                  onDayChange={setPickerDay}
                  locationId={effLocationId || null}
                  patientId={patientRefId}
                  insurerId={insurerForSlots}
                  durationMin={durationOverride ?? undefined}
                  value={instantIso}
                  onChange={onSlotPicked}
                  practitionerLabels={practitionerLabels}
                />
              ) : null
              // G6: la ayuda «Elegí el servicio para ver los horarios libres» vive debajo del selector de
              // servicio (`ServiceSection`), no acá: quedaba lejos del control que la resuelve.
            }
          />

          {mode === "sessions" && (
            <MultiSection
              hideToggle
              multiTurno
              onMultiTurnoChange={(on) => {
                if (!on) void changeMode("single");
              }}
              count={count}
              onCountChange={setCount}
              weekdays={weekdays}
              onWeekdaysChange={setWeekdays}
              frequency={frequency}
              onFrequencyChange={setFrequency}
              anchorIso={instantIso ?? ""}
              practitionerId={practitionerId}
              serviceId={serviceId || null}
              patientId={patientRefId}
              durationMin={durationOverride}
              locationId={effLocationId || null}
              // S18b: "Crealo como plan…" exige `plans.manage` (falla cerrado sin
              // capabilities) y un paciente ya guardado (el alta inline no tiene
              // ficha hasta crear el turno).
              capabilities={capabilities}
              patientUnsaved={isGuest && !createdPatient}
            />
          )}

          <TelemedicineSection
            locations={locations}
            locationId={locationId}
            onLocationChange={onLocationChange}
            rooms={rooms}
            roomOptions={roomOptions}
            roomChoice={roomChoice}
            onRoomChange={setRoomChoice}
            defaultRoomId={checkDefaultRoomId}
            isTelemedicine={isTelemedicine}
            onTelemedicineChange={setIsTelemedicine}
            telemedicineUrl={telemedicineUrl}
            onTelemedicineUrlChange={setTelemedicineUrl}
            urlError={showUrlError ? urlError : null}
          />

          {/* G6 (VX0-b): «Detalles» colapsable al final. Son opcionales (el server completa título y descripción con
              el diagnóstico del paciente si quedan vacíos) y ocupaban el primer pliegue entre Paciente y Fecha. Un
              `<details>` cerrado sigue enviando sus campos con el form; ninguno es `required`. Placeholders
              distintos: antes título y descripción repetían el mismo texto. */}
          {(fieldAccess.title === "rw" || fieldAccess.description === "rw" || fieldAccess.notes === "rw") && (
            <details className={styles.details}>
              <summary className={styles.detailsSummary}>
                Detalles <span className={styles.detailsHint}>· opcional</span>
              </summary>
              <div className={styles.detailsBody}>
                {fieldAccess.title === "rw" && (
                  <FormField
                    label={hasDiagnostico ? "Título (diagnóstico)" : "Motivo de consulta"}
                    name="title"
                    placeholder={hasDiagnostico ? "Vacío = el diagnóstico del paciente" : "Opcional"}
                  />
                )}
                {fieldAccess.description === "rw" && (
                  <FormField
                    as="textarea"
                    label={hasDiagnostico ? "Descripción (diagnóstico)" : "Detalle"}
                    name="description"
                    placeholder={hasDiagnostico ? "Vacío = la descripción del diagnóstico del paciente" : "Opcional"}
                  />
                )}
                {fieldAccess.notes === "rw" && <FormField as="textarea" label="Notas" name="notes" />}
              </div>
            </details>
          )}
          {error && (
            <div
              style={{
                padding: 10,
                borderRadius: 10,
                background: "var(--danger-bg)",
                color: "var(--danger-fg)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
          {batchConflict && (
            <BatchConflictPrompt
              promptRef={promptRef}
              batchConflict={batchConflict}
              pending={pending}
              onCreateAll={(forceRoom) => start(async () => { await runBatch(batchConflict.payload, true, forceRoom); })}
              onCreateFreeOnly={(forceRoom) => start(async () => { await runBatch(batchConflict.payload, false, forceRoom); })}
              onBack={() => setBatchConflict(null)}
            />
          )}
          {blockedPrompt && (
            <BlockedPrompt
              promptRef={promptRef}
              blocked={blockedPrompt}
              pending={pending}
              onForce={() => confirmWith(blockedPrompt.payload, "blocked")}
              onUseSuggestedSlot={() => applyNextFree(blockedPrompt.payload, blockedPrompt.nextFreeISO)}
              onBack={() => setBlockedPrompt(null)}
            />
          )}
          {outOfHoursPrompt && (
            <OutOfHoursPrompt
              promptRef={promptRef}
              outOfHours={outOfHoursPrompt}
              pending={pending}
              onForce={() => confirmWith(outOfHoursPrompt.payload, "outOfHours")}
              onUseSuggestedSlot={() => applyNextFree(outOfHoursPrompt.payload, outOfHoursPrompt.nextFreeISO)}
              onBack={() => setOutOfHoursPrompt(null)}
            />
          )}
          {patientOverlap && (
            <PatientOverlapPrompt
              promptRef={promptRef}
              patientOverlap={patientOverlap}
              pending={pending}
              // Confirming the overlap implies the weaker same-day confirmation
              // too, so the user isn't asked twice for the same turno.
              onConfirm={() => confirmWith(patientOverlap.payload, "patientOverlap")}
              onCancel={() => setPatientOverlap(null)}
            />
          )}
          {samePatient && (
            <SamePatientPrompt
              promptRef={promptRef}
              samePatient={samePatient}
              pending={pending}
              onConfirm={() => confirmWith(samePatient.payload, "samePatientDay")}
              onCancel={() => setSamePatient(null)}
            />
          )}
          {conflict && (
            <ConflictPrompt
              promptRef={promptRef}
              conflict={conflict}
              pending={pending}
              onUseSuggestedSlot={() => applyNextFree(conflict.payload, conflict.nextFreeISO)}
              onForceOverbooking={() => confirmWith(conflict.payload, "overbooking")}
              onBack={() => setConflict(null)}
            />
          )}
          {roomBusyPrompt && (
            <RoomBusyPrompt
              promptRef={promptRef}
              roomBusy={roomBusyPrompt}
              pending={pending}
              onForce={() => confirmWith(roomBusyPrompt.payload, "roomConflict")}
              onBack={() => {
                setRoomBusyPrompt(null);
                focusRoomSelect(formRef.current);
              }}
            />
          )}
          {/* Footer apilado, full-width y pegado al pie (G7): una sola primaria. */}
          <div className={styles.footer} data-drawer-footer="">
            <Button
              type="submit"
              variant="primary"
              disabled={pending}
              style={{ justifyContent: "center" }}
            >
              {submitLabel(mode, count, pending)} <IconArrow size={12} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
              style={{ justifyContent: "center" }}
            >
              Cancelar
            </Button>
          </div>
        </form>
      </div>
    </Drawer>
  );
}

/**
 * «Turno · Varias sesiones · Bloquear horario». Radiogroup con el mismo look
 * de pastilla que el selector de la agenda (sin animación: el estado activo
 * se lee por color, `aria-checked` y texto en blanco).
 */
function ModeSelector({
  modes,
  value,
  onChange,
  disabled,
}: {
  modes: BookingModalMode[];
  value: BookingModalMode;
  onChange: (m: BookingModalMode) => void;
  disabled?: boolean;
}) {
  const modules = useTenantModules();
  const btn = (on: boolean): CSSProperties => ({
    flex: 1,
    height: 32,
    padding: "0 10px",
    borderRadius: 999,
    border: "none",
    fontSize: 12.5,
    fontWeight: 600,
    background: on ? "var(--navy-900)" : "transparent",
    color: on ? "#fff" : "var(--navy-500)",
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  });
  return (
    <div
      role="radiogroup"
      aria-label="Qué querés cargar"
      className="k-glass"
      style={{ display: "flex", borderRadius: 999, padding: 3, gap: 2 }}
      onPointerEnter={preloadModeChunks}
      onFocus={preloadModeChunks}
    >
      {modes.map((m) => {
        const on = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            data-mode={m}
            onClick={() => onChange(m)}
            onKeyDown={(e) => {
              // Radiogroup: las flechas cambian la opción (patrón WAI-ARIA).
              const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!delta) return;
              e.preventDefault();
              const next = modes[(modes.indexOf(value) + delta + modes.length) % modes.length];
              onChange(next);
              const group = e.currentTarget.parentElement;
              requestAnimationFrame(() => group?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus());
            }}
            style={btn(on)}
          >
            {bookingModalModeLabel(m, modules.has)}
          </button>
        );
      })}
    </div>
  );
}
