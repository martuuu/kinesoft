"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button, ButtonLink } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconPlus } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { setBookingStatus, deleteBooking } from "@/lib/bookings";
import { retryWithForce, successInfoText } from "@/components/agenda/booking-drawer/force-outcome";
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
import { CONTACT_MENU_COPY, isShareableRow } from "@/components/patients/contact-actions-logic";
import type { PatientShareBundle } from "@/lib/patient-share-types";
import { menuKeyStep } from "@/components/fichas/ficha-menu";
import contactStyles from "@/components/patients/contact-actions.module.css";
import tableStyles from "./profile-table.module.css";
import heroStyles from "../hero.module.css";

/**
 * CF3 (D-CF3-8, SH-U): «Compartir por WhatsApp» y «Copiar recordatorio» por fila. El contacto, el consultorio y la
 * sede salen de `getPatientShareBundle`, que baja con el panel diferido del teléfono (`contact-actions.tsx`): se pide
 * al abrir el menú de la fila (y se precarga en hover/foco), así el click del ítem ya tiene el link armado.
 */
const loadContactActions = () => import("@/components/patients/contact-actions");
type ContactActionsModule = Awaited<ReturnType<typeof loadContactActions>>;
type RowShareState = { mod: ContactActionsModule; bundle: PatientShareBundle };

function useRowShare(patientId: string, firstName: string) {
  const toast = useToast();
  const [ready, setReady] = useState<RowShareState | null>(null);
  const inflight = useRef<Promise<RowShareState | null> | null>(null);
  const prepare = useCallback((): Promise<RowShareState | null> => {
    if (!inflight.current) {
      inflight.current = loadContactActions()
        .then(async (mod) => {
          const next = { mod, bundle: await mod.loadRowShareBundle(patientId) };
          setReady(next);
          return next;
        })
        .catch((e) => {
          console.error("contact-actions chunk failed", e);
          return null;
        })
        .finally(() => {
          // Siguiente apertura: vuelve a pedir (la caché de 30 s del módulo evita la lectura repetida).
          inflight.current = null;
        });
    }
    return inflight.current;
  }, [patientId]);

  const reminderOf = (s: RowShareState, b: PatientBookingFull) =>
    s.mod.rowShareFor(
      s.bundle,
      { id: b.id, serviceName: b.serviceName, scheduledFor: b.scheduledFor, durationMin: b.durationMin, status: b.status },
      firstName
    );

  const whatsApp = (b: PatientBookingFull) => {
    if (ready) {
      window.open(reminderOf(ready, b).href, "_blank", "noopener");
      return;
    }
    // Todavía sin el bundle: la ventana se abre YA (dentro del click; después de un `await` el navegador la bloquea)
    // y se le pone la dirección cuando llega.
    const w = window.open("", "_blank");
    void prepare().then((s) => {
      if (!s) {
        w?.close();
        toast.error(CONTACT_MENU_COPY.rowUnavailable);
        return;
      }
      if (w) {
        w.opener = null;
        w.location.href = reminderOf(s, b).href;
      }
    });
  };

  const copy = async (b: PatientBookingFull) => {
    const s = ready ?? (await prepare());
    if (!s) {
      toast.error(CONTACT_MENU_COPY.rowUnavailable);
      return;
    }
    try {
      await navigator.clipboard.writeText(reminderOf(s, b).text);
      toast.success("Recordatorio copiado");
    } catch {
      toast.error(CONTACT_MENU_COPY.copyFailed, { description: CONTACT_MENU_COPY.copyFailedDetail });
    }
  };

  return { prepare, whatsApp, copy };
}

