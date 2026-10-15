"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { getPatientBookingsAll } from "@/lib/patients";
import { getPatientPlanBalances, getPatientPlans } from "@/lib/plans-read";
import { getPatientClinicalSummary } from "@/lib/clinical-notes-read";
import type { PatientClinicalSummary } from "@/lib/clinical-notes-types";
import type { DeepLinkBooking } from "@/components/patients/profile/views/evoluciones-view";
import type {
  PatientCore,
  PatientAdminCore,
  PatientBookingSummary,
  PatientBookingFull,
} from "@/lib/patients-types";
import type { PatientPlanBalances, PlanDTO } from "@/lib/plans-read-types";
import type { Capability } from "@/lib/capabilities";
import type { Role } from "@prisma/client";
import { formatARS } from "@/lib/format";
import { isProfileTabAllowed, type TenantModule } from "@/lib/tenant-modules";
import { PLANS_TAB, normalizeProfileTab, stripPlanIntentParams, type ProfilePlanIntent } from "@/lib/plans-deeplink";
import type { EvaScore } from "@prisma/client";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { useToast } from "@/components/ui/toast";
import { PatientHero, PatientAdminHero } from "@/components/patients/profile/hero";
import { TabsBar } from "@/components/patients/profile/tabs-bar";
import { ResumenView } from "@/components/patients/profile/views/resumen-view";
import { TurnosView } from "@/components/patients/profile/views/turnos-view";
import {
  heroPlanChips,
  planUiPermissions,
  type PlanEditorRequest,
  type PlanEditorSaved,
} from "@/components/planes/plan-editor-types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Detail, Grid2, Section } from "@/components/patients/profile/ui";
import {
  PROFILE_TABS,
  type InsurerOption,
  type PatientWithRelations,
  type PractitionerOption,
  type Tab,
} from "@/components/patients/profile/types";

/**
 * S22b: el editor único de Planes (C10) se monta UNA vez en el shell y se
 * carga recién cuando alguien lo pide (`next/dynamic`, sin SSR): son ~1.300
 * líneas (form, horario, tabla de preview) que la mayoría de las visitas a una
 * ficha no usa. Las superficies (PlanCard, Sesiones, Resumen, hero) solo piden
 * abrirlo con `onOpenEditor(PlanEditorRequest)`.
 */
const PlanEditorDrawer = dynamic(
  () => import("@/components/planes/plan-editor-drawer").then((m) => m.PlanEditorDrawer),
  { ssr: false, loading: () => null }
);

/**
 * P3.Z (gate de bundle de ES3): las pestañas que no se ven al abrir la ficha
 * van lazy. La PlanCard arrastra los diálogos de edición y la tabla de preview
 * (plata, cantidad, renovación) y `/pacientes/[id]` pasó de 194 a 241 kB gz
 * con todo eager; Resumen y Turnos (las de entrada) siguen estáticas.
 */
function TabLoading() {
  return <div aria-busy="true" style={{ minHeight: 120 }} />;
}
const ActivityView = dynamic(() => import("@/components/patients/activity-view").then((m) => m.ActivityView), { loading: TabLoading });
const ArchivosView = dynamic(() => import("@/components/patients/archivos-view").then((m) => m.ArchivosView), { loading: TabLoading });
const SesionesView = dynamic(() => import("@/components/patients/profile/views/sesiones-view").then((m) => m.SesionesView), { loading: TabLoading });
const PlanView = dynamic(() => import("@/components/patients/profile/views/plan-view").then((m) => m.PlanView), { loading: TabLoading });
const AntecedentesView = dynamic(() => import("@/components/patients/profile/views/antecedentes-view").then((m) => m.AntecedentesView), { loading: TabLoading });
const EvolucionesView = dynamic(() => import("@/components/patients/profile/views/evoluciones-view").then((m) => m.EvolucionesView), { loading: TabLoading });
const EvolucionView = dynamic(() => import("@/components/patients/profile/views/evolucion-view").then((m) => m.EvolucionView), { loading: TabLoading });
const FacturacionView = dynamic(() => import("@/components/patients/profile/views/facturacion-view").then((m) => m.FacturacionView), { loading: TabLoading });

/** Tamaño de página de turnos del perfil (Turnos + Facturación). */
const BOOKINGS_PAGE = 100;

