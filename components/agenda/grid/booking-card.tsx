"use client";

import { createContext, useContext, type CSSProperties } from "react";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { PAYMENT_HOLD_LABEL, paymentHoldState } from "@/lib/agenda-filters";
import { receptionCardBadge } from "@/lib/agenda-client-state";
import { highlightState, type AgendaHighlight } from "@/lib/agenda-highlight";
import { isOutOfPlan, planChip } from "@/lib/plan-display";
import type { Discipline } from "@/lib/plans-constants";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { fmtHour, type BookingDTO } from "../agenda-utils";
import { PractitionerBadge } from "./practitioner-badge";

// ─── Planes en la agenda (S19a, ES3 · V1-D18 · V2 de PLANES C13b) ────────────

/**
 * Lo que una tarjeta de turno muestra de Planes, en un solo lugar para que
 * Día/Por profesional (esta card), Lista, el modal de Semana y Recepción no
 * diverjan:
 *   - `chip`: solo disciplina, ordinal y total vivo de C9 (`Kine · 3/10`). El
 *     `title` del plan NO se copia (PHI, PD-11): aunque viniera en `b.plan`,
 *     de acá no sale.
 *   - `outOfPlan`: `isOutOfPlan` de `lib/plan-display.ts` (V2) tal cual; la
 *     regla (suelto, no cancelado, con paciente, plan ACTIVE vinculado de la
 *     misma disciplina) no se reimplementa acá.
 * Sin el módulo `planes` los campos C9 vienen neutros (`plan` null, `[]`) y
 * no se muestra nada; sin C9 (proyección completa, `undefined`) tampoco.
 */
export type BookingPlanMarks = {
  chip: { discipline: Discipline | null; ordinal: number; totalLive: number } | null;
  outOfPlan: boolean;
};

export function bookingPlanMarks(b: BookingDTO): BookingPlanMarks {
  const p = b.plan;
  return {
    chip: p ? { discipline: p.discipline, ordinal: p.ordinal, totalLive: p.totalLive } : null,
    outOfPlan: isOutOfPlan({
      programId: b.programId,
      status: b.status,
      hasPatient: b.patientId != null,
      serviceDiscipline: b.serviceDiscipline,
      patientActiveLinkedPlanDisciplines: b.patientActiveLinkedPlanDisciplines,
    }),
  };
}

/** Texto de los marks para tooltips / aria (canal de texto, no solo el chip). */
export function planMarksText(m: BookingPlanMarks): string | null {
  if (m.chip) return planChip(m.chip).ariaLabel;
  return m.outOfPlan ? "fuera de plan" : null;
}

/**
 * Conteo partido de una celda de Semana (plan §3.4: "En Semana, conteo
 * partido"). Solo cuenta lo que C9 dice: `programId` string = de plan, `null`
 * = suelto; `undefined` (sin C9) no se cuenta en ninguno. Sin ningún turno de
 * plan devuelve `null` y la celda queda como siempre (consultorio General,
 * paciente sin plan).
 *
 * Los cancelados no cuentan (P3.Z F3a), con la misma regla que la leyenda
 * (`countPlanScope`, `lib/agenda-filters.ts`): antes la celda decía "2 de
 * plan" y la leyenda "1" para la misma semana.
 */
export function planLooseSplit(
  bookings: readonly Pick<BookingDTO, "programId" | "status">[]
): { plan: number; loose: number } | null {
  let plan = 0;
  let loose = 0;
  for (const b of bookings) {
    if (b.status === "CANCELLED") continue;
    if (typeof b.programId === "string") plan += 1;
    else if (b.programId === null) loose += 1;
  }
  return plan > 0 ? { plan, loose } : null;
}

export function planLooseSplitText(s: { plan: number; loose: number }): string {
  const plan = `${s.plan} de plan`;
  return s.loose > 0 ? `${plan} · ${s.loose} ${s.loose === 1 ? "suelto" : "sueltos"}` : plan;
}

/**
 * "Fuera de plan" (V2): aviso en TEXTO (canal no cromático), borde punteado y
 * neutro para no competir con el fondo de estado ni con "Sobreturno". Es un
 * aviso, no un error: no bloquea nada.
 */
export function OutOfPlanTag({ style }: { style?: CSSProperties }) {
  return (
    <span data-badge="fuera-de-plan" style={{ ...miniBadge, ...outOfPlanStyle, ...style }}>
      Fuera de plan
    </span>
  );
}

