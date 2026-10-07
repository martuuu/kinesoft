"use client";

import type { CSSProperties } from "react";
import { toARDateKey, toARDow, toARMinutes } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import { disciplineShortLabel, planSessionOrdinals } from "@/lib/plan-display";
import { summarizePlanSchedule } from "@/lib/plan-schedule";
import type {
  PlanForceFlags,
  PlanPreview,
  PlanPreviewRow,
  PlanPricingInput,
  PlanResolutionKind,
  PlanRowResolution,
  PlanScheduleV1,
} from "@/lib/plans-types";
import type { PlanPreviewTableProps, PlanResolutionsByIndex } from "@/components/planes/plan-editor-types";

/**
 * "Revisá los turnos" (S18p, ES3 · C13 literal): tabla
 * `# · lun 06/10 · 09:00 · Estado · Resolución` + resumen arriba.
 *
 * NO llama actions ni re-implementa reglas del motor: pinta lo que trae el
 * `PlanPreview` (`classifyPlanRows` en el server) y le devuelve al editor
 * (S18) la resolución elegida por fila. En particular:
 *   - las opciones salen de `allowedResolutions` del preview. Para quien solo
 *     agenda (Secretaria), el server ya mandó `scheduleOnlyPreview` (sin
 *     `adopt` ni `mark-done`): la tabla no las inventa;
 *   - "Mover a …" solo existe con `suggestion` (sin hueco no hay destino);
 *   - "forzar" solo cubre flags forzables (cupo, fuera de horario,
 *     superposición). Un bloqueo nunca se fuerza: aunque viniera `force` en
 *     las permitidas, con `blocked` se descarta (defensa en profundidad: el
 *     motor igual lo rechazaría y la fila quedaría stale);
 *   - el resumen se cuenta con las resoluciones LOCALES (las elegidas o las de
 *     defecto), para que acompañe al select sin esperar el re-preview. Los
 *     avisos de autorización de la OS son los del preview (dependen del orden
 *     de la corrida en el server) y solo aparecen si las flags vienen (E2:
 *     ausentes = sin autorización o el actor no la puede ver).
 *
 * Fechas siempre en hora AR (`lib/datetime-ar.ts`, safe en Vercel/UTC). Plata
 * con `formatARS`. Estado = chip neutro con glifo + texto (canal no cromático;
 * el color no agrega significado). Mobile: la tabla scrollea sola, la página
 * no.
 */

// ─── Copy (C13) ──────────────────────────────────────────────────────────────

export const PLAN_PREVIEW_STALE_COPY =
  "La agenda cambió mientras armabas el plan. Revisá las filas marcadas y confirmá de nuevo.";

const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;
const pad2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
/** "2026-10-06" → "06/10" (string puro: un DayKey ya es AR). */
const ddmm = (dayKey: string) => `${dayKey.slice(8, 10)}/${dayKey.slice(5, 7)}`;

/** Día y hora AR de un instante: `{day: "lun 06/10", time: "09:00"}`. */
export function planRowDateLabel(iso: string): { day: string; time: string } {
  return {
    day: `${DOW_SHORT[toARDow(iso)]} ${ddmm(toARDateKey(iso))}`,
    time: hhmm(toARMinutes(iso)),
  };
}

// ─── Estado ──────────────────────────────────────────────────────────────────

export type PlanRowStatusKind = "free" | "capacity" | "out-of-hours" | "blocked" | "overlap" | "past" | "duplicate";

const STATUS_GLYPH: Record<PlanRowStatusKind, string> = {
  free: "✓",
  capacity: "+",
  "out-of-hours": "◷",
  blocked: "⊘",
  overlap: "⧉",
  past: "↺",
  duplicate: "=",
};

/**
 * Estado C13 de la fila en el instante PLANIFICADO, con la precedencia del
 * motor (enmienda ES1): duplicado > pasado > bloqueado > fuera de horario >
 * superposición del paciente > cupo > libre.
 *
 * `blockReason`: `PlanPreviewRow` hoy no lo trae (solo `flags.blocked`), así
 * que sale "Bloqueado" a secas; si el preview lo suma, sale "Bloqueado: <motivo>"
 * sin tocar la tabla (ver handoff en el reporte de S18p).
 */