/** Copy del deep-link (C10): prefill roto/viejo y "nuevo" sin permiso. */
export const PROFILE_PLAN_COPY = {
  prefillInvalid: "El link traía datos del plan que ya no son válidos: completalos en el editor.",
  cannotCreate: "No tenés permiso para crear planes para este paciente.",
  plansUnavailable: "Los planes de tratamiento no están disponibles para tu tipo de consultorio.",
  loadFailed: "No pudimos cargar los planes. Probá de nuevo.",
} as const;

// ─── Helpers puros (testeados en tests/unit/render/patient-profile-plans) ────

/**
 * Pestañas del perfil completo que permite el consultorio (enmienda EV0 de
 * S22b: `isProfileTabAllowed` + rol). El rol ya se resolvió antes: el perfil
 * completo solo se monta con acceso `full`; la Secretaria/BILLING van a
 * `PatientAdminProfile` (Datos y Turnos).
 *
 * EV2-3a: «Evoluciones» exige además `clinical.read` del MIEMBRO (no del consultorio): un Titular sin agenda o un
 * Administrador/a pueden tener acceso `full` a la ficha y no tienen HC (PL-1, §20.17). Falla cerrado: sin el flag, no
 * está.
 */
export function profileTabsFor(
  modules: ReadonlySet<TenantModule>,
  opts: { clinicalRead?: boolean } = {}
): Tab[] {
  return PROFILE_TABS.filter(
    (t) => isProfileTabAllowed(t, modules) && (t !== "evoluciones" || opts.clinicalRead === true)
  );
}

/**
 * `?tab=` → pestaña inicial. Normaliza el alias (`plan` → `planes`) y cae a
 * Resumen si la pestaña no existe o el consultorio no la tiene (un link a
 * `?tab=planes` en un consultorio General no abre una pestaña oculta).
 */
export function resolveProfileTab(raw: string | null | undefined, allowed: readonly Tab[]): Tab {
  const t = normalizeProfileTab(raw);
  return t && (allowed as readonly string[]).includes(t) ? (t as Tab) : "resumen";
}

/**
 * Qué plan muestra Resumen cuando el paciente tiene varios (heredado de
 * P0-S02u-perfil, ahora sobre `PlanDTO`):
 *   - `focusPlan`: el ACTIVE más reciente por `createdAt` (no depende del orden
 *     en que llegue la lista); si no hay, el último plan (se muestra con su
 *     estado, nunca como vigente). Los archivados no cuentan.
 *   - `otherActiveCount`: los otros ACTIVE, para el "+N".
 *   - `sessionCount`: sesiones vivas (no archivadas) de los planes no
 *     archivados, el badge de la pestaña Sesiones.
 */
/**
 * ¿El paciente tiene obra social de verdad? (P3.Z, F2 H2.) Solo con una
 * cobertura vinculada al catálogo del consultorio y que no sea "Particular":
 * un nombre libre sin `insurerId` cobra como particular (ver `Coverage`).
 * La PlanCard lo usa para el "Sin autorización vigente" (falla cerrado).
 */
export function isInsured(
  coverage: { insurerId: string | null; insurerRef?: { isParticular: boolean } | null } | null | undefined
): boolean {
  return !!coverage?.insurerId && coverage.insurerRef?.isParticular !== true;
}

export function pickProfilePlans(plans: readonly PlanDTO[]) {
  const live = plans.filter((p) => p.archivedAt == null);
  const byRecent = [...live].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  const actives = byRecent.filter((p) => p.status === "ACTIVE");
  const focusPlan = actives[0] ?? byRecent[0] ?? null;
  const otherActiveCount = Math.max(actives.length - 1, 0);
  const sessionCount = live.reduce(
    (acc, p) => acc + p.sessions.filter((s) => s.state !== "archived").length,
    0
  );
  return { focusPlan, otherActiveCount, sessionCount, livePlanCount: live.length };
}

