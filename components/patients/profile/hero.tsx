"use client";

import { useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Button, ButtonLink } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { sendPatientPortalInvite, setPatientArchived } from "@/lib/patients";
import type { PatientAdminCore } from "@/lib/patients-types";
import { SharePatientButton } from "@/components/patients/share-patient-button";
import {
  ArchivePatientDialog,
  shouldAskArchivePlans,
  type ArchivePatientResult,
} from "@/components/patients/archive-patient-dialog";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import type { HeroPlanChip, PatientHeroProps } from "@/components/planes/plan-editor-types";
import { disciplineLabel } from "@/lib/plan-display";
import type { PatientArchivePlansAction } from "@/lib/plans-lifecycle-state";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { PortalRequestBanner } from "./portal-request-banner";
import type { PatientWithRelations, InsurerOption, PractitionerOption } from "./types";

import heroStyles from "./hero.module.css";
/** PF1.1 (C-PF2): «Editar paciente» diferido; `preloadEditPatient` lo baja en hover/foco del botón. */
const loadEditPatient = () => import("./edit-patient-drawer");
function preloadEditPatient() {
  void loadEditPatient().catch(() => {});
}
const EditPatientModal = dynamic(() => loadEditPatient().then((m) => m.EditPatientModal), {
  ssr: false,
  loading: () => null,
});

/**
 * Avatar del hero (D5 de VX0-b): iniciales sobre color, como en la lista, hasta que haya foto. Antes era el
 * `PhotoSlot` rayado con el rótulo «paciente» en monoespaciada (un placeholder de maqueta en producción).
 */
function HeroAvatar({ firstName, lastName }: { firstName: string; lastName: string }) {
  return (
    <Avatar
      // Primer nombre + apellido: «María José Pérez» → «MP», no «MJ».
      name={`${firstName.trim().split(/\s+/)[0] ?? ""} ${lastName.trim()}`}
      size={72}
      tone="sky"
      style={{ borderRadius: 20 }}
    />
  );
}

/**
 * Hero del perfil `full`. S22h (ES3): el chip único de plan
 * (`HeroPlanState`, P0-S02u-perfil) pasa a un chip POR PLAN VIVO con su
 * disciplina (`heroPlanChips`: ACTIVE antes que PAUSED). Un paciente puede
 * tener Kine y Osteo en paralelo, y "Plan activo +1" no decía cuál.
 * "Plan" significa tres cosas: el plan de la OBRA SOCIAL sigue siendo
 * `coverageLabel` (fact "Cobertura"), nunca un chip de acá.
 * Los chips no llevan título (PHI, PD-11): `HeroPlanChip` no lo trae.
 */
