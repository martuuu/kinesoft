"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconPlus } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { setBookingStatus, deleteBooking } from "@/lib/bookings";
import {
  forcePromptConfirm,
  nextForcePrompt,
  withForce,
  type ForceFlags,
} from "@/lib/booking-force-flags";
import { toARDateKey } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import { BookingStatusTag } from "../ui";
import type { PatientBookingFull } from "@/lib/patients-types";
import type { PatientPlanBalances, PlanDTO } from "@/lib/plans-read-types";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { PlanBalance, PlanGroupHeader } from "@/components/planes/plan-balance";
import {
  bookingPlanOrdinal,
  canDeleteFromProfile,
  groupBookingsByPlan,
  isBillableBooking,
  planGroupMetas,
  shouldGroupByPlan,
  type PlanGroupMeta,
} from "@/components/planes/plan-booking-groups";

/** Turnos tab columns: Fecha+hora · Servicio · Obra social · Copago · Duración · Estado · acciones. */
const TURNOS_COLS = "120px 1.2fr 1fr 90px 72px 96px 40px";
/** Nivel `admin`: copago y OS con su estado de cobro, y "Ver en agenda" en vez del menú. */
const TURNOS_COLS_ADMIN = "120px 1.2fr 1.1fr 1.1fr 72px 96px 90px";
/**
 * P3.Z (F3b): con 7 columnas la grilla superaba los 360 px de un teléfono
 * dentro de una Card con `overflow:hidden` y "Ver en agenda" quedaba cortado.
 * La tabla scrollea DENTRO de la card (como Sesiones), la página no (AGENTS §5).
 */
const TURNOS_MIN_WIDTH = 720;
const TURNOS_MIN_WIDTH_ADMIN = 780;

/**
 * S22f (ES3 P3.1): con el módulo `planes` y algún turno de plan cargado, la
 * lista se agrupa por plan (chip de disciplina, nunca el título sin permiso,
 * saldo compacto del server) + "Turnos sueltos". Sin módulo o sin turnos de
 * plan → la vista de siempre. Los turnos de plan no tienen "Eliminar": se
 * cancelan (el server además rechaza borrar un turno con cobro).
 */
export type TurnosViewProps = {
  patientId: string;
  bookings: PatientBookingFull[] | null;
  loading: boolean;
  patchBooking: (id: string, partial: Partial<PatientBookingFull>) => void;
  dropBooking: (id: string) => void;
  /**
   * Rollback del borrado optimista: re-inserta la fila si el server rechaza el
   * borrado. Sin este callback la fila recién se quita cuando el server
   * confirma (no hay optimismo que deshacer).
   */
  restoreBooking?: (b: PatientBookingFull) => void;
  /**
   * Acceso básico = solo ver (decisión del dueño, 30-sep). Hoy el perfil
   * completo solo se monta con acceso `full`, así que el default es editable;
   * el prop deja la vista lista para cuando se muestre en otro contexto.
   */
  readOnly?: boolean;
  /**
   * Nivel `admin` (Secretaria / Facturación, PD-13): solo lectura, con el
   * estado de cobro (copago y OS) en cada fila y el link a la agenda. Sin
   * datos clínicos: la fila nunca muestra título ni notas del turno.
   */
  admin?: boolean;
  /** `useTenantModules().has('planes')`. Sin módulo: nunca se agrupa. */
  plansEnabled?: boolean;
  /** `getPatientPlans` (data). Da disciplina, estado y "Sesión n de N". */
  plans?: readonly PlanDTO[] | null;
  /** `getPatientPlanBalances` (data). Saldo P7 del server (incluye archivados). */
  planBalances?: PatientPlanBalances | null;
  /** Acceso full + `clinical.read`. Sin esto el grupo muestra la disciplina, nunca el título. */
  showPlanTitles?: boolean;
};