export function planRowStatus(row: PlanPreviewRow & { blockReason?: string | null }): {
  kind: PlanRowStatusKind;
  label: string;
  glyph: string;
} {
  const f = row.flags;
  let kind: PlanRowStatusKind;
  let label: string;
  if (f.duplicate) [kind, label] = ["duplicate", "Ya tiene un turno a esa hora"];
  else if (f.past) [kind, label] = ["past", "Ya pasó"];
  else if (f.blocked) [kind, label] = ["blocked", row.blockReason ? `Bloqueado: ${row.blockReason}` : "Bloqueado"];
  else if (f.outOfHours) [kind, label] = ["out-of-hours", "Fuera de horario"];
  else if (f.patientOverlapIds.length > 0) [kind, label] = ["overlap", "Se superpone con otro turno del paciente"];
  else if (f.capacityFull) [kind, label] = ["capacity", "Sobreturno"];
  else [kind, label] = ["free", "Libre"];
  return { kind, label, glyph: STATUS_GLYPH[kind] };
}

// ─── Resoluciones ────────────────────────────────────────────────────────────

/** Las flags forzables presentes en la fila (lo que tiene que cubrir `force`). */
function forceFlagsOf(row: PlanPreviewRow): PlanForceFlags | null {
  const f = row.flags;
  if (f.blocked || f.past) return null;
  const force: PlanForceFlags = {};
  if (f.capacityFull) force.capacity = true;
  if (f.outOfHours) force.outOfHours = true;
  if (f.patientOverlapIds.length > 0) force.patientOverlap = true;
  return Object.keys(force).length > 0 ? force : null;
}

/** La resolución completa de un `kind` para esta fila; null si no aplica. */
function buildResolution(row: PlanPreviewRow, kind: PlanResolutionKind): PlanRowResolution | null {
  const index = row.index;
  switch (kind) {
    case "create":
    case "none":
      return { index, kind };
    case "move":
      return row.suggestion ? { index, kind, at: row.suggestion } : null;
    case "force": {
      const force = forceFlagsOf(row);
      return force ? { index, kind, force } : null;
    }
    case "adopt": {
      const d = row.flags.duplicate;
      return d?.adoptable ? { index, kind, bookingId: d.bookingId, expectedUpdatedAt: d.updatedAt } : null;
    }
    case "mark-done":
      return row.flags.past ? { index, kind } : null;
  }
}

export type PlanResolutionOption = { value: PlanResolutionKind; label: string; resolution: PlanRowResolution };

function optionLabel(row: PlanPreviewRow, r: PlanRowResolution): string {
  switch (r.kind) {
    case "create":
      return "Crear";
    case "move": {
      const { day, time } = planRowDateLabel(r.at!);
      return `Mover a ${day} · ${time}`;
    }
    case "force":
      // Con cupo lleno el turno queda `isOverbooked`: se dice. Si solo es
      // horario/superposición, "Crear igual".
      return row.flags.capacityFull ? "Crear como sobreturno" : "Crear igual";
    case "adopt":
      return "Usar el turno existente";
    case "none":
      return "Dejar sin turno";
    case "mark-done":
      return "Marcar como realizada";
  }
}

const OPTION_ORDER: PlanResolutionKind[] = ["create", "adopt", "move", "force", "mark-done", "none"];

/** Opciones del select de la fila, en orden fijo, solo las que el preview permite y tienen con qué armarse. */
export function resolutionOptions(row: PlanPreviewRow): PlanResolutionOption[] {
  const allowed = new Set(row.allowedResolutions);
  const out: PlanResolutionOption[] = [];
  for (const kind of OPTION_ORDER) {
    if (!allowed.has(kind)) continue;
    const resolution = buildResolution(row, kind);
    if (resolution) out.push({ value: kind, label: optionLabel(row, resolution), resolution });
  }
  return out;
}

/** La elegida por el usuario o, si no hay, la de defecto del preview (armada completa). */
export function effectiveRowResolution(row: PlanPreviewRow, resolutions: PlanResolutionsByIndex): PlanRowResolution {
  return resolutions[row.index] ?? buildResolution(row, row.defaultResolution) ?? { index: row.index, kind: "none" };
}

