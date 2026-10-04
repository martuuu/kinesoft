"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { getPatientBookingsAll } from "@/lib/patients";
import type {
  PatientCore,
  PatientAdminCore,
  PatientProgramLite,
  PatientBookingSummary,
  PatientBookingFull,
} from "@/lib/patients-types";
import { toARDateKey } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import type { EvaScore } from "@prisma/client";
import { ActivityView } from "@/components/patients/activity-view";
import { ArchivosView } from "@/components/patients/archivos-view";
import { PatientHero, PatientAdminHero, type HeroPlanState } from "@/components/patients/profile/hero";
import { TabsBar } from "@/components/patients/profile/tabs-bar";
import { ResumenView } from "@/components/patients/profile/views/resumen-view";
import { TurnosView } from "@/components/patients/profile/views/turnos-view";
import { SesionesView } from "@/components/patients/profile/views/sesiones-view";
import { PlanView } from "@/components/patients/profile/views/plan-view";
import { AntecedentesView } from "@/components/patients/profile/views/antecedentes-view";
import { EvolucionView } from "@/components/patients/profile/views/evolucion-view";
import { FacturacionView } from "@/components/patients/profile/views/facturacion-view";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { BookingStatusTag, Detail, Grid2, Section } from "@/components/patients/profile/ui";
import type {
  InsurerOption,
  PatientWithRelations,
  PractitionerOption,
  Tab,
} from "@/components/patients/profile/types";

/** Tamaño de página de turnos del perfil (Turnos + Facturación). */
const BOOKINGS_PAGE = 100;

/**
 * P0-S02u-perfil: qué plan muestra el perfil cuando el paciente tiene varios.
 *
 * Antes `activeProgram` era `find(ACTIVE) ?? programs[0]`: con solo planes
 * terminados caía al último COMPLETED/CANCELLED y el hero decía "Plan activo"
 * (AUDIT `hero-plan-activo-falso`); con dos ACTIVE se veía uno solo sin aviso
 * (parte de perfil de `varios-planes-activos-take1`); y el badge de Sesiones
 * sumaba las sesiones de todos los planes mientras la vista listaba solo las
 * del primero.
 *
 * - `activeProgram`: el ACTIVE más reciente por `createdAt` (no depende del
 *   orden en que llegue la lista), o null. Solo él habilita "Plan activo".
 * - `otherActiveCount`: los otros ACTIVE, para el "+N".
 * - `focusProgram`: lo que muestra Resumen. El activo; si no hay, el último
 *   plan (se muestra con su estado, nunca como vigente).
 * - `heroPlan`: el estado del chip del hero.
 * - `sessionGroups`: lo que lista Sesiones, un grupo por plan (el índice de
 *   sesión reinicia por plan), el foco primero y el resto del más nuevo al más
 *   viejo. El badge del tab cuenta exactamente estas filas.
 */
export function pickProfilePrograms(programs: PatientProgramLite[]) {
  const byRecent = [...programs].sort(
    (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)
  );
  const actives = byRecent.filter((p) => p.status === "ACTIVE");
  const activeProgram = actives[0] ?? null;
  const focusProgram = activeProgram ?? byRecent[0] ?? null;
  const otherActiveCount = Math.max(actives.length - 1, 0);
  const heroPlan: HeroPlanState = activeProgram
    ? { kind: "active", otherActiveCount }
    : byRecent.some((p) => p.status === "PAUSED")
      ? { kind: "paused" }
      : byRecent.length > 0
        ? { kind: "ended" }
        : { kind: "none" };
  const sessionGroups = focusProgram
    ? [focusProgram, ...byRecent.filter((p) => p.id !== focusProgram.id)]
        .filter((p) => p.sessions.length > 0)
        .map((p) => ({ id: p.id, title: p.title, status: p.status, sessions: p.sessions }))
    : [];
  const sessionCount = sessionGroups.reduce((acc, g) => acc + g.sessions.length, 0);
  return { activeProgram, otherActiveCount, focusProgram, heroPlan, sessionGroups, sessionCount };
}