const outOfPlanStyle: CSSProperties = {
  color: "var(--navy-700)",
  background: "transparent",
  border: "1px dashed rgba(15,30,51,0.4)",
  lineHeight: "12px",
};

/** Chip + aviso juntos (Lista, modal de Semana, Recepción). `null` si no hay nada. */
export function PlanMarks({ b, size = "xs" }: { b: BookingDTO; size?: "xs" | "sm" }) {
  const m = bookingPlanMarks(b);
  if (!m.chip && !m.outOfPlan) return null;
  return (
    <>
      {m.chip && <DisciplineChip {...m.chip} size={size} />}
      {m.outOfPlan && <OutOfPlanTag />}
    </>
  );
}

/**
 * Card de un turno en la grilla de la agenda (B1.5b: sale de
 * `views/timeline-view.tsx`).
 *
 * La usan la vista Día (`timeline-view`) y la vista por profesional
 * (`grid/slot-cell`); la vista Semana pinta un chip con el conteo por celda y
 * abre la lista en un modal.
 *
 * Código de color de la agenda (AGENTS §5): la barra lateral es el servicio, el
 * fondo es el estado y la opacidad es el filtro (leyenda de servicios).
 *
 * Contrato:
 * - `b`: el turno; `onEdit(b)` al click (abre el drawer).
 * - `highlight`: resaltado de la leyenda (`lib/agenda-highlight.ts`: servicio,
 *   plan o suelto); con valor, la card que coincide se levanta y el resto se
 *   atenúa; `null` = sin filtro.
 * - `compact`: densidad compacta (menos padding).
 * - `sizing`: cómo se acomoda en su contenedor flex (base / grow / shrink /
 *   min / max). El día usa `timelineCardSizing`; otra grilla (p. ej. una
 *   columna por profesional) pasa el suyo. Todo lo demás es fijo.
 * - `practitioner` (B4.3): iniciales del profesional; solo se pasa cuando hay
 *   más de un profesional en pantalla (`showPractitionerInitials`). Canal NO
 *   cromático (AGENTS §5): el color ya es del servicio y del estado.
 * - `now` (B4.3): reloj del caller (se refresca cada minuto) para "En sala 12′"
 *   y la reserva pública vencida. Sin él, `new Date()` al render (como antes).
 * - `room` (SR): sala del turno, "· Consultorio 2" en la segunda línea (aria
 *   "en Consultorio 2"). Solo texto, sin color nuevo (canal no cromático). El
 *   caller la pasa SOLO cuando aporta (`showRoomOnCards`: 2 o más salas, fuera
 *   de "Por sala" y sin filtro de sala); sin ella el markup es el de siempre.
 *
 * - `flash` (SV09): el turno acaba de cambiar por OTRA sesión (agenda en
 *   vivo). Pone `data-flash` + la clase `k-flash` (`app/globals.css`, SV03u):
 *   el fondo arranca en `--sky-100` y vuelve a su color en 600 ms. Es una
 *   animación CSS, no una transición: las animaciones pisan el `background`
 *   inline sin tocarlo, y por eso la card NO suma `background` a su
 *   `transition` (la transición re-animaría cada cambio de estado). Sin
 *   `flash` el markup es el de siempre. Si no viene por prop se lee de
 *   `BookingFlashContext`: así `AgendaClient` marca las cards sin pasar el
 *   flag por cada vista (Día, Por profesional, Por sala).
 *
 * Badges de B4.3 (todos con texto, no solo color): "Sobreturno"
 * (`isOverbooked`), recepción ("En sala 12′" / "Llamado" (SV09) / "En atención") y telemedicina
 * (ícono de cámara con `aria-label`). Planes (S19a): chip `Kine · 3/10` y
 * "Fuera de plan" (`bookingPlanMarks`, arriba). Con `clinicalHidden` (sin
 * `clinical.read`) no se muestra título/descripción aunque viniera algo.
 */
/**
 * Ids de los turnos que cambiaron por otra sesión hace menos de `FLASH_MS`
 * (SV09). Lo provee `AgendaClient`; `null` (sin provider) = ninguno.
 */
export const BookingFlashContext = createContext<ReadonlySet<string> | null>(null);

/**
 * Colores del badge de recepción. "Llamado" usa los tokens `--rc-called-*`
 * (SV03u, contraste AA probado en `design-tokens.test.ts`), los mismos que la
 * vista Recepción: el mismo estado se ve igual en las dos pantallas.
 */