export function PatientHero({
  patient,
  age,
  coverageLabel,
  plans,
  insurers,
  practitioners,
  canReassign,
  plansEnabled,
  onOpenPlan,
  editRequest = 0,
}: PatientHeroProps & {
  /**
   * PF1.1 (D6): contador que sube cuando otra superficie de la ficha pide «Editar paciente» (el «Cargar diagnóstico»
   * de Resumen). Cada cambio > 0 abre el drawer; el estado del drawer sigue viviendo acá.
   */
  editRequest?: number;
}) {
  // Modals lifted here — outside the <Card glass> — so backdrop-filter
  // on the card doesn't create a stacking context that traps position:fixed.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editRequest > 0) setEditing(true);
  }, [editRequest]);
  const [askPlans, setAskPlans] = useState(false);
  const livePlanCount = plansEnabled ? plans.length : 0;
  const practitionerFact = usePractitionerFactLabel();

  // L9: el diálogo junta la elección; la action va acá (single, no bulk).
  const archiveWithPlans = async (plansAction: PatientArchivePlansAction): Promise<ArchivePatientResult> => {
    const r = await setPatientArchived({ id: patient.id, archived: true, plansAction });
    if (!r.ok) return { ok: false, error: r.error };
    // PF-0d: sin `router.refresh()`; `setPatientArchived` revalida la ficha.
    return { ok: true };
  };

  return (
    <>
      <Card glass style={{ padding: 18, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <HeroAvatar firstName={patient.firstName} lastName={patient.lastName} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
            <span
              className="k-mono"
              style={{
                padding: "2px 7px",
                borderRadius: 6,
                background: "var(--navy-900)",
                color: "#fff",
                fontSize: 10,
                fontWeight: 700,
              }}
            >
              HC-{patient.id.slice(-6).toUpperCase()}
            </span>
            {plansEnabled && <HeroPlanChips plans={plans} onOpenPlan={onOpenPlan} />}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <h1 className="k-display" style={{ fontSize: 28, margin: 0, letterSpacing: "-0.02em" }}>
              {patient.firstName} {patient.lastName}
            </h1>
            <span style={{ fontSize: 13, color: "var(--navy-500)" }}>
              {age != null ? `${age} años` : ""}
              {patient.documentId ? ` · DNI ${patient.documentId}` : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 24, marginTop: 12, fontSize: 12, color: "var(--navy-500)", flexWrap: "wrap" }}>
            <HeroFact label="Tel." value={patient.phone ?? "—"} />
            <HeroFact label="Email" value={patient.email ?? "—"} />
            <HeroFact label="Cobertura" value={coverageLabel} />
            <HeroFact
              label={practitionerFact}
              value={
                patient.assignedPractitionerId
                  ? practitioners.find((p) => p.id === patient.assignedPractitionerId)?.name ?? "—"
                  : "Consultorio común"
              }
            />
          </div>
        </div>
        <PatientHeroActions
          patient={patient}
          insurers={insurers}
          practitioners={practitioners}
          canReassign={canReassign}
          livePlanCount={livePlanCount}
          plansEnabled={plansEnabled}
          onAskArchivePlans={() => setAskPlans(true)}
          onEdit={() => setEditing(true)}
        />
      </Card>

      {/* ES4 S24r: pedido de «Mis datos» del portal (se carga solo; sin pedido no renderiza nada). */}
      <PortalRequestBanner patientId={patient.id} />

      <ArchivePatientDialog
        open={askPlans}
        onClose={() => setAskPlans(false)}
        patientName={`${patient.firstName} ${patient.lastName}`}
        livePlanCount={livePlanCount}
        onConfirm={archiveWithPlans}
      />

      {/* Modals rendered as siblings of the Card, not inside it.
          This avoids backdrop-filter creating a new stacking context
          that traps position:fixed inside the glass card. */}
      {editing && (
        <EditPatientModal
          patient={patient}
          insurers={insurers}
          practitioners={practitioners}
          canReassign={canReassign}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

/**
 * P0-S07v · Hero del perfil administrativo (nivel `admin`, PD-13): lo que ve
 * un rol sin `clinical.read` (Secretaria/ASSISTANT, BILLING).
 *
 * Es un componente aparte, no `PatientHero` con flags, porque recibe otro
 * tipo (`PatientAdminCore`, sin notas ni diagnóstico): así el compilador
 * impide que un campo clínico llegue a este render por error.
 *
 * Qué NO tiene, a propósito:
 *  - chip de plan: el título y el estado del plan son HC;
 *  - "Editar": `updatePatient` y `setPatientCoverage` exigen acceso `full`
 *    (lib/patients.ts) → para `admin` la ficha es de solo lectura;
 *  - Compartir, Archivar y Portal: también exigen `full` en el server.
 * "Agregar turno" solo con `canBook` (`agenda.operateAll`): BILLING no crea turnos.
 */
export function PatientAdminHero({
  patient,
  canBook,
}: {
  patient: PatientAdminCore;
  canBook: boolean;
}) {
  const age = patient.dateOfBirth
    ? Math.floor((Date.now() - +new Date(patient.dateOfBirth)) / (365.25 * 86_400_000))
    : null;
  const cov = patient.coverage;
  const coverageLabel = cov ? `${cov.insurer}${cov.planName ? " " + cov.planName : ""}` : "Particular";
  const practitionerFact = usePractitionerFactLabel();
  return (
    <>
      <Card glass style={{ padding: 18, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <HeroAvatar firstName={patient.firstName} lastName={patient.lastName} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
            <Tag tone="soft">Ficha administrativa</Tag>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <h1 className="k-display" style={{ fontSize: 28, margin: 0, letterSpacing: "-0.02em" }}>
              {patient.firstName} {patient.lastName}
            </h1>
            <span style={{ fontSize: 13, color: "var(--navy-500)" }}>
              {age != null ? `${age} años` : ""}
              {patient.documentId ? `${age != null ? " · " : ""}DNI ${patient.documentId}` : ""}
            </span>
          </div>
          <div style={{ display: "flex", gap: 24, marginTop: 12, fontSize: 12, color: "var(--navy-500)", flexWrap: "wrap" }}>
            <HeroFact label="Tel." value={patient.phone ?? "—"} />
            <HeroFact label="Email" value={patient.email ?? "—"} />
            <HeroFact label="Cobertura" value={coverageLabel} />
            <HeroFact label={practitionerFact} value={patient.assignedPractitionerName ?? "Consultorio común"} />
          </div>
        </div>
        {canBook && (
          // PF1-Z-F2: un solo <a> con aspecto de botón (antes <Link><Button/></Link>: <button> dentro de <a>).
          <ButtonLink href={`/agenda?new=1&patient=${patient.id}`} variant="primary" className={heroStyles.action} style={{ fontSize: 12, padding: "8px 14px" }}>
            <IconPlus size={12} /> Agregar turno
          </ButtonLink>
        )}
      </Card>
      {/* ES4 S24r · PD-13: la Secretaria aprueba contacto y cobertura del pedido del portal. */}
      <PortalRequestBanner patientId={patient.id} />
    </>
  );
}

function PatientHeroActions({
  patient,
  practitioners,
  livePlanCount,
  plansEnabled,
  onAskArchivePlans,
  onEdit,
}: {
  patient: PatientWithRelations;
  insurers: InsurerOption[];
  practitioners: PractitionerOption[];
  canReassign: boolean;
  /** Planes vivos (ACTIVE/PAUSED) del paciente: decide si archivar pregunta L9. */
  livePlanCount: number;
  plansEnabled: boolean;
  /** Abre el diálogo L9 (vive fuera del Card glass, como el de Editar). */
  onAskArchivePlans: () => void;
  onEdit: () => void;
}) {
  const confirm = useConfirm();
  const [archiving, startArchive] = useTransition();
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const isArchived = !!patient.archivedAt;

  // A2a-S08 (decisión del dueño 30-sep): se quitó "Eliminar definitivamente"
  // — borraba en cascada turnos, cobros, planes y archivos sin retorno. Queda
  // Archivar: oculta la ficha del listado y se revierte desde "archivados".
  const toggleArchive = async () => {
    // L9 (PD-10): con planes vivos, archivar pregunta qué hacer con ellos
    // (pausar por default o cancelar los turnos futuros). Sin planes sigue el
    // confirm de siempre, y el server aplica su default (`pause`, no-op).
    if (!isArchived && shouldAskArchivePlans({ plansEnabled, livePlanCount })) {
      setArchiveError(null);
      onAskArchivePlans();
      return;
    }
    const ok = await confirm(
      isArchived
        ? {
            title: "Reactivar paciente",
            message: `${patient.firstName} ${patient.lastName} vuelve a aparecer en el listado de pacientes.`,
            confirmLabel: "Reactivar",
          }
        : {
            title: "Archivar paciente",
            message: `${patient.firstName} ${patient.lastName} deja de aparecer en el listado. La ficha, los turnos y el historial se conservan, y lo podés reactivar cuando quieras. Si usaba el portal, se desvincula su cuenta.`,
            confirmLabel: "Archivar",
          }
    );
    if (!ok) return;
    setArchiveError(null);
    startArchive(async () => {
      const r = await setPatientArchived({ id: patient.id, archived: !isArchived });
      if (!r.ok) {
        setArchiveError(r.error);
        return;
      }
      // PF-0d: sin `router.refresh()`; `setPatientArchived` revalida la ficha
      // y la respuesta de la action ya trae el árbol nuevo.
    });
  };

  const [portalSending, startPortal] = useTransition();
  const [portalResult, setPortalResult] = useState<
    | { ok: true; emailSent: boolean; portalUrl: string; emailStatus?: string }
    | { ok: false; error: string }
    | null
  >(null);

  const sendToPortal = () => {
    setPortalResult(null);
    startPortal(async () => {
      const r = await sendPatientPortalInvite({ patientId: patient.id });
      if (r.ok) setPortalResult({ ok: true, ...r.data });
      else setPortalResult({ ok: false, error: r.error });
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <ButtonLink href={`/agenda?new=1&patient=${patient.id}`} variant="primary" className={heroStyles.action} style={{ fontSize: 12, padding: "8px 14px" }}>
          <IconPlus size={12} /> Agregar turno
        </ButtonLink>
        <SharePatientButton
          patientId={patient.id}
          ownerPractitionerId={patient.assignedPractitionerId}
          practitioners={practitioners}
        />
        <Button
          variant="ghost"
          onClick={sendToPortal}
          className={heroStyles.action}
          disabled={portalSending || !patient.email}
          title={patient.email ? "Invitar al paciente al portal" : "Cargá un email primero"}
          style={{ fontSize: 12, padding: "8px 14px" }}
        >
          {portalSending ? "Enviando…" : patient.userId ? "Reenviar portal" : "Enviar al portal"}
        </Button>
        <Button
          variant="ghost"
          onClick={onEdit}
          className={heroStyles.action}
          onPointerEnter={preloadEditPatient}
          onFocus={preloadEditPatient}
          style={{ fontSize: 12, padding: "8px 14px" }}
        >
          Editar
        </Button>
        <Button
          variant="ghost"
          onClick={toggleArchive}
          className={heroStyles.action}
          disabled={archiving}
          title={
            isArchived
              ? "Volver a mostrar el paciente en el listado"
              : "Ocultar del listado sin borrar la ficha ni el historial"
          }
          style={{ fontSize: 12, padding: "8px 14px", color: "var(--warn-fg)" }}
        >
          {archiving ? "Guardando…" : isArchived ? "Reactivar" : "Archivar"}
        </Button>
      </div>
      {archiveError && (
        <div
          style={{
            maxWidth: 320,
            padding: 8,
            borderRadius: 8,
            fontSize: 11.5,
            background: "var(--danger-bg)",
            color: "var(--danger-fg)",
            textAlign: "right",
          }}
        >
          {archiveError}
        </div>
      )}
      {portalResult && (
        <div
          style={{
            maxWidth: 320,
            padding: 8,
            borderRadius: 8,
            fontSize: 11.5,
            background: portalResult.ok
              ? portalResult.emailSent
                ? "var(--success-bg)"
                : "var(--warn-bg)"
              : "var(--danger-bg)",
            color: portalResult.ok ? "var(--navy-900)" : "var(--danger-fg)",
            textAlign: "right",
          }}
        >
          {portalResult.ok
            ? portalResult.emailSent
              ? "✓ Email enviado al paciente."
              : portalResult.emailStatus === "skipped"
                ? `Este entorno no manda mails: compartile el link del portal. ${portalResult.portalUrl}`
                : `No pudimos mandar el mail. Probá de nuevo en un rato. Link del portal: ${portalResult.portalUrl}`
            : portalResult.error}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
        Última actualización:{" "}
        {patient.updatedAt.toLocaleString("es-AR", {
          dateStyle: "short",
          timeStyle: "short",
          // Fixed AR timezone so the server (UTC) and the client format the
          // same string — otherwise it's a hydration mismatch.
          timeZone: "America/Argentina/Buenos_Aires",
        })}
      </div>
    </div>
  );
}


/**
 * EV1-C2: rótulo del profesional asignado en el hero. «Kine» es de kinesiología;
 * un consultorio de Clínica general dice «Profesional». Vertical real del
 * contexto (EV1; antes se deducía de `has("sesiones")`).
 */
function usePractitionerFactLabel(): string {
  return useTenantModules().vertical === "KINESIOLOGY" ? "Kine" : "Profesional";
}

function HeroFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 9.5,
          color: "var(--navy-300)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--navy-900)", fontWeight: 500, marginTop: 1 }}>
        {value}
      </div>
    </div>
  );
}

/**
 * Texto del chip de un plan vivo en el hero (puro, lo usa el render test).
 * "3/10" = realizadas / sesiones vivas (`done`/`totalLive`), NO "Sesión 3 de
 * 10": por eso no se usa el modo contador de `DisciplineChip` (ese es el
 * ordinal de UNA sesión). El aria lo dice entero, con la disciplina, porque el
 * color no puede ser el único canal (AGENTS §5).
 */
export function heroPlanChipText(chip: HeroPlanChip): { progress: string; ariaLabel: string } {
  const disc = chip.discipline ? `Plan de ${disciplineLabel(chip.discipline)}` : "Plan";
  const paused = chip.status === "PAUSED" ? ", pausado" : "";
  return {
    progress: `${chip.done}/${chip.totalLive}`,
    ariaLabel: `${disc}: ${chip.done} de ${chip.totalLive} ${chip.totalLive === 1 ? "sesión realizada" : "sesiones realizadas"}${paused}`,
  };
}

/** Desde cuántos planes vivos el hero muestra un chip resumen en vez de uno por plan (D7). */
export const HERO_PLAN_SUMMARY_FROM = 3;

/** Texto del chip resumen (puro): «3 planes activos», «2 planes activos · 1 pausado», «3 planes pausados». */
export function heroPlanSummaryText(plans: readonly HeroPlanChip[]): { text: string; ariaLabel: string } {
  const paused = plans.filter((p) => p.status === "PAUSED").length;
  const active = plans.length - paused;
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} ${active === 1 ? "plan activo" : "planes activos"}`);
  if (paused > 0) {
    parts.push(
      active > 0
        ? `${paused} ${paused === 1 ? "pausado" : "pausados"}`
        : `${paused} ${paused === 1 ? "plan pausado" : "planes pausados"}`
    );
  }
  const text = parts.join(" · ");
  return { text, ariaLabel: `${plans.length} planes en curso (${text})` };
}

function HeroPlanChips({
  plans,
  onOpenPlan,
}: {
  plans: HeroPlanChip[];
  onOpenPlan?: (programId: string) => void;
}) {
  if (plans.length === 0) return <Tag tone="soft">Sin plan activo</Tag>;
  // D7 (VX0-b): con 3 o más planes vivos, una fila de chips «Plan 0/6 · Plan 0/8 · Plan 0/8 Pausado» arriba del
  // nombre era ruido. Pasa a UN chip resumen que lleva a Planes; el detalle queda en su `title`/aria. Con 1 o 2 se
  // mantienen los chips por disciplina de S22h (Kine y Osteo en paralelo, que «Plan activo +1» no distinguía).
  if (plans.length >= HERO_PLAN_SUMMARY_FROM) {
    const { text, ariaLabel } = heroPlanSummaryText(plans);
    const detail = plans.map((p) => heroPlanChipText(p).ariaLabel).join(" · ");
    const style: React.CSSProperties = {
      // `font` primero: el shorthand pisa `fontSize`/`fontWeight` si va después.
      font: "inherit",
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "3px 10px",
      borderRadius: 999,
      background: "#fff",
      border: "1px solid rgba(15,30,51,0.08)",
      fontSize: 11.5,
      fontWeight: 700,
      color: "var(--navy-700)",
    };
    return onOpenPlan ? (
      <button
        type="button"
        data-testid="hero-plan-summary"
        onClick={() => onOpenPlan(plans[0].programId)}
        title={detail}
        aria-label={`${ariaLabel}: ${detail}. Ver los planes`}
        style={{ ...style, cursor: "pointer" }}
      >
        {text}
      </button>
    ) : (
      <span data-testid="hero-plan-summary" role="group" title={detail} aria-label={`${ariaLabel}: ${detail}`} style={style}>
        {text}
      </span>
    );
  }
  return (
    <ul
      aria-label="Planes en curso"
      style={{ display: "flex", gap: 6, flexWrap: "wrap", listStyle: "none", margin: 0, padding: 0 }}
    >
      {plans.map((p) => {
        const { progress, ariaLabel } = heroPlanChipText(p);
        const paused = p.status === "PAUSED";
        const body = (
          <>
            <DisciplineChip discipline={p.discipline} />
            <span className="k-mono" aria-hidden style={{ fontSize: 11, fontWeight: 700, color: "var(--navy-700)" }}>
              {progress}
            </span>
            {paused && (
              <span aria-hidden style={{ fontSize: 10.5, fontWeight: 600, color: "var(--navy-500)" }}>
                Pausado
              </span>
            )}
          </>
        );
        const boxStyle: React.CSSProperties = {
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          padding: "2px 8px 2px 3px",
          borderRadius: 999,
          background: paused ? "rgba(15,30,51,0.04)" : "#fff",
          border: "1px solid rgba(15,30,51,0.08)",
          opacity: paused ? 0.85 : 1,
          font: "inherit",
        };
        return (
          <li key={p.programId} data-testid="hero-plan-chip" data-status={p.status}>
            {onOpenPlan ? (
              <button
                type="button"
                onClick={() => onOpenPlan(p.programId)}
                aria-label={`${ariaLabel}. Ver el plan`}
                style={{ ...boxStyle, cursor: "pointer" }}
              >
                {body}
              </button>
            ) : (
              <span role="group" aria-label={ariaLabel} style={boxStyle}>
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