export function PatientProfile({
  patientCore,
  programsLite,
  recentBookings,
  billableCount,
  evaScores,
  insurers = [],
  practitioners = [],
  canReassign = false,
  canUseTemplates,
}: {
  patientCore: PatientCore;
  programsLite: PatientProgramLite[];
  recentBookings: PatientBookingSummary[];
  billableCount: number;
  evaScores: EvaScore[];
  insurers?: InsurerOption[];
  practitioners?: PractitionerOption[];
  canReassign?: boolean;
  /** P0-Cs: plan SaaS con plantillas (`gatingForActor`); pasa directo a PlanView. */
  canUseTemplates?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("resumen");

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

  const { focusProgram, otherActiveCount, heroPlan, sessionGroups, sessionCount } = useMemo(
    () => pickProfilePrograms(patient.programs),
    [patient.programs]
  );
  const diagnosis = focusProgram?.case?.diagnoses?.[0]?.condition ?? null;
  const done = focusProgram?.sessions.filter((s) => s.completedAt).length ?? 0;
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
        plan={heroPlan}
        insurers={insurers}
        practitioners={practitioners}
        canReassign={canReassign}
      />

      <TabsBar
        active={tab}
        onChange={setTab}
        counts={{
          turnos: bookingsAll?.length,
          sesiones: sessionCount,
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
              program={focusProgram}
              otherActiveCount={otherActiveCount}
              diagnosisName={diagnosis?.name ?? focusProgram?.title ?? null}
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
              restoreBooking={restoreBooking}
            />
          )}
          {tab === "sesiones" && <SesionesView patient={patient} groups={sessionGroups} />}
          {tab === "plan" && <PlanView patient={patient} canUseTemplates={canUseTemplates} canDelete={canReassign} />}
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
 *    "Abrir en agenda".
 */
export function PatientAdminProfile({
  patient,
  initialBookings,
  canBook,
  initialTab = "resumen",
}: {
  patient: PatientAdminCore;
  initialBookings: AdminBookingsPage;
  /** `agenda.operateAll` (Secretaria sí, BILLING no): muestra "Agregar turno". */
  canBook: boolean;
  initialTab?: AdminTab;
}) {
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
      {tab === "turnos" && <AdminTurnosView bookings={bookings} />}

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
                      hour12: false,
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

/** Columnas: Fecha y hora · Servicio · Obra social · Copago · OS · Estado · agenda. */
const ADMIN_TURNOS_COLS = "120px 1.2fr 1fr 1fr 1fr 96px 90px";

function PaidLabel({ paid }: { paid: boolean }) {
  return paid ? <Tag tone="lime">Cobrado</Tag> : <Tag tone="soft">Pendiente</Tag>;
}

function AdminTurnosView({ bookings }: { bookings: PatientBookingFull[] }) {
  if (bookings.length === 0) {
    return (
      <Card style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
        Este paciente no tiene turnos cargados.
      </Card>
    );
  }
  // Mismo orden que el tab Turnos del perfil completo: próximos ascendente
  // (el siguiente arriba), después los pasados del más nuevo al más viejo.
  const now = Date.now();
  const sorted = [...bookings].sort((a, b) => {
    const ta = +new Date(a.scheduledFor);
    const tb = +new Date(b.scheduledFor);
    const aUp = ta >= now;
    const bUp = tb >= now;
    if (aUp && bUp) return ta - tb;
    if (!aUp && !bUp) return tb - ta;
    return aUp ? -1 : 1;
  });
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 18px",
          display: "grid",
          gridTemplateColumns: ADMIN_TURNOS_COLS,
          gap: 14,
          fontSize: 10,
          fontWeight: 700,
          color: "var(--navy-300)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <span>Fecha y hora</span>
        <span>Servicio</span>
        <span>Obra social</span>
        <span>Copago</span>
        <span>OS</span>
        <span>Estado</span>
        <span />
      </div>
      {sorted.map((b) => {
        const d = new Date(b.scheduledFor);
        const billable = isBillable(b);
        const hasOS = b.osAmountCents > 0;
        return (
          <div
            key={b.id}
            data-testid="admin-turno-row"
            style={{
              padding: "14px 18px",
              display: "grid",
              gridTemplateColumns: ADMIN_TURNOS_COLS,
              gap: 14,
              alignItems: "center",
              fontSize: 13,
              borderBottom: "1px solid rgba(15,30,51,0.04)",
              opacity: b.status === "CANCELLED" ? 0.55 : 1,
            }}
          >
            <span className="k-mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-700)" }}>
              {d.toLocaleString("es-AR", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: "America/Argentina/Buenos_Aires",
              })}
            </span>
            <span style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.serviceName}
            </span>
            <span style={{ color: "var(--navy-500)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.obraSocial.toLowerCase() === "particular" ? "—" : b.obraSocial}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)", fontWeight: 600 }}>
                {formatARS(b.copagoCents)}
              </span>
              {billable && <PaidLabel paid={b.paymentStatus === "PAID"} />}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {hasOS ? (
                <>
                  <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)", fontWeight: 600 }}>
                    {formatARS(b.osAmountCents)}
                  </span>
                  {billable && <PaidLabel paid={!!b.insurerPaidAt} />}
                </>
              ) : (
                <span style={{ fontSize: 12, color: "var(--navy-300)" }}>—</span>
              )}
            </span>
            <BookingStatusTag status={b.status} />
            <Link
              href={`/agenda?view=timeline&date=${toARDateKey(d)}`}
              style={{ fontSize: 12, fontWeight: 600, color: "var(--sky-700)", textDecoration: "none", justifySelf: "end" }}
            >
              Ver en agenda
            </Link>
          </div>
        );
      })}
    </Card>
  );
}