const RECEPTION_BADGE_STYLE: Record<"en-sala" | "llamado" | "en-atencion", CSSProperties> = {
  "en-sala": { color: "var(--navy-900)", background: "rgba(15,30,51,0.08)" },
  llamado: { color: "var(--rc-called-fg)", background: "var(--rc-called-bg)" },
  "en-atencion": { color: "#fff", background: "var(--navy-700)" },
};

/**
 * Fondo y borde de un turno según su ESTADO (AGENTS §5: el fondo es el estado). Lo comparten la card y las líneas
 * compactas de la Semana (G2, PF1.1) para que un «Ausente» se lea igual en todas las vistas. Colores de token
 * (C-PF5.2): antes eran rgba sueltos de la familia verde/roja/ámbar con alfas fuera del token.
 */
export function bookingStatusTone(
  status: BookingDTO["status"],
  expiredHold: boolean
): { background: string; border: string } {
  if (expiredHold) return { background: "rgba(15,30,51,0.03)", border: "1px dashed rgba(15,30,51,0.3)" };
  switch (status) {
    case "CANCELLED":
      return { background: "var(--danger-bg)", border: "1px solid var(--danger-border)" };
    case "NO_SHOW":
      return { background: "var(--warn-bg)", border: "1px solid var(--warn-border)" };
    case "COMPLETED":
      return { background: "var(--success-bg)", border: "1px solid var(--success-border)" };
    default:
      return { background: "rgba(255,255,255,0.85)", border: "1px solid rgba(31,79,190,0.12)" };
  }
}

export type BookingCardSizing = Pick<
  CSSProperties,
  "flexBasis" | "flexGrow" | "flexShrink" | "minWidth" | "maxWidth"
>;