export type PatientProfileProps = {
  patientCore: PatientCore;
  recentBookings: PatientBookingSummary[];
  billableCount: number;
  /** `[]` sin el módulo `evaluaciones` (la página ni siquiera los pide). */
  evaScores: EvaScore[];
  insurers?: InsurerOption[];
  practitioners?: PractitionerOption[];
  canReassign?: boolean;
  /** Capabilities del actor (array: viaja de Server a Client Component). */
  capabilities?: readonly Capability[];
  role?: Role | null;
  /** `getPatientPlans({patientId})` (data) del server; `[]` sin el módulo `planes`. */
  initialPlans?: PlanDTO[];
  /** `getPatientPlanBalances` (data) del server; `null` sin el módulo o si falló. */
  initialPlanBalances?: PatientPlanBalances | null;
  /** Error de `getPatientPlans` en el server (se muestra en la pestaña). */
  initialPlansError?: string | null;
  /** `?tab=` crudo (la página lo parsea con `parseProfilePlanParams`). */
  initialTab?: string | null;
  /** Intención de Planes del deep-link (C10). Se consume una vez y se limpia la URL. */
  planIntent?: ProfilePlanIntent;
  /** EV2-3a: `getPatientClinicalSummary` (null sin módulo o sin `clinical.read`): contador y «Última evolución». */
  clinicalSummary?: PatientClinicalSummary | null;
  /** EV2-3a: `canWriteClinicalNotes(caps, "full", actor.practitionerId)`; solo esconde «Nueva evolución». */
  canWriteNotes?: boolean;
  /** EV2-3a: `?turno=` del deep link de evoluciones (`clinicalNoteDeepLink`) y el turno si es de este paciente. */
  noteBookingId?: string | null;
  noteBooking?: DeepLinkBooking | null;
};