export function TurnosView({
  patientId,
  bookings,
  loading,
  patchBooking,
  dropBooking,
  restoreBooking,
  readOnly: readOnlyProp = false,
  admin = false,
  plansEnabled = false,
  plans = null,
  planBalances = null,
  showPlanTitles = false,
}: TurnosViewProps) {
  const readOnly = readOnlyProp || admin;
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  // `setBookingStatus` devuelve la nueva versión (`data.updatedAt`): se guarda
  // en la fila para que la acción siguiente mande el lock vigente y no rebote
  // como "cambiado en otra pestaña".
  const versionOf = (b: PatientBookingFull) => new Date(b.updatedAt).toISOString();

  // "Nuevo turno" opens the agenda's create flow pre-filled with this patient
  // (the /agenda?new=1&patient= deep-link is already handled by AgendaClient).
  const header = readOnly ? null : (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <Link href={`/agenda?new=1&patient=${patientId}`} style={{ textDecoration: "none" }}>
        <Button variant="primary">
          <IconPlus size={14} /> Nuevo turno
        </Button>
      </Link>
    </div>
  );

  if (loading || bookings === null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {header}
        <Card glass style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Cargando turnos…
        </Card>
      </div>
    );
  }
  if (bookings.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {header}
        <Card style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
          Este paciente no tiene turnos cargados.
        </Card>
      </div>
    );
  }

  // Nearest → farthest: upcoming ascending (soonest first), then past
  // descending (most recent first) so the next turno sits at the top.
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

  // A2b-S-ui (handoff de A2a-S06): optimistic lock con `expectedUpdatedAt` y,
  // al reactivar un CANCELLED, confirmación de sobreturno / superposición del
  // paciente con `useConfirm` y re-llamada con el flag. Antes se mandaba sin
  // versión (pisaba cambios de otra pestaña) y el conflicto se mostraba como
  // un error genérico sin salida.
  const setStatus = (b: PatientBookingFull, status: PatientBookingFull["status"]) => {
    const prevStatus = b.status;
    const expected = versionOf(b);
    patchBooking(b.id, { status });
    start(async () => {
      let force: ForceFlags = {};
      // Como mucho cuatro confirmaciones (bloqueo, fuera de horario, cupo y
      // paciente superpuesto; B5.7 sumó las dos primeras). Un aviso ya
      // aceptado que vuelve es un error real: `nextForcePrompt` no lo repite.
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await setBookingStatus(b.id, status, expected, force);
        if (r.ok) {
          patchBooking(b.id, { updatedAt: new Date(r.data.updatedAt) });
          // S12/C4: aviso no bloqueante de la sincronía con la sesión del plan.
          if (r.notice) toast.info(r.notice);
          return;
        }
        const prompt = nextForcePrompt(r, force);
        if (prompt) {
          const ok = await confirm(forcePromptConfirm(prompt, "reactivate"));
          if (!ok) break;
          force = withForce(force, prompt);
          continue;
        }
        toast.error("No pudimos actualizar el turno", { description: r.error });
        break;
      }
      patchBooking(b.id, { status: prevStatus });
    });
  };
  // Borrado: confirmación con `useConfirm` (no `window.confirm`), lock y
  // rollback de la fila si el server lo rechaza (p. ej. turno con cobro
  // registrado, o cambiado en otra pestaña). Antes la fila desaparecía aunque
  // el borrado fallara.
  const remove = async (b: PatientBookingFull) => {
    const ok = await confirm({
      title: "¿Eliminar este turno?",
      message: "Esta acción es definitiva. Si solo no va a venir, usá «Cancelar turno».",
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    if (restoreBooking) dropBooking(b.id);
    start(async () => {
      const r = await deleteBooking(b.id, versionOf(b));
      if (!r.ok) {
        if (restoreBooking) restoreBooking(b);
        toast.error("No pudimos eliminar el turno", { description: r.error });
        return;
      }
      if (!restoreBooking) dropBooking(b.id);
      toast.success("Turno eliminado");
    });
  };

  const grouped = shouldGroupByPlan(plansEnabled, sorted);
  const groups = grouped
    ? groupBookingsByPlan(sorted, planGroupMetas({ plans, planBalances, showPlanTitles }))
    : null;

  const cols = admin ? TURNOS_COLS_ADMIN : TURNOS_COLS;
  const columnsHeader = (
    <div style={{ padding: "12px 18px", display: "grid", gridTemplateColumns: cols, gap: 14, fontSize: 10, fontWeight: 700, color: "var(--navy-300)", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
      <span>Fecha y hora</span>
      <span>Servicio</span>
      <span>Obra social</span>
      <span>Copago</span>
      <span>Duración</span>
      <span>Estado</span>
      <span />
    </div>
  );
  const table = (children: React.ReactNode) => (
    <div data-testid="profile-table-scroll" style={{ overflowX: "auto" }}>
      <div style={{ minWidth: admin ? TURNOS_MIN_WIDTH_ADMIN : TURNOS_MIN_WIDTH }}>{children}</div>
    </div>
  );
  const row = (b: PatientBookingFull, plan: PlanGroupMeta | null) => {
    const d = new Date(b.scheduledFor);
    const cancelled = b.status === "CANCELLED";
    const ord = plan ? bookingPlanOrdinal(b, plan) : null;
    const billable = isBillableBooking(b);
    return (
      <div
        key={b.id}
        data-testid="turno-row"
        data-plan={b.programId ?? undefined}
        style={{ padding: "14px 18px", display: "grid", gridTemplateColumns: cols, gap: 14, alignItems: "center", fontSize: 13, borderBottom: "1px solid rgba(15,30,51,0.04)", opacity: cancelled ? 0.55 : 1 }}
      >
        <span className="k-mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-700)" }}>
          {d.toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Argentina/Buenos_Aires" })}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {ord && plan && (
            <DisciplineChip discipline={plan.discipline} ordinal={ord.ordinal} totalLive={ord.totalLive} size="xs" />
          )}
          <span style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.serviceName}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", color: "var(--navy-500)", fontSize: 12, minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {b.obraSocial.toLowerCase() === "particular" ? "—" : b.obraSocial}
          </span>
          {admin && billable && b.osAmountCents > 0 && (
            <Tag tone={b.insurerPaidAt ? "lime" : "soft"}>{b.insurerPaidAt ? "OS cobrada" : "OS pendiente"}</Tag>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)", fontWeight: 600 }}>{formatARS(b.copagoCents)}</span>
          {admin && (billable || b.paymentStatus === "PAID") && (
            <Tag tone={b.paymentStatus === "PAID" ? "lime" : "soft"}>{b.paymentStatus === "PAID" ? "Cobrado" : "Pendiente"}</Tag>
          )}
        </span>
        <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>{b.durationMin} min</span>
        <BookingStatusTag status={b.status} />
        {readOnly ? (
          admin ? (
            <Link
              href={`/agenda?view=timeline&date=${toARDateKey(d)}`}
              style={{ fontSize: 12, fontWeight: 600, color: "var(--sky-700)", textDecoration: "none", justifySelf: "end" }}
            >
              Ver en agenda
            </Link>
          ) : (
            <span />
          )
        ) : (
          <TurnoActionsMenu
            booking={b}
            onStatus={(s) => setStatus(b, s)}
            onDelete={canDeleteFromProfile(b) ? () => void remove(b) : undefined}
            disabled={pending}
          />
        )}
      </div>
    );
  };

  if (groups) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {header}
        {groups.map((g) => (
          <Card key={g.key} data-testid="turnos-group" style={{ padding: 0, overflow: "hidden" }}>
            <PlanGroupHeader
              plan={g.kind === "plan" ? g.plan : null}
              count={g.bookings.length}
              aside={g.kind === "plan" && g.plan.balance ? <PlanBalance balance={g.plan.balance} variant="compact" /> : undefined}
            />
            {table(
              <>
                {columnsHeader}
                {g.bookings.map((b) => row(b, g.kind === "plan" ? g.plan : null))}
              </>
            )}
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {header}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {table(
          <>
            {columnsHeader}
            {sorted.map((b) => row(b, null))}
          </>
        )}
      </Card>
    </div>
  );
}

function TurnoActionsMenu({
  booking,
  onStatus,
  onDelete,
  disabled,
}: {
  booking: PatientBookingFull;
  onStatus: (s: PatientBookingFull["status"]) => void;
  /** Ausente = sin "Eliminar" (turno de plan, `canDeleteFromProfile`). */
  onDelete?: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dateKey = toARDateKey(new Date(booking.scheduledFor));
  const itemStyle: React.CSSProperties = {
    width: "100%", textAlign: "left", border: "none", background: "transparent", cursor: "pointer",
    fontSize: 12.5, fontWeight: 600, color: "var(--navy-700)", padding: "8px 10px", borderRadius: 8, display: "block",
  };
  const Item = ({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => { setOpen(false); onClick(); }} style={{ ...itemStyle, color: danger ? "var(--danger-fg)" : "var(--navy-700)" }}>
      {label}
    </button>
  );

  return (
    <div ref={ref} style={{ position: "relative", justifySelf: "end" }}>
      <button
        type="button"
        aria-label="Acciones del turno"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ width: 30, height: 30, borderRadius: 8, border: "none", background: open ? "rgba(15,30,51,0.06)" : "transparent", cursor: "pointer", color: "var(--navy-500)", fontSize: 18, lineHeight: 1, fontWeight: 700 }}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="k-glass-strong" style={{ position: "absolute", top: 32, right: 0, width: 190, borderRadius: 12, padding: 6, zIndex: 30, display: "grid", gap: 2 }}>
          <Item label="Confirmar" onClick={() => onStatus("CONFIRMED")} />
          <Item label="Marcar hecho" onClick={() => onStatus("COMPLETED")} />
          <Item label="Marcar ausente" onClick={() => onStatus("NO_SHOW")} />
          <Item label="Cancelar turno" onClick={() => onStatus("CANCELLED")} />
          <Link href={`/agenda?view=timeline&date=${dateKey}`} style={itemStyle} onClick={() => setOpen(false)}>
            Abrir en agenda
          </Link>
          {onDelete && (
            <>
              <div style={{ height: 1, background: "rgba(15,30,51,0.08)", margin: "2px 0" }} />
              <Item label="Eliminar" onClick={onDelete} danger />
            </>
          )}
        </div>
      )}
    </div>
  );
}