/** Turnos tab columns: Fecha+hora · Servicio · Obra social · Copago · Duración · Estado · acciones. */
const TURNOS_COLS = "120px 1.2fr 1fr 90px 72px 96px 40px";
/** Nivel `admin`: copago y OS con su estado de cobro, y "Ver en agenda" en vez del menú. */
const TURNOS_COLS_ADMIN = "120px 1.2fr 1.1fr 1.1fr 72px 96px 90px";
/**
 * P3.Z (F3b): con 7 columnas la grilla superaba los 360 px de un teléfono
 * dentro de una Card con `overflow:hidden` y "Ver en agenda" quedaba cortado.
 * Desde 768 la tabla scrollea DENTRO de la card; B4b: bajo 768 cada fila es una
 * card con rótulos (`profile-table.module.css`), sin scroll de costado.
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
/**
 * TP-3k (§25.1 #2, decisión 2 del 19-oct): confirmación de «Cancelar turno» cuando el turno tiene una seña cobrada por
 * Mercado Pago (`Booking.onlineDepositCents`, escalar que ya trae la fila: 0 sentencias). Los reintegros se hacen
 * desde Mercado Pago, la app no devuelve plata; después del cancelar el `notice` del server lo repite en el toast.
 * Texto literal de `depositRefundNotice` (`lib/online-charge-logic.ts`) y no un import: ese módulo arrastra la decisión
 * del turnero y el saneo del comprobante, y `/pacientes/[id]` tiene techo +0 en T5 (ver `lib/booking-collect.ts`).
 * El test `[TP-3k]` fija que los textos son iguales. `null` = sin seña: se cancela en un click, como antes.
 */