export function PatientProfile({
  patientCore,
  recentBookings,
  billableCount,
  evaScores,
  insurers = [],
  practitioners = [],
  canReassign = false,
  capabilities = [],
  role = null,
  initialPlans = [],
  initialPlanBalances = null,
  initialPlansError = null,
  initialTab = null,
  planIntent = { kind: "none" },
  clinicalSummary = null,
  canWriteNotes = false,
  noteBookingId = null,
  noteBooking = null,
}: PatientProfileProps) {
  const modules = useTenantModules();
  const toast = useToast();
  const plansEnabled = modules.has("planes");
  const caps = useMemo(() => new Set<Capability>(capabilities), [capabilities]);
  const clinicalRead = caps.has("clinical.read");
  const allowedTabs = useMemo(
    () => profileTabsFor(modules.list, { clinicalRead }),
    [modules.list, clinicalRead]
  );
  const [tab, setTab] = useState<Tab>(() => resolveProfileTab(initialTab, allowedTabs));
  const notesEnabled = allowedTabs.includes("evoluciones");

  // ── Evoluciones (EV2-3a): resumen del server; se relee después de cada escritura de la pestaña ─────────────
  const [summary, setSummary] = useState<PatientClinicalSummary | null>(notesEnabled ? clinicalSummary : null);
  const summarySeq = useRef(0);
  const reloadSummary = useCallback(async () => {
    if (!notesEnabled) return;
    const seq = ++summarySeq.current;
    try {
      const r = await getPatientClinicalSummary(patientCore.id);
      if (seq === summarySeq.current) setSummary(r);
    } catch (e) {
      // Queda el resumen anterior: el contador puede atrasar uno hasta la próxima visita, nada más.
      console.error("getPatientClinicalSummary failed", e);
    }
  }, [notesEnabled, patientCore.id]);
  const openEvoluciones = useCallback(() => {
    if (notesEnabled) setTab("evoluciones");
  }, [notesEnabled]);

  // ── Permisos de Planes (solo esconden; la barrera es el server) ──────────
  const permissions = useMemo(
    () =>
      planUiPermissions({
        caps,
        // El perfil completo solo se monta con acceso `full` (page.tsx).
        access: "full",
        role,
        plansModule: plansEnabled,
        templatesModule: modules.has("plantillas"),
      }),
    [caps, role, plansEnabled, modules]
  );
  // H1 de S22f: el título del plan es HC → full + `clinical.read`.
  const showPlanTitles = caps.has("clinical.read");

  // ── Planes y saldos (S14). Sin el módulo no se piden ni se guardan. ──────
  const [plans, setPlans] = useState<PlanDTO[]>(plansEnabled ? initialPlans : []);
  const [planBalances, setPlanBalances] = useState<PatientPlanBalances | null>(
    plansEnabled ? initialPlanBalances : null
  );
  const [plansError, setPlansError] = useState<string | null>(plansEnabled ? initialPlansError : null);
  const [plansLoading, setPlansLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [focusProgramId, setFocusProgramId] = useState<string | null>(
    planIntent.kind === "program" ? planIntent.programId : null
  );
  // Una respuesta vieja (dos recargas seguidas, o el toggle de archivados) no
  // pisa a una más nueva.
  const plansSeq = useRef(0);
  const balancesSeq = useRef(0);

  const reloadBalances = useCallback(async () => {
    if (!plansEnabled) return;
    const seq = ++balancesSeq.current;
    try {
      const r = await getPatientPlanBalances({ patientId: patientCore.id });
      if (seq !== balancesSeq.current) return;
      // Si falla, queda el saldo anterior: Turnos/Facturación siguen sin agrupar mal.
      if (r.ok) setPlanBalances(r.data);
    } catch (e) {
      console.error("getPatientPlanBalances failed", e);
    }
  }, [plansEnabled, patientCore.id]);

  const reloadPlans = useCallback(
    async (opts: { includeArchived?: boolean } = {}) => {
      if (!plansEnabled) return;
      const includeArchived = opts.includeArchived ?? showArchived;
      const seq = ++plansSeq.current;
      setPlansLoading(true);
      try {
        const [r] = await Promise.all([
          getPatientPlans({ patientId: patientCore.id, includeArchived }),
          reloadBalances(),
        ]);
        if (seq !== plansSeq.current) return;
        if (r.ok) {
          setPlans(r.data);
          setPlansError(null);
        } else {
          setPlansError(r.error);
        }
      } catch (e) {
        console.error("getPatientPlans failed", e);
        if (seq === plansSeq.current) setPlansError(PROFILE_PLAN_COPY.loadFailed);
      } finally {
        if (seq === plansSeq.current) setPlansLoading(false);
      }
    },
    [plansEnabled, patientCore.id, showArchived, reloadBalances]
  );

  const onShowArchivedChange = useCallback(
    (show: boolean) => {
      setShowArchived(show);
      void reloadPlans({ includeArchived: show });
    },
    [reloadPlans]
  );

  // Lazy slice: the full bookings list is only needed for Turnos/Facturación.
  // While not loaded, `recentBookings` (5 rows) covers Resumen's "próxima
  // cita" card. The first time the user opens either tab we fetch the first
  // page and cache it in component state for the rest of the session.
  const [bookingsAll, setBookingsAll] = useState<PatientBookingFull[] | null>(null);
  const [loadingBookings, setLoadingBookings] = useState(false);
  // A2a-S08: el server pagina (`{ rows, hasMore, nextCursor }`). Antes la
  // lista se cortaba en 100 sin aviso y Facturación "perdía" turnos viejos.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  // Both the Facturación and Turnos tabs work off the same full bookings
  // list — fetched once on the first open of either, cached for the session.
  //
  // NOTE: `loadingBookings` is deliberately NOT a dependency. Setting it
  // inside the effect would re-run the effect, fire this cleanup
  // (`cancelled = true`) before the fetch resolves, and silently drop the
  // result → "Cargando" forever. We gate on `bookingsAll === null` instead.
  const needsBookings = tab === "fact" || tab === "turnos";
  useEffect(() => {
    if (!needsBookings || bookingsAll !== null) return;
    let cancelled = false;
    setLoadingBookings(true);
    getPatientBookingsAll(patientCore.id, BOOKINGS_PAGE)
      .then((page) => {
        if (cancelled) return;
        setBookingsAll(page.rows);
        setNextCursor(page.hasMore ? page.nextCursor : null);
      })
      .catch((e) => {
        console.error("getPatientBookingsAll failed", e);
        // Fall back to an empty list so the tab shows "sin turnos" instead
        // of hanging on the loading skeleton.
        if (!cancelled) setBookingsAll([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingBookings(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsBookings, bookingsAll, patientCore.id]);

  const loadMoreBookings = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await getPatientBookingsAll(patientCore.id, BOOKINGS_PAGE, nextCursor);
      // Dedupe por id: un patch optimista o un turno nuevo no duplica filas.
      setBookingsAll((prev) => {
        const seen = new Set((prev ?? []).map((b) => b.id));
        return [...(prev ?? []), ...page.rows.filter((b) => !seen.has(b.id))];
      });
      setNextCursor(page.hasMore ? page.nextCursor : null);
    } catch (e) {
      console.error("getPatientBookingsAll (más) failed", e);
      setMoreError("No pudimos cargar más turnos. Probá de nuevo.");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, patientCore.id]);

  // Optimistic in-place patch of a booking after a mutation (status change,
  // payment confirmation) so both tabs reflect it instantly without a refetch.
  const patchBooking = useCallback((id: string, partial: Partial<PatientBookingFull>) => {
    setBookingsAll((prev) => (prev ? prev.map((b) => (b.id === id ? { ...b, ...partial } : b)) : prev));
  }, []);
  const dropBooking = useCallback((id: string) => {
    setBookingsAll((prev) => (prev ? prev.filter((b) => b.id !== id) : prev));
  }, []);
  // Rollback del borrado optimista de TurnosView (el server lo rechazó: cobro
  // registrado, lock vencido). Se re-inserta en el orden del server
  // (`scheduledFor desc`): Turnos ordena al render, pero Facturación no.
  const restoreBooking = useCallback((row: PatientBookingFull) => {
    setBookingsAll((prev) => {
      if (!prev || prev.some((x) => x.id === row.id)) return prev;
      return [...prev, row].sort((a, b) => +new Date(b.scheduledFor) - +new Date(a.scheduledFor));
    });
  }, []);

  /**
   * Después de una escritura de Planes: recarga planes + saldos y descarta la
   * lista de turnos cacheada (crear, generar, mover o cancelar un plan crea y
   * cancela turnos); se vuelve a pedir la próxima vez que se abra Turnos o
   * Facturación.
   */
  const onPlansChanged = useCallback(() => {
    setBookingsAll(null);
    setNextCursor(null);
    void reloadPlans();
  }, [reloadPlans]);

  // ── Editor único (C10) ────────────────────────────────────────────────────
  const [editorReq, setEditorReq] = useState<PlanEditorRequest | null>(null);
  const openEditor = useCallback(
    (req: PlanEditorRequest) => {
      if (!plansEnabled) return;
      // Handoff S18: en `generate` va SIEMPRE el `patientId` (la Secretaria no
      // tiene `getPlanDetail` para deducirlo). En esta ficha todo pedido es de
      // este paciente, así que se completa en cualquier modo.
      setEditorReq({ ...req, patientId: req.patientId ?? patientCore.id });
    },
    [plansEnabled, patientCore.id]
  );
  const closeEditor = useCallback(() => setEditorReq(null), []);
  const onEditorSaved = useCallback(
    (saved: PlanEditorSaved) => {
      setEditorReq(null);
      setFocusProgramId(saved.programId);
      setTab(PLANS_TAB);
      onPlansChanged();
    },
    [onPlansChanged]
  );
  const openPlan = useCallback(
    (programId: string) => {
      if (!plansEnabled) return;
      setFocusProgramId(programId);
      setTab(PLANS_TAB);
    },
    [plansEnabled]
  );

  // ── Deep-link (C10): se consume UNA vez y se limpia la URL ────────────────
  // `?tab=planes&programa=` ya entró como `focusProgramId` inicial; `nuevo=1`
  // abre el editor. `stripPlanIntentParams` saca `programa/nuevo/turno/prefill`
  // (conserva `tab`) para que un refresh o "atrás" no lo vuelva a disparar
  // (mismo patrón que `/agenda?new=1`).
  const intentConsumed = useRef(false);
  useEffect(() => {
    if (intentConsumed.current) return;
    intentConsumed.current = true;
    if (planIntent.kind === "none") return;
    try {
      window.history.replaceState(window.history.state, "", stripPlanIntentParams(window.location.href));
    } catch {
      // Sin history (tests, navegadores raros): el intent igual se consume una vez.
    }
    if (!plansEnabled) {
      toast.info(PROFILE_PLAN_COPY.plansUnavailable);
      return;
    }
    if (planIntent.kind !== "new") return;
    if (planIntent.prefillInvalid) toast.warning(PROFILE_PLAN_COPY.prefillInvalid);
    if (!permissions.manage) {
      toast.error(PROFILE_PLAN_COPY.cannotCreate);
      return;
    }
    const prefill = planIntent.prefill ?? undefined;
    openEditor({
      mode: "create",
      patientId: patientCore.id,
      prefill,
      fromBookingId: planIntent.fromBookingId ?? prefill?.fromBookingId,
      templateId: prefill?.templateId,
      discipline: prefill?.discipline,
    });
    // Solo al montar: el intent es de la URL con la que se entró.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synthesize the composite shape used by sub-views. The `bookings` field
  // swaps between recent (initial) and full (after Turnos/Facturación opens).
  const patient: PatientWithRelations = useMemo(
    () => ({
      ...patientCore,
      bookings: bookingsAll ?? recentBookings,
      evaScores,
    }),
    [patientCore, bookingsAll, recentBookings, evaScores]
  );

  const { focusPlan, otherActiveCount, sessionCount, livePlanCount } = useMemo(
    () => pickProfilePlans(plans),
    [plans]
  );
  const heroChips = useMemo(() => (plansEnabled ? heroPlanChips(plans) : []), [plansEnabled, plans]);
  // `PlanDTO` no trae el caso clínico (lo traía `PatientProgramLite.case`): el
  // nombre del diagnóstico sale del paciente; si no hay, el título del plan
  // (null sin `clinical.read`, nunca se inventa).
  const diagnosisName = patientCore.diagnosisTitle ?? focusPlan?.title ?? null;
  const age = patient.dateOfBirth
    ? Math.floor((Date.now() - +patient.dateOfBirth) / (365.25 * 86_400_000))
    : null;
  const coverage = patient.coverages[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PatientHero
        patient={patient}
        age={age}
        coverageLabel={coverage ? `${coverage.insurer}${coverage.planName ? " " + coverage.planName : ""}` : "Particular"}
        plans={heroChips}
        plansEnabled={plansEnabled}
        onOpenPlan={openPlan}
        insurers={insurers}
        practitioners={practitioners}
        canReassign={canReassign}
      />

      <TabsBar
        active={tab}
        onChange={setTab}
        only={allowedTabs}
        counts={{
          evoluciones: summary?.liveCount,
          turnos: bookingsAll?.length,
          sesiones: sessionCount,
          planes: livePlanCount,
          // Use the cheap aggregate count for the Facturación badge —
          // accurate even before the full bookings list is loaded.
          fact: billableCount,
        }}
      />

      {/* Active view swaps with a sober fade + slight rise. `mode="wait"`
          lets the outgoing view finish before the next enters so the
          content never overlaps or jumps. Keyed by `tab`. */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: DUR.base, ease: EASE_OUT }}
        >
          {tab === "resumen" && (
            <ResumenView
              patient={patient}
              plan={plansEnabled ? focusPlan : null}
              otherActiveCount={otherActiveCount}
              diagnosisName={diagnosisName}
              permissions={permissions}
              onOpenEditor={openEditor}
              onOpenPlan={openPlan}
              clinicalSummary={notesEnabled ? summary : null}
              onOpenEvoluciones={notesEnabled ? openEvoluciones : undefined}
            />
          )}
          {tab === "evoluciones" && notesEnabled && (
            <EvolucionesView
              patientId={patient.id}
              canWrite={canWriteNotes}
              deepLinkBookingId={noteBookingId}
              deepLinkBooking={noteBooking}
              onChanged={reloadSummary}
            />
          )}
          {tab === "turnos" && (
            <TurnosView
              patientId={patient.id}
              bookings={bookingsAll}
              loading={loadingBookings}
              patchBooking={patchBooking}
              dropBooking={dropBooking}
              restoreBooking={restoreBooking}
              plansEnabled={plansEnabled}
              plans={plans}
              planBalances={planBalances}
              showPlanTitles={showPlanTitles}
            />
          )}
          {tab === "sesiones" && (
            <SesionesView
              patient={patient}
              plans={plans}
              permissions={permissions}
              onOpenEditor={openEditor}
              onOpenPlan={openPlan}
            />
          )}
          {tab === "planes" && plansEnabled && (
            <PlanView
              patientId={patient.id}
              plans={plans}
              permissions={permissions}
              focusProgramId={focusProgramId}
              loading={plansLoading}
              error={plansError}
              onOpenEditor={openEditor}
              onChanged={onPlansChanged}
              showArchived={showArchived}
              onShowArchivedChange={onShowArchivedChange}
              insured={isInsured(coverage)}
            />
          )}
          {tab === "archivos" && <ArchivosView patientId={patient.id} />}
          {tab === "antec" && <AntecedentesView patient={patient} />}
          {tab === "evol" && <EvolucionView patient={patient} />}
          {tab === "fact" && (
            <FacturacionView
              bookings={bookingsAll}
              loading={loadingBookings}
              patchBooking={patchBooking}
              plansEnabled={plansEnabled}
              plans={plans}
              planBalances={planBalances}
              showPlanTitles={showPlanTitles}
              onBillingChanged={reloadBalances}
            />
          )}
          {tab === "actividad" && <ActivityView patientId={patient.id} />}
        </motion.div>
      </AnimatePresence>

      {needsBookings && bookingsAll && nextCursor && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 12,
            color: "var(--navy-500)",
          }}
        >
          <span>
            Mostrando los últimos {bookingsAll.length} turnos. Hay más anteriores.
          </span>
          <Button
            variant="ghost"
            onClick={loadMoreBookings}
            disabled={loadingMore}
            style={{ fontSize: 12, padding: "6px 12px" }}
          >
            {loadingMore ? "Cargando…" : "Ver más"}
          </Button>
          {moreError && <span style={{ color: "#9F1F1F" }}>{moreError}</span>}
        </div>
      )}

      {plansEnabled && editorReq && (
        <PlanEditorDrawer
          {...editorReq}
          open
          onClose={closeEditor}
          onSaved={onEditorSaved}
          permissions={permissions}
        />
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// P0-S07v · Perfil administrativo (nivel `admin`, PD-13 / Planes E1)
// ─────────────────────────────────────────────────────────────────────────────

/** Pestañas del perfil administrativo: datos y turnos, nada clínico. */
export const ADMIN_PROFILE_TABS = ["resumen", "turnos"] as const satisfies readonly Tab[];
type AdminTab = (typeof ADMIN_PROFILE_TABS)[number];

export type AdminBookingsPage = {
  rows: PatientBookingFull[];
  hasMore: boolean;
  nextCursor: string | null;
};

/**
 * Lo que ve un rol sin `clinical.read` (Secretaria/ASSISTANT, BILLING) en la
 * ficha de un paciente: datos (contacto, cobertura, emergencia, a cargo de
 * quién) y turnos con su estado de cobro. **Nunca** HC: sin Evolución, Plan,
 * Sesiones, Seguimiento, Antecedentes, Archivos ni Actividad (PD-13).
 *
 * Antes de S07v la página mandaba todo lo que no fuera `full` a la vista básica
 * ("Sin acceso"), y la Secretaria no veía ni el teléfono del paciente que tenía
 * que llamar.
 *
 * Decisiones:
 *  - Es un componente aparte de `PatientProfile` (no flags adentro): recibe
 *    `PatientAdminCore`, que no tiene campos clínicos, y no importa ninguna
 *    vista de HC en su árbol de render.
 *  - Los turnos llegan de `getPatientBookingsAll` (S07sp lo habilita para
 *    `admin` con título/descripción/notas redactados). Igual, esta tabla no
 *    renderiza esos campos: si el server los mandara por error, no se ven.
 *  - Solo lectura: `updatePatient`, `setPatientCoverage` y los toggles de cobro
 *    exigen acceso `full` (lib/patients.ts, lib/bookings.ts). Operar un turno
 *    (estado, reprogramar, cancelar) se hace en la agenda: cada fila tiene
 *    "Ver en agenda".
 *  - S22b (handoff H1 de S22f): la tabla de turnos es la misma `TurnosView` del
 *    perfil completo en modo `admin` (antes era una copia, `AdminTurnosView`).
 *    Con el módulo `planes` agrupa por plan con la proyección administrativa
 *    de `getPatientPlans` (sin título: `showPlanTitles` queda en false) y el
 *    saldo del server.
 */
export function PatientAdminProfile({
  patient,
  initialBookings,
  canBook,
  initialTab = "resumen",
  plans = null,
  planBalances = null,
}: {
  patient: PatientAdminCore;
  initialBookings: AdminBookingsPage;
  /** `agenda.operateAll` (Secretaria sí, BILLING no): muestra "Agregar turno". */
  canBook: boolean;
  initialTab?: AdminTab;
  /** `getPatientPlans` (proyección `admin`, sin títulos); `null` sin el módulo `planes`. */
  plans?: PlanDTO[] | null;
  /** `getPatientPlanBalances` (data); `null` sin el módulo `planes`. */
  planBalances?: PatientPlanBalances | null;
}) {
  const plansEnabled = useTenantModules().has("planes");
  const [tab, setTab] = useState<AdminTab>(initialTab);
  const [bookings, setBookings] = useState<PatientBookingFull[]>(initialBookings.rows);
  const [nextCursor, setNextCursor] = useState<string | null>(
    initialBookings.hasMore ? initialBookings.nextCursor : null
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await getPatientBookingsAll(patient.id, BOOKINGS_PAGE, nextCursor);
      setBookings((prev) => {
        const seen = new Set(prev.map((b) => b.id));
        return [...prev, ...page.rows.filter((b) => !seen.has(b.id))];
      });
      setNextCursor(page.hasMore ? page.nextCursor : null);
    } catch (e) {
      console.error("getPatientBookingsAll (más, admin) failed", e);
      setMoreError("No pudimos cargar más turnos. Probá de nuevo.");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, patient.id]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PatientAdminHero patient={patient} canBook={canBook} />

      <TabsBar
        active={tab}
        onChange={(t) => setTab(t as AdminTab)}
        only={ADMIN_PROFILE_TABS}
        labels={{ resumen: "Datos" }}
        counts={{ turnos: bookings.length }}
      />

      {tab === "resumen" && (
        <AdminDatosView patient={patient} bookings={bookings} partial={nextCursor !== null} />
      )}
      {tab === "turnos" && (
        <TurnosView
          admin
          patientId={patient.id}
          bookings={bookings}
          loading={false}
          patchBooking={() => {}}
          dropBooking={() => {}}
          plansEnabled={plansEnabled}
          plans={plansEnabled ? plans : null}
          planBalances={plansEnabled ? planBalances : null}
        />
      )}

      {tab === "turnos" && nextCursor && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            flexWrap: "wrap",
            fontSize: 12,
            color: "var(--navy-500)",
          }}
        >
          <span>Mostrando los últimos {bookings.length} turnos. Hay más anteriores.</span>
          <Button
            variant="ghost"
            onClick={loadMore}
            disabled={loadingMore}
            style={{ fontSize: 12, padding: "6px 12px" }}
          >
            {loadingMore ? "Cargando…" : "Ver más"}
          </Button>
          {moreError && <span style={{ color: "#9F1F1F" }}>{moreError}</span>}
        </div>
      )}
    </div>
  );
}


/** Mismo criterio que Facturación: solo los turnos que efectivamente facturan. */
function isBillable(b: PatientBookingFull) {
  return b.status === "CONFIRMED" || b.status === "COMPLETED";
}

/** `dateOfBirth` es fecha civil (excepción de AGENTS §4): se lee el ISO, sin TZ. */
function formatDob(d: Date | string) {
  const [y, m, day] = new Date(d).toISOString().slice(0, 10).split("-");
  return `${day}/${m}/${y}`;
}

function AdminDatosView({
  patient,
  bookings,
  partial,
}: {
  patient: PatientAdminCore;
  bookings: PatientBookingFull[];
  /** Hay turnos más viejos sin cargar: el total de cobro es parcial. */
  partial: boolean;
}) {
  const unpaid = bookings.filter((b) => isBillable(b) && b.paymentStatus !== "PAID");
  const unpaidCents = unpaid.reduce((s, b) => s + b.copagoCents, 0);
  const cov = patient.coverage;
  return (
    <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <Grid2>
        <Section title="Contacto">
          <Grid2>
            <Detail label="Teléfono">{patient.phone ?? "—"}</Detail>
            <Detail label="Email">{patient.email ?? "—"}</Detail>
            <Detail label="DNI">{patient.documentId ?? "—"}</Detail>
            <Detail label="Nacimiento">{patient.dateOfBirth ? formatDob(patient.dateOfBirth) : "—"}</Detail>
          </Grid2>
        </Section>
        <Section title="Cobertura">
          {cov ? (
            <Grid2>
              <Detail label="Obra social">{cov.insurer}</Detail>
              <Detail label="Plan">{cov.planName ?? "—"}</Detail>
              <Detail label="N° de afiliado">{cov.memberId ?? "—"}</Detail>
            </Grid2>
          ) : (
            <span style={{ fontSize: 13, color: "var(--navy-700)" }}>Particular (sin obra social)</span>
          )}
        </Section>
        <Section title="Contacto de emergencia">
          {patient.emergency.length === 0 ? (
            <span style={{ fontSize: 13, color: "var(--navy-500)" }}>Sin contacto de emergencia cargado.</span>
          ) : (
            patient.emergency.map((e, i) => (
              <div key={i} style={{ fontSize: 13, color: "var(--navy-900)" }}>
                <strong>{e.name}</strong>
                {e.relation ? <span style={{ color: "var(--navy-500)" }}> · {e.relation}</span> : null}
                <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)" }}>{e.phone}</div>
              </div>
            ))
          )}
        </Section>
        <Section title="Turnos y cobros">
          <Grid2>
            <Detail label="Próximo turno">
              <span style={{ fontSize: 13 }}>
                {patient.nextBookingAt
                  ? new Date(patient.nextBookingAt).toLocaleString("es-AR", {
                      weekday: "short",
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                      hourCycle: "h23",
                      timeZone: "America/Argentina/Buenos_Aires",
                    })
                  : "Sin turnos agendados"}
              </span>
            </Detail>
            <Detail label={partial ? "Copago pendiente (turnos cargados)" : "Copago pendiente"}>
              <span style={{ fontSize: 13 }}>
                {unpaid.length === 0
                  ? "Nada pendiente"
                  : `${formatARS(unpaidCents)} · ${unpaid.length} ${unpaid.length === 1 ? "turno" : "turnos"}`}
              </span>
            </Detail>
          </Grid2>
        </Section>
      </Grid2>
      <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>
        Profesional a cargo: <strong>{patient.assignedPractitionerName ?? "Consultorio común"}</strong>. Los datos
        del paciente y los cobros los actualiza el profesional a cargo.
      </p>
    </Card>
  );
}
