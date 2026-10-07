"use client";

/**
 * Puerta Diagnóstico → editor de planes (S23, ES3 P3.2 · C10).
 *
 * Antes este archivo era un modal propio (`AssignPlanModal`) que armaba el
 * plan a mano y llamaba a el alta legacy de Diagnóstico: sesiones fuera
 * del motor (sin disponibilidad, sin conflictos, sin turnos), su propio picker
 * de días y su propio buscador de pacientes. Ahora "Asignar plan" (escritorio)
 * y el wizard (mobile) abren el editor ÚNICO (`PlanEditorDrawer`, S18) en modo
 * `create` con `diagnosis`:
 *   - el editor pide el prefill (`getDiagnosisPlanPrefill`: disciplina Kine,
 *     título, cantidad y ejercicios con su fase y dosis);
 *   - previsualiza con `previewPlan(plan)` y commitea con
 *     `createPlanFromDiagnosis({plan, diagnosis})`: caso clínico + plan +
 *     sesiones (rampa por fase en el server) + turnos, en una tx del motor.
 *
 * El editor se carga lazy (`next/dynamic`, sin SSR): el bundle de
 * `/diagnostico` no carga el editor hasta el primer click (y deja de cargar
 * framer-motion + SortableList del modal viejo).
 *
 * Deep-link C10 `/diagnostico?patientId=&bookingId=` (`parseDiagnosisDeepLink`):
 * con paciente, el editor arranca con ese paciente y, si vino un turno, con
 * `fromBookingId` (el turno cuenta como la sesión 1). **Sin paciente en la URL
 * no se preselecciona nadie** (P0-S02u-diag: un click distraído le creaba el
 * plan, y le escribía la HC, al primero de la lista); el editor muestra
 * `PatientPicker requireFull`.
 *
 * Lo puro (pedido al editor, ids de ejercicios, contexto del deep-link) está
 * exportado para testearlo sin DOM (`tests/unit/render/diagnostico-door.test.tsx`).
 */
import { useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PlanEditorRequest, PlanEditorSaved } from "@/components/planes/plan-editor-types";
import type { CaseSelection, CatalogConditionDTO } from "@/lib/diagnosis-engine";

const PlanEditorDrawer = dynamic(
  () => import("@/components/planes/plan-editor-drawer").then((m) => m.PlanEditorDrawer),
  { ssr: false, loading: () => null }
);

// ─── Contexto del deep-link ─────────────────────────────────────────────────

export type DiagnosisDoorPatient = { id: string; name: string };

/**
 * Lo que la página resuelve en el server y le pasa a las dos pantallas
 * (escritorio y wizard). Lo arma `app/(app)/diagnostico/page.tsx` inline: un
 * helper exportado de este módulo "use client" no se puede llamar desde el
 * Server Component.
 *  - `patient`: el de `?patientId=` si existe en el consultorio; si no, null.
 *  - `bookingId`: solo con paciente (un turno suelto no dice para quién es).
 *  - `patientNotFound`: vino un `patientId` que no resolvió (borrado, de otro
 *    consultorio o mal copiado): se avisa en vez de ignorarlo en silencio.
 *  - `canAssign`: `plans.manage` + `clinical.read` (matriz E1; la Secretaria
 *    y Facturación exploran pero no arman planes). Solo esconde UI: el server
 *    rechaza igual (`assertPlanManageInTx`).
 */
export type DiagnosisDoor = {
  patient: DiagnosisDoorPatient | null;
  bookingId: string | null;
  patientNotFound: boolean;
  canAssign: boolean;
};

export const NO_DIAGNOSIS_DOOR: DiagnosisDoor = {
  patient: null,
  bookingId: null,
  patientNotFound: false,
  canAssign: true,
};

export const DIAGNOSIS_DOOR_COPY = {
  cannotAssign: "Podés explorar el diagnóstico, pero armar el plan le corresponde al profesional que atiende al paciente.",
  patientNotFound: "No encontramos el paciente del enlace. Elegilo cuando armes el plan.",
  changePatient: "Elegir otro paciente",
} as const;

// ─── Pedido al editor ───────────────────────────────────────────────────────

/** Ids sin repetir, en el orden en que vinieron (el orden manda dentro de cada fase de la rampa). */
function uniqueIds(ids: ReadonlyArray<string>): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

/**
 * Pedido al editor único (C10): `mode:'create'`, disciplina Kine (Diagnóstico
 * es de kinesiología: `DiagnosisPlanPrefill.discipline`), el caso clínico y,
 * del deep-link, paciente y turno. No manda fecha de inicio ni cantidad: los
 * pone el editor (hoy AR con `planEditorToday`, C11) y el prefill del server.
 *
 * `exerciseIds` vacío o ausente = el server sugiere los vínculos asignables
 * de la condición.
 */
