"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { getPatientBookingsAll } from "@/lib/patients";
import type {
  PatientCore,
  PatientProgramLite,
  PatientBookingSummary,
  PatientBookingFull,
} from "@/lib/patients-types";
import type { EvaScore } from "@prisma/client";
import { ActivityView } from "@/components/patients/activity-view";
import { ArchivosView } from "@/components/patients/archivos-view";
import { PatientHero } from "@/components/patients/profile/hero";
import { TabsBar } from "@/components/patients/profile/tabs-bar";
import { ResumenView } from "@/components/patients/profile/views/resumen-view";
import { TurnosView } from "@/components/patients/profile/views/turnos-view";
import { SesionesView } from "@/components/patients/profile/views/sesiones-view";
import { PlanView } from "@/components/patients/profile/views/plan-view";
import { AntecedentesView } from "@/components/patients/profile/views/antecedentes-view";
import { EvolucionView } from "@/components/patients/profile/views/evolucion-view";
import { FacturacionView } from "@/components/patients/profile/views/facturacion-view";
import type {
  InsurerOption,
  PatientWithRelations,
  PractitionerOption,
  Tab,
} from "@/components/patients/profile/types";

export function PatientProfile({
  patientCore,
  programsLite,
  recentBookings,
  billableCount,
  evaScores,
  insurers = [],
  practitioners = [],
  canReassign = false,
}: {
  patientCore: PatientCore;
  programsLite: PatientProgramLite[];
  recentBookings: PatientBookingSummary[];
  billableCount: number;
  evaScores: EvaScore[];
  insurers?: InsurerOption[];
  practitioners?: PractitionerOption[];
  canReassign?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("resumen");

  // Lazy slice: the full bookings list is only needed for FacturacionView.
  // While not loaded, `recentBookings` (5 rows) covers Resumen's "próxima
  // cita" card. The first time the user opens Facturación we fetch it
  // and cache in component state for the rest of the session.
  const [bookingsAll, setBookingsAll] = useState<PatientBookingFull[] | null>(null);
  const [loadingBookings, setLoadingBookings] = useState(false);

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
    getPatientBookingsAll(patientCore.id, 100)
      .then((rows) => {
        if (!cancelled) setBookingsAll(rows as PatientBookingFull[]);
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

  // Optimistic in-place patch of a booking after a mutation (status change,
  // payment confirmation) so both tabs reflect it instantly without a refetch.
  const patchBooking = useCallback((id: string, partial: Partial<PatientBookingFull>) => {
    setBookingsAll((prev) => (prev ? prev.map((b) => (b.id === id ? { ...b, ...partial } : b)) : prev));
  }, []);
  const dropBooking = useCallback((id: string) => {
    setBookingsAll((prev) => (prev ? prev.filter((b) => b.id !== id) : prev));
  }, []);

  // Synthesize the legacy composite shape used by sub-views. The
  // `bookings` field swaps between recent (initial) and full (after
  // Facturación opens). Both shapes have the scalar fields the views
  // read (paymentStatus, scheduledFor, status, durationMin).
  const patient: PatientWithRelations = useMemo(
    () => ({
      ...patientCore,
      programs: programsLite,
      bookings: bookingsAll ?? recentBookings,
      evaScores,
    }),
    [patientCore, programsLite, bookingsAll, recentBookings, evaScores]
  );

  const activeProgram = patient.programs.find((p) => p.status === "ACTIVE") ?? patient.programs[0];
  const diagnosis = activeProgram?.case?.diagnoses?.[0]?.condition ?? null;
  const sessions = activeProgram?.sessions ?? [];
  const done = sessions.filter((s) => s.completedAt).length;
  const allSessionsCount = patient.programs.reduce(
    (acc, p) => acc + p.sessions.length,
    0
  );
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
        active={!!activeProgram}
        insurers={insurers}
        practitioners={practitioners}
        canReassign={canReassign}
      />

      <TabsBar
        active={tab}
        onChange={setTab}
        counts={{
          turnos: bookingsAll?.length,
          sesiones: allSessionsCount,
          plan: patient.programs.length,
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
              activeProgram={activeProgram}
              diagnosisName={diagnosis?.name ?? activeProgram?.title ?? null}
              done={done}
            />
          )}
          {tab === "turnos" && (
            <TurnosView
              patientId={patient.id}
              bookings={bookingsAll}
              loading={loadingBookings}
              patchBooking={patchBooking}
              dropBooking={dropBooking}
            />
          )}
          {tab === "sesiones" && <SesionesView patient={patient} sessions={sessions} />}
          {tab === "plan" && <PlanView patient={patient} />}
          {tab === "archivos" && <ArchivosView patientId={patient.id} />}
          {tab === "antec" && <AntecedentesView patient={patient} />}
          {tab === "evol" && <EvolucionView patient={patient} />}
          {tab === "fact" && (
            <FacturacionView
              bookings={bookingsAll}
              loading={loadingBookings}
              patchBooking={patchBooking}
            />
          )}
          {tab === "actividad" && <ActivityView patientId={patient.id} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