// ─── Resumen ─────────────────────────────────────────────────────────────────

export type PreviewTableCounts = {
  sessions: number;
  /** create + force: "turnos nuevos". */
  created: number;
  moved: number;
  adopted: number;
  markDone: number;
  none: number;
  /** Turnos que se crean (create + force + move): el "Crear plan y N turnos". */
  bookings: number;
  /** Primer/último día AR efectivo (el de destino si se mueve). */
  firstDayKey: string | null;
  lastDayKey: string | null;
  /** E2: solo si el preview trae las flags. */
  overAuthorization: number;
  afterExpiry: number;
};

export function previewTableCounts(preview: PlanPreview, resolutions: PlanResolutionsByIndex): PreviewTableCounts {
  const c: PreviewTableCounts = {
    sessions: preview.rows.length,
    created: 0,
    moved: 0,
    adopted: 0,
    markDone: 0,
    none: 0,
    bookings: 0,
    firstDayKey: null,
    lastDayKey: null,
    overAuthorization: 0,
    afterExpiry: 0,
  };
  for (const row of preview.rows) {
    const r = effectiveRowResolution(row, resolutions);
    if (r.kind === "create" || r.kind === "force") c.created++;
    else if (r.kind === "move") c.moved++;
    else if (r.kind === "adopt") c.adopted++;
    else if (r.kind === "mark-done") c.markDone++;
    else c.none++;
    const dayKey = r.kind === "move" && r.at ? toARDateKey(r.at) : row.dayKey;
    if (c.firstDayKey === null || dayKey < c.firstDayKey) c.firstDayKey = dayKey;
    if (c.lastDayKey === null || dayKey > c.lastDayKey) c.lastDayKey = dayKey;
    if (row.flags.overAuthorization === true) c.overAuthorization++;
    if (row.flags.afterAuthorizationExpiry === true) c.afterExpiry++;
  }
  c.bookings = c.created + c.moved;
  return c;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function pricingSummary(pricing: PlanPricingInput): string {
  if (!pricing) return "Sin precio · sigue la cobertura";
  return pricing.mode === "PACKAGE"
    ? `Paquete ${formatARS(pricing.totalPriceCents)}`
    : `Por sesión ${formatARS(pricing.pricePerSessionCents)}`;
}

/** C13: "10 sesiones · 8 turnos nuevos · 1 movido · 1 sin turno · lun y jue 09:00 · 06/10 → 13/11 · Paquete $120.000". */
export function planPreviewSummaryLine(
  c: PreviewTableCounts,
  schedule: PlanScheduleV1 | null,
  pricing: PlanPricingInput
): string {
  const parts = [plural(c.sessions, "sesión", "sesiones"), plural(c.created, "turno nuevo", "turnos nuevos")];
  if (c.moved) parts.push(plural(c.moved, "movido", "movidos"));
  if (c.adopted) parts.push(plural(c.adopted, "con turno existente", "con turnos existentes"));
  if (c.markDone) parts.push(plural(c.markDone, "realizada", "realizadas"));
  if (c.none) parts.push(`${c.none} sin turno`);
  if (schedule) parts.push(summarizePlanSchedule(schedule));
  if (c.firstDayKey && c.lastDayKey) parts.push(`${ddmm(c.firstDayKey)} → ${ddmm(c.lastDayKey)}`);
  parts.push(pricingSummary(pricing));
  return parts.join(" · ");
}

// ─── Ordinal (M13) ───────────────────────────────────────────────────────────

/** Lo mínimo de una sesión del plan para calcular ordinales (`PlanSessionDTO` alcanza). */
export type PreviewOrdinalSession = {
  id: string;
  index: number;
  scheduledFor: Date | string;
  archivedAt: Date | string | null;
};

/**
 * `ordinalOf` de la tabla para generar / re-planificar / agregar (P3.Z F2):
 * la tabla mostraba `row.index` (fijo, M13) y con una sesión archivada
 * "Generar pendientes" decía 4…10 donde la card cuenta 3…9.
 *
 *   - Con `sessions` (del `PlanDTO` o del detalle): cada fila pisa la fecha de
 *     su sesión con la del preview (re-planificar mueve fechas) y las filas
 *     nuevas (sin `sessionId`: agregar) entran como sesiones virtuales; el
 *     ordinal sale de `planSessionOrdinals` (el mismo cálculo del server).
 *   - Sin `sessions` pero con `totalLive` (agregar al final, sin detalle): las
 *     filas nuevas van después de las vivas, en orden de fecha.
 *   - Lo que no se puede calcular → `null` (la tabla cae a `row.index`).
 */
export function planPreviewOrdinalOf(
  preview: PlanPreview,
  ctx: { sessions?: readonly PreviewOrdinalSession[] | null; totalLive?: number | null }
): (row: PlanPreviewRow) => number | null {
  const rowKey = (r: PlanPreviewRow) => `row:${r.index}`;
  if (ctx.sessions) {
    const byId = new Map(ctx.sessions.map((s) => [s.id, s]));
    const atBySession = new Map<string, string>();
    const virtual: PreviewOrdinalSession[] = [];
    for (const r of preview.rows) {
      if (r.sessionId && byId.has(r.sessionId)) atBySession.set(r.sessionId, r.at);
      else virtual.push({ id: rowKey(r), index: r.index, scheduledFor: r.at, archivedAt: null });
    }
    const all = [...ctx.sessions.map((s) => (atBySession.has(s.id) ? { ...s, scheduledFor: atBySession.get(s.id)! } : s)), ...virtual];
    const ords = planSessionOrdinals(all);
    return (r) => ords.get(r.sessionId && byId.has(r.sessionId) ? r.sessionId : rowKey(r)) ?? null;
  }
  if (ctx.totalLive != null) {
    const base = ctx.totalLive;
    const fresh = preview.rows
      .filter((r) => !r.sessionId)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.index - b.index);
    const ords = new Map(fresh.map((r, i) => [r.index, base + i + 1]));
    return (r) => (r.sessionId ? null : ords.get(r.index) ?? null);
  }
  return () => null;
}