export function buildDiagnosisEditorRequest(args: {
  conditionSlug: string;
  selection: CaseSelection;
  exerciseIds?: ReadonlyArray<string>;
  patientId?: string | null;
  bookingId?: string | null;
}): PlanEditorRequest {
  const ids = uniqueIds(args.exerciseIds ?? []);
  const patientId = args.patientId || null;
  return {
    mode: "create",
    discipline: "KINESIOLOGY",
    diagnosis: {
      conditionSlug: args.conditionSlug,
      selection: args.selection,
      ...(ids.length ? { exerciseIds: ids } : {}),
    },
    ...(patientId ? { patientId } : {}),
    ...(patientId && args.bookingId ? { fromBookingId: args.bookingId } : {}),
  };
}

/**
 * Escritorio: los ejercicios elegidos, primero los de la condición (en el
 * orden de `exercisesFor`: DIRECT → INDIRECT, fase, peso) y después los
 * agregados a mano desde el picker. El server les asigna la fase de su
 * vínculo con la condición (sin vínculo = activación).
 */
export function desktopDiagnosisExerciseIds(args: {
  conditionExerciseIds: ReadonlyArray<string>;
  extraExerciseIds: ReadonlyArray<string>;
  selectedExerciseIds: ReadonlyArray<string>;
}): string[] {
  const selected = new Set(args.selectedExerciseIds);
  return uniqueIds([...args.conditionExerciseIds, ...args.extraExerciseIds].filter((id) => selected.has(id)));
}

/**
 * Wizard mobile (no tiene paso de ejercicios): los DIRECT de la condición,
 * como antes. Sin ninguno → `undefined` y el server sugiere los asignables de
 * la condición (antes el wizard frenaba con "asignalo desde escritorio").
 */
export function wizardDiagnosisExerciseIds(
  exercises: ReadonlyArray<Pick<CatalogConditionDTO["exercises"][number], "exerciseId" | "relation">>
): string[] | undefined {
  const ids = uniqueIds(exercises.filter((e) => e.relation === "DIRECT").map((e) => e.exerciseId));
  return ids.length ? ids : undefined;
}

// ─── UI ─────────────────────────────────────────────────────────────────────

/**
 * Estado de la puerta: el último pedido queda montado con `open=false` al
 * cerrar, así el Drawer hace su salida y el dirty-guard del editor funciona
 * (desmontarlo de golpe se saltearía las dos cosas). El editor arma una
 * instancia nueva (estado e `idempotencyKey` nuevos) en cada apertura.
 */
export function useDiagnosisPlanDoor() {
  const [state, setState] = useState<{ request: PlanEditorRequest | null; open: boolean }>({
    request: null,
    open: false,
  });
  return {
    request: state.request,
    open: state.open,
    openEditor: (request: PlanEditorRequest) => setState({ request, open: true }),
    close: () => setState((s) => ({ ...s, open: false })),
  };
}

export function DiagnosisPlanDoor({
  request,
  open,
  onClose,
}: {
  request: PlanEditorRequest | null;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  if (!request) return null;
  const onSaved = async (saved: PlanEditorSaved) => {
    // Lazy: el armado de links trae zod y no hace falta hasta guardar.
    const { planDeepLinkHref } = await import("@/lib/plans-deeplink");
    const href =
      planDeepLinkHref({ kind: "program", patientId: saved.patientId, programId: saved.programId }) ??
      `/pacientes/${saved.patientId}`;
    router.push(href);
    router.refresh();
  };
  return <PlanEditorDrawer {...request} open={open} onClose={onClose} onSaved={(s) => void onSaved(s)} />;
}

/**
 * Para quién es el diagnóstico (deep-link) o por qué no se puede armar el
 * plan. Sin paciente ni avisos no renderiza nada.
 */
export function DiagnosisDoorBanner({
  door,
  compact = false,
  style,
}: {
  door: DiagnosisDoor;
  compact?: boolean;
  style?: CSSProperties;
}) {
  const notes: string[] = [];
  if (door.patientNotFound) notes.push(DIAGNOSIS_DOOR_COPY.patientNotFound);
  if (!door.canAssign) notes.push(DIAGNOSIS_DOOR_COPY.cannotAssign);
  if (!door.patient && notes.length === 0) return null;
  return (
    <div
      data-testid="diagnosis-door-banner"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: compact ? "10px 12px" : "10px 16px",
        borderRadius: 14,
        background: "rgba(255,255,255,0.7)",
        border: "1px solid rgba(15,30,51,0.06)",
        fontSize: 13,
        color: "var(--navy-700)",
        minWidth: 0,
        ...style,
      }}
    >
      {door.patient && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            Diagnóstico para <strong style={{ color: "var(--navy-900)" }}>{door.patient.name}</strong>
          </span>
          <Link href="/diagnostico" style={{ fontSize: 12, fontWeight: 600, color: "var(--sky-700)" }}>
            {DIAGNOSIS_DOOR_COPY.changePatient}
          </Link>
        </div>
      )}
      {notes.map((n) => (
        <p key={n} role="note" style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>
          {n}
        </p>
      ))}
    </div>
  );
}