export function turnosDepositCancelConfirm(b: { onlineDepositCents?: number | null }): {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "danger";
} | null {
  const cents = b.onlineDepositCents;
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0) return null;
  return {
    title: "¿Cancelar este turno?",
    message: `Este turno tiene una seña de ${formatARS(cents)}: si corresponde, reintegrala desde Mercado Pago.`,
    confirmLabel: "Cancelar turno",
    cancelLabel: "Volver",
    tone: "danger",
  };
}

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
  /** CF3 (SH-U): nombre de pila para el recordatorio por fila si el bundle no llega (el bundle trae el suyo). */
  patientFirstName?: string;
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
  patientFirstName = "",
}: TurnosViewProps) {
  const readOnly = readOnlyProp || admin;
  const toast = useToast();
  const share = useRowShare(patientId, patientFirstName);
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
      {/* PF1-Z-F2: un solo <a> con aspecto de botón (antes <Link><Button/></Link>: <button> dentro de <a>). */}
      <ButtonLink href={`/agenda?new=1&patient=${patientId}`} variant="primary" className={heroStyles.action}>
        <IconPlus size={14} /> Nuevo turno
      </ButtonLink>
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
  const setStatus = async (b: PatientBookingFull, status: PatientBookingFull["status"]) => {
    // TP-3k: cancelar un turno con seña pide confirmación con el aviso de reintegro ANTES (sin seña sigue en un
    // click, como siempre). Va antes del optimismo: si vuelve, la fila no se toca.
    const depositConfirm = status === "CANCELLED" && b.status !== "CANCELLED" ? turnosDepositCancelConfirm(b) : null;
    if (depositConfirm && !(await confirm(depositConfirm))) return;
    const prevStatus = b.status;
    const expected = versionOf(b);
    patchBooking(b.id, { status });
    start(async () => {
      // Una confirmación por aviso forzable (bloqueo, fuera de horario, cupo,
      // tope por intervalo de T3, paciente superpuesto, sala), acumulando los
      // flags; un aviso ya aceptado que vuelve es error real. T3e-2u2: antes era
      // un `for` fijo de 5 intentos que, con 6 clases, podía salir sin la última
      // llamada y revertir la fila en silencio (ver `retryWithForce`).
      const out = await retryWithForce((force) => setBookingStatus(b.id, status, expected, force), confirm, "reactivate");
      if (out.kind === "ok") {
        patchBooking(b.id, { updatedAt: new Date(out.result.data.updatedAt) });
        // S12/C4 + T3 (C-AS3): aviso no bloqueante (sesión del plan, 2.º turno del intervalo).
        const info = successInfoText(out.result);
        if (info) toast.info(info);
        return;
      }
      if (out.kind === "error") toast.error("No pudimos actualizar el turno", { description: out.error });
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

  const tableVars = {
    "--pt-cols": admin ? TURNOS_COLS_ADMIN : TURNOS_COLS,
    "--pt-min-w": `${admin ? TURNOS_MIN_WIDTH_ADMIN : TURNOS_MIN_WIDTH}px`,
  } as CSSProperties;
  const columnsHeader = (
    <div className={tableStyles.head} style={{ padding: "12px 18px", gap: 14, fontSize: 10, fontWeight: 700, color: "var(--navy-300)", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
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
    <div data-testid="profile-table-scroll" className={tableStyles.scroller} style={tableVars}>
      <div className={tableStyles.inner}>{children}</div>
    </div>
  );
  const row = (b: PatientBookingFull, plan: PlanGroupMeta | null) => {
    const d = new Date(b.scheduledFor);
    const cancelled = b.status === "CANCELLED";
    const ord = plan ? bookingPlanOrdinal(b, plan) : null;
    const billable = isBillableBooking(b);
    // CF3 (SH-U): futuros y no cancelados/ausentes; sin acceso de escritura sigue (la Secretaria es quien más manda).
    const rowShare = isShareableRow(b, now)
      ? { onOpen: () => void share.prepare(), onWhatsApp: () => share.whatsApp(b), onCopy: () => void share.copy(b) }
      : null;
    return (
      <div
        key={b.id}
        data-testid="turno-row"
        data-plan={b.programId ?? undefined}
        className={tableStyles.row}
        style={{ padding: "14px 18px", gap: 14, alignItems: "center", fontSize: 13, borderBottom: "1px solid rgba(15,30,51,0.04)", opacity: cancelled ? 0.55 : 1 }}
      >
        <span className="k-mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-700)" }}>
          {d.toLocaleString("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Argentina/Buenos_Aires" })}
        </span>
        <span data-label="Servicio" className={tableStyles.wide} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          {ord && plan && (
            <DisciplineChip discipline={plan.discipline} ordinal={ord.ordinal} totalLive={ord.totalLive} size="xs" />
          )}
          <span style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.serviceName}</span>
        </span>
        <span data-label="Obra social" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", color: "var(--navy-500)", fontSize: 12, minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {b.obraSocial.toLowerCase() === "particular" ? "—" : b.obraSocial}
          </span>
          {admin && billable && b.osAmountCents > 0 && (
            <Tag tone={b.insurerPaidAt ? "lime" : "soft"}>{b.insurerPaidAt ? "OS cobrada" : "OS pendiente"}</Tag>
          )}
        </span>
        <span data-label="Copago" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)", fontWeight: 600 }}>{formatARS(b.copagoCents)}</span>
          {admin && (billable || b.paymentStatus === "PAID") && (
            <Tag tone={b.paymentStatus === "PAID" ? "lime" : "soft"}>{b.paymentStatus === "PAID" ? "Cobrado" : "Pendiente"}</Tag>
          )}
        </span>
        <span data-label="Duración" className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>{b.durationMin} min</span>
        <span data-label="Estado">
          <BookingStatusTag status={b.status} />
        </span>
        {/* B4b: la acción es la última celda en escritorio y va arriba a la derecha de la card bajo 768 (`.actions`). */}
        <span className={tableStyles.actions} style={{ justifySelf: "end" }}>
          {readOnly ? (
            admin && rowShare ? (
              <TurnoActionsMenu booking={b} share={rowShare} disabled={false} admin />
            ) : admin ? (
              <Link
                href={`/agenda?view=timeline&date=${toARDateKey(d)}`}
                style={{ fontSize: 12, fontWeight: 600, color: "var(--sky-700)", textDecoration: "none" }}
              >
                Ver en agenda
              </Link>
            ) : null
          ) : (
            <TurnoActionsMenu
              booking={b}
              onStatus={(s) => void setStatus(b, s)}
              onDelete={canDeleteFromProfile(b) ? () => void remove(b) : undefined}
              disabled={pending}
              share={rowShare}
            />
          )}
        </span>
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

/** Ítems del menú por fila que pueden tomar foco (los deshabilitados se saltean). */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
}

type RowShareActions = { onOpen: () => void; onWhatsApp: () => void; onCopy: () => void };

function TurnoActionsMenu({
  booking,
  onStatus,
  onDelete,
  disabled,
  share = null,
  admin = false,
}: {
  booking: PatientBookingFull;
  /** Ausente (nivel `admin`) = sin cambios de estado: se operan en la agenda. */
  onStatus?: (s: PatientBookingFull["status"]) => void;
  /** Ausente = sin "Eliminar" (turno de plan, `canDeleteFromProfile`). */
  onDelete?: () => void;
  disabled: boolean;
  /** CF3 (SH-U): «Compartir por WhatsApp» / «Copiar recordatorio» (solo filas futuras no canceladas). */
  share?: RowShareActions | null;
  /**
   * CF3 (SH-U): nivel `admin`. «Ver en agenda» pasa a ser un menú «Opciones» con el compartir + «Ver en agenda» (antes
   * era el único link de la fila).
   */
  admin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  // CF3 ZF3 (revisor de UI): el menú no se manejaba con teclado (solo Esc global). Ahora como el del teléfono
  // (`contact-actions.tsx`) y `FichaMenu`: foco en el primer ítem al abrir, flechas/Home/End con `menuKeyStep`, Esc
  // cierra y devuelve el foco al botón, Tab cierra.
  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus();
  }, [open]);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const all = menuItems(menuRef.current);
    const step = menuKeyStep(e.key, all.indexOf(document.activeElement as HTMLElement), all.length);
    if (step === "close") {
      e.preventDefault();
      close(true);
    } else if (step === "tab") {
      close(false);
    } else if (typeof step === "number") {
      e.preventDefault();
      all[step]?.focus();
    }
  };

  const dateKey = toARDateKey(new Date(booking.scheduledFor));
  const itemStyle: React.CSSProperties = {
    width: "100%", textAlign: "left", border: "none", background: "transparent", cursor: "pointer",
    fontSize: 12.5, fontWeight: 600, color: "var(--navy-700)", padding: "8px 10px", borderRadius: 8,
    // B4b: flex (no block) para que el `min-height: 44px` de la fila bajo 768 centre el texto del ítem.
    display: "flex", alignItems: "center", boxSizing: "border-box", textDecoration: "none",
  };
  const Item = ({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) => (
    <button type="button" role="menuitem" tabIndex={-1} disabled={disabled} onClick={() => { setOpen(false); onClick(); }} style={{ ...itemStyle, color: danger ? "var(--danger-fg)" : "var(--navy-700)" }}>
      {label}
    </button>
  );
  const sep = <div role="none" style={{ height: 1, background: "rgba(15,30,51,0.08)", margin: "2px 0" }} />;

  return (
    <div ref={ref} style={{ position: "relative", justifySelf: "end" }}>
      <button
        ref={triggerRef}
        type="button"
        className={admin ? contactStyles.rowMenuTrigger : contactStyles.rowMenuDots}
        aria-label={admin ? CONTACT_MENU_COPY.rowMenuLabel : "Acciones del turno"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) share?.onOpen();
          setOpen((v) => !v);
        }}
        onPointerEnter={share?.onOpen}
        onFocus={share?.onOpen}
        style={
          admin
            ? { padding: "0 8px", borderRadius: 8, border: "none", background: open ? "rgba(15,30,51,0.06)" : "transparent", cursor: "pointer", color: "var(--sky-700)", fontSize: 12, fontWeight: 600 }
            : { borderRadius: 8, border: "none", background: open ? "rgba(15,30,51,0.06)" : "transparent", cursor: "pointer", color: "var(--navy-500)", fontSize: 18, lineHeight: 1, fontWeight: 700 }
        }
      >
        {admin ? `${CONTACT_MENU_COPY.rowMenu} ▾` : "⋯"}
      </button>
      {open && (
        <div ref={menuRef} role="menu" aria-label={admin ? CONTACT_MENU_COPY.rowMenuLabel : "Acciones del turno"} onKeyDown={onMenuKeyDown} className="k-glass-strong" style={{ position: "absolute", top: "calc(100% + 2px)", right: 0, width: 210, borderRadius: 12, padding: 6, zIndex: 30, display: "grid", gap: 2 }}>
          {onStatus && (
            <>
              <Item label="Confirmar" onClick={() => onStatus("CONFIRMED")} />
              <Item label="Marcar hecho" onClick={() => onStatus("COMPLETED")} />
              <Item label="Marcar ausente" onClick={() => onStatus("NO_SHOW")} />
              <Item label="Cancelar turno" onClick={() => onStatus("CANCELLED")} />
            </>
          )}
          {share && (
            <>
              {onStatus && sep}
              <Item label={CONTACT_MENU_COPY.rowShare} onClick={share.onWhatsApp} />
              <Item label={CONTACT_MENU_COPY.rowCopy} onClick={share.onCopy} />
            </>
          )}
          <Link href={`/agenda?view=timeline&date=${dateKey}`} role="menuitem" tabIndex={-1} style={itemStyle} onClick={() => setOpen(false)}>
            {admin ? CONTACT_MENU_COPY.rowAgenda : "Abrir en agenda"}
          </Link>
          {onDelete && (
            <>
              {sep}
              <Item label="Eliminar" onClick={onDelete} danger />
            </>
          )}
        </div>
      )}
    </div>
  );
}