export function BookingCard({
  b,
  onEdit,
  highlight,
  compact,
  sizing,
  practitioner = null,
  now,
  room = null,
  flash,
  showEnd = false,
}: {
  b: BookingDTO;
  onEdit: (b: BookingDTO) => void;
  highlight: AgendaHighlight | null;
  compact: boolean;
  sizing: BookingCardSizing;
  practitioner?: { initials: string; name: string } | null;
  now?: Date;
  room?: { name: string } | null;
  flash?: boolean;
  /** G3 (PF1.1): «08:00–08:45» en vez de «08:00». Solo el Día (cards en fila por franja); en columnas no entra. */
  showEnd?: boolean;
}) {
  const flashIds = useContext(BookingFlashContext);
  const isFlashing = flash ?? flashIds?.has(b.id) ?? false;
  const date = new Date(b.scheduledFor);
  const clock = now ?? new Date();
  const isCancelled = b.status === "CANCELLED";
  const isDone = b.status === "COMPLETED";
  const isNoShow = b.status === "NO_SHOW";
  // Reserva pública impaga (A2b-S-ui): vencida a los 30 min → ya no retiene el
  // horario. Se ve lavada y con borde punteado (fondo = estado) y con el texto
  // explícito, para que la recepción sepa que puede dar ese horario.
  const hold = paymentHoldState(b, clock);
  const reception = receptionCardBadge(b, clock);
  const isExpiredHold = hold === "vencida";
  const tone = bookingStatusTone(b.status, isExpiredHold);
  // G3 (VX0-b): la card dice el FIN («08:00–08:45»). Las cards van en fila por franja, no proporcionales a la
  // duración: sin el fin, un 08:45 de 15′ parecía simultáneo al 08:00 de 45′ de al lado.
  const end = new Date(date.getTime() + b.durationMin * 60_000);

  // Left bar = the service's colour (identity); state is conveyed by the
  // card's tint / opacity / strike-through.
  const barColor = b.serviceColor ?? SERVICE_COLOR_FALLBACK;
  // Legend "filter": lift the matching cards, dim the rest.
  const hl = highlightState(highlight, b);
  const isHighlighted = hl === "match";
  const dimmed = hl === "dimmed";
  // Card subtitle: the mini-diagnosis (title), falling back to the longer
  // description — whichever the kine filled. Never the service name.
  // Sin `clinical.read` el server ya manda null; el gate se repite acá para que
  // un DTO de otra proyección nunca filtre contenido clínico a la Secretaria.
  const cardLabel = b.clinicalHidden ? null : b.title || b.description;
  // Planes (S19a): chip en la primera línea (junto al paciente) y "Fuera de
  // plan" en la segunda, con los otros badges de texto.
  const marks = bookingPlanMarks(b);
  const extras = [
    b.isOverbooked ? "sobreturno" : null,
    reception?.label ?? null,
    b.isTelemedicine ? "telemedicina" : null,
    practitioner ? practitioner.name : null,
    room ? `en ${room.name}` : null,
    planMarksText(marks),
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={() => onEdit(b)}
      className={isFlashing ? "k-flash" : undefined}
      data-flash={isFlashing ? "true" : undefined}
      title={`${fmtHour(date)} · ${b.durationMin} min · ${b.patientName}${hold ? ` · ${PAYMENT_HOLD_LABEL[hold]}` : ""}${extras.length ? ` · ${extras.join(" · ")}` : ""}${cardLabel ? ` · ${cardLabel}` : ""}`}
      style={{
        ...sizing,
        borderRadius: 12,
        padding: compact ? "6px 9px" : "8px 10px",
        background: tone.background,
        border: tone.border,
        boxShadow: isHighlighted ? "var(--shadow-card-lg)" : "0 2px 6px rgba(15,30,51,0.04)",
        color: "var(--navy-900)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        opacity: isCancelled ? 0.6 : dimmed ? 0.55 : isDone || isExpiredHold ? 0.85 : 1,
        cursor: "pointer",
        textDecoration: isCancelled ? "line-through" : "none",
        textAlign: "left",
        overflow: "hidden",
        transform: isHighlighted ? "translateY(-2px)" : undefined,
        transition: "transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease",
      }}
    >
      <div
        style={{
          width: 3,
          alignSelf: "stretch",
          minHeight: 26,
          borderRadius: 2,
          background: barColor,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
          <span
            className="k-mono"
            style={{ fontSize: 10, color: "var(--sky-700)", fontWeight: 600, flexShrink: 0 }}
          >
            {fmtHour(date)}
            {showEnd && <>–{fmtHour(end)}</>}
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {b.patientName}
          </span>
          {b.isTelemedicine && <VideoIcon />}
          {/* Chip del plan: no se encoge (el que cede es el nombre, con
              ellipsis). En "Por profesional" es una pill con borde y
              disciplina, distinta de la ocupación "2/3" de la celda (mono,
              sin borde). */}
          {marks.chip && <DisciplineChip {...marks.chip} size="xs" />}
          {practitioner && (
            <PractitionerBadge
              initials={practitioner.initials}
              name={practitioner.name}
              size={compact ? 18 : 20}
              style={{ marginLeft: "auto" }}
            />
          )}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--navy-500)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "flex",
            gap: 4,
          }}
        >
          {/* Duration FIRST and unshrinkable: card height is no longer
              proportional to it, and putting it last let the ellipsis eat it. */}
          <span className="k-mono" style={{ flexShrink: 0 }}>{b.durationMin}′</span>
          {room && (
            <span
              data-room
              style={{ flexShrink: 1, minWidth: 0, maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              <span aria-hidden="true">· </span>
              <span style={visuallyHidden}>en </span>
              {room.name}
            </span>
          )}
          {b.isOverbooked && (
            <span data-badge="sobreturno" style={{ ...miniBadge, color: "var(--warn-fg)", background: "var(--warn-bg-strong)" }}>
              Sobreturno
            </span>
          )}
          {marks.outOfPlan && <OutOfPlanTag />}
          {reception && (
            <span
              data-badge={reception.kind}
              style={{ ...miniBadge, ...RECEPTION_BADGE_STYLE[reception.kind] }}
            >
              {reception.label}
            </span>
          )}
          {hold && (
            <span
              style={{
                flexShrink: 0,
                fontWeight: 700,
                color: isExpiredHold ? "var(--navy-500)" : "var(--warn-fg)",
              }}
            >
              · {PAYMENT_HOLD_LABEL[hold]}
            </span>
          )}
          {cardLabel && (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              · {cardLabel}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/** Texto solo para lectores de pantalla ("en Consultorio 2" en vez de "punto Consultorio 2"). */
const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const miniBadge: CSSProperties = {
  flexShrink: 0,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  borderRadius: 999,
  padding: "0 5px",
  lineHeight: "14px",
};

/** Cámara (telemedicina). Inline: `components/ui/icons.tsx` no tiene una. */
function VideoIcon() {
  return (
    <svg
      role="img"
      aria-label="Telemedicina"
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, color: "var(--sky-700)" }}
    >
      <title>Telemedicina</title>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="m16 10 6-3v10l-6-3" />
    </svg>
  );
}