// ─── Componente ──────────────────────────────────────────────────────────────

const cell: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--navy-100)",
  textAlign: "left",
  verticalAlign: "top",
  fontSize: 13,
  color: "var(--navy-900)",
};
const head: CSSProperties = {
  ...cell,
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--navy-500)",
  background: "var(--bg-panel)",
  whiteSpace: "nowrap",
};
const note: CSSProperties = { display: "block", marginTop: 4, fontSize: 12, color: "var(--navy-500)" };
const notice: CSSProperties = {
  margin: 0,
  padding: "8px 12px",
  borderRadius: "var(--r-sm)",
  border: "1px solid var(--navy-200)",
  background: "var(--card-bg)",
  fontSize: 13,
  color: "var(--navy-900)",
};

export function PlanPreviewTable({
  preview,
  resolutions,
  onResolutionChange,
  staleIndexes,
  schedule,
  pricing,
  disabled,
  ordinalOf,
}: PlanPreviewTableProps) {
  const counts = previewTableCounts(preview, resolutions);
  const showPrice = preview.rows.some((r) => r.priceCents != null);

  return (
    <section aria-label="Revisá los turnos" style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      {staleIndexes != null && (
        <p role="alert" style={{ ...notice, borderColor: "var(--navy-700)", fontWeight: 600 }}>
          <span aria-hidden="true">! </span>
          {PLAN_PREVIEW_STALE_COPY}
        </p>
      )}

      <p aria-live="polite" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>
        {planPreviewSummaryLine(counts, schedule, pricing)}
      </p>

      {counts.overAuthorization > 0 && (
        <p style={notice}>
          {counts.overAuthorization === 1
            ? "1 sesión supera las autorizadas por la obra social."
            : `${counts.overAuthorization} sesiones superan las autorizadas por la obra social.`}
        </p>
      )}
      {counts.afterExpiry > 0 && (
        <p style={notice}>
          {counts.afterExpiry === 1
            ? "1 sesión cae después del vencimiento de la autorización."
            : `${counts.afterExpiry} sesiones caen después del vencimiento de la autorización.`}
        </p>
      )}
      {preview.otherActivePlans.map((p) => (
        // Sin título (PHI): disciplina + contador, como el chip V1-D18.
        <p key={p.programId} style={notice}>
          {`Este paciente ya tiene el plan ${p.discipline ? disciplineShortLabel(p.discipline) : "sin disciplina"} (${p.ordinal}/${p.total}) activo.`}
        </p>
      ))}

      <div
        role="region"
        aria-label="Turnos del plan"
        tabIndex={0}
        style={{
          overflowX: "auto",
          maxWidth: "100%",
          border: "1px solid var(--navy-100)",
          borderRadius: "var(--r-sm)",
          background: "var(--card-bg)",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: showPrice ? 640 : 560 }}>
          <thead>
            <tr>
              <th scope="col" style={head}>
                #
              </th>
              <th scope="col" style={head}>
                Día
              </th>
              <th scope="col" style={head}>
                Hora
              </th>
              <th scope="col" style={head}>
                Estado
              </th>
              <th scope="col" style={head}>
                Resolución
              </th>
              {showPrice && (
                <th scope="col" style={{ ...head, textAlign: "right" }}>
                  Precio
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <PreviewRow
                key={row.index}
                row={row}
                current={effectiveRowResolution(row, resolutions)}
                stale={staleIndexes?.has(row.index) ?? false}
                ordinal={ordinalOf?.(row) ?? row.index}
                showPrice={showPrice}
                disabled={disabled}
                onChange={onResolutionChange}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PreviewRow({
  row,
  current,
  stale,
  ordinal,
  showPrice,
  disabled,
  onChange,
}: {
  row: PlanPreviewRow;
  current: PlanRowResolution;
  stale: boolean;
  /** Lo que se muestra en "#" y en el aria (M13); el `index` sigue siendo la clave de la resolución. */
  ordinal: number;
  showPrice: boolean;
  disabled?: boolean;
  onChange: (r: PlanRowResolution) => void;
}) {
  const { day, time } = planRowDateLabel(row.at);
  const status = planRowStatus(row);
  const options = resolutionOptions(row);
  const selected = options.some((o) => o.value === current.kind) ? current.kind : "";
  const f = row.flags;
  const rowStyle: CSSProperties = stale
    ? { background: "var(--sky-50)", boxShadow: "inset 4px 0 0 var(--navy-700)" }
    : {};

  return (
    <tr data-plan-row={row.index} data-stale={stale ? "true" : undefined} style={rowStyle}>
      <td style={{ ...cell, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{ordinal}</td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{day}</td>
      <td style={{ ...cell, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{time}</td>
      <td style={cell}>
        <span
          data-status={status.kind}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 8px",
            borderRadius: 999,
            border: "1px solid var(--navy-200)",
            background: "var(--card-bg)",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--navy-700)",
          }}
        >
          <span aria-hidden="true">{status.glyph}</span>
          {status.label}
        </span>
        {f.priorPaid && <span style={note}>{`Ya pagada en el turno del ${ddmm(toARDateKey(f.priorPaid.at))}`}</span>}
        {f.overAuthorization === true && <span style={note}>Supera las sesiones autorizadas</span>}
        {f.afterAuthorizationExpiry === true && <span style={note}>Después del vencimiento de la autorización</span>}
        {stale && (
          <span style={{ ...note, fontWeight: 700, color: "var(--navy-900)" }}>
            <span aria-hidden="true">! </span>Revisá esta fila
          </span>
        )}
      </td>
      <td style={cell}>
        <select
          aria-label={`Qué hacer con la sesión ${ordinal}`}
          value={selected}
          disabled={disabled || options.length === 0}
          onChange={(e) => {
            const opt = options.find((o) => o.value === e.target.value);
            if (opt) onChange(opt.resolution);
          }}
          style={{
            width: "100%",
            minWidth: 180,
            minHeight: 36,
            padding: "6px 8px",
            borderRadius: "var(--r-sm)",
            border: stale ? "2px solid var(--navy-700)" : "1px solid var(--navy-200)",
            background: "var(--card-bg)",
            color: "var(--navy-900)",
            fontSize: 13,
          }}
        >
          {selected === "" && (
            <option value="" disabled>
              Elegí qué hacer
            </option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </td>
      {showPrice && (
        <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {row.priceCents != null ? formatARS(row.priceCents) : "—"}
        </td>
      )}
    </tr>
  );
}
