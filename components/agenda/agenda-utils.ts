import type { CSSProperties } from "react";
import type { BookingStatus } from "@prisma/client";
import { formatARS } from "@/lib/format";

export type BookingDTO = {
  id: string;
  scheduledFor: string;
  durationMin: number;
  status: BookingStatus;
  serviceId: string;
  serviceName: string;
  serviceColor: string | null;
  practitionerId: string;
  patientId: string | null;
  patientName: string;
  patientCondition: string | null;
  /** Obra social ("Particular" when uninsured/guest). */
  obraSocial: string;
  /** Copago per session in cents (insurer copago, or service price for particular). */
  copagoCents: number;
  /** Row version for optimistic concurrency (Booking.updatedAt, ISO). */
  updatedAt: string;
  notes: string | null;
  /** Per-turno mini-diagnosis title (agenda card). Null when unset. */
  title: string | null;
  /** Per-turno mini-diagnosis long description. Null when unset. */
  description: string | null;
  /**
   * Sprint 16: tells the agenda whether to expose the link-to-HC + the
   * diagnosis chip. `"basic"` shows the booking + name only; `"none"`
   * is a guest booking (no patient row yet).
   */
  patientAccess: "full" | "basic" | "none";
};

export const DAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

// ─────────────────────────────────────────────────────────────────────────────
// Agenda slot grid (day + week views)
//
// A "slot" is minutes-from-midnight in AR wall-clock. `Tenant.agendaSlotMinutes`
// picks the granularity: 60 → one row per hour, 30 → half-hour rows so a 13:30
// turno gets its own labelled row instead of being folded into 13:00.
// Pure + framework-free so the bucketing math is unit-testable (docs/TESTING.md
// capa 1) — it replaced the old column-packing algorithm the timeline used.
// ─────────────────────────────────────────────────────────────────────────────

/** Rows of the grid, as minutes-from-midnight: [480, 510, 540…] for 8→19 @30. */
export function buildSlots(startHour: number, endHour: number, slotMinutes: number): number[] {
  const step = slotMinutes === 30 ? 30 : 60;
  const from = Math.max(0, Math.floor(startHour)) * 60;
  const to = Math.min(24, Math.floor(endHour)) * 60;
  const out: number[] = [];
  for (let m = from; m < to; m += step) out.push(m);
  // Degenerate windows (start >= end) still render one row so the day isn't blank.
  return out.length ? out : [from];
}

/** "13:30" for a slot expressed in minutes-from-midnight. */
export function slotLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Which slot a turno belongs to: floor to the granularity, then clamp into the
 * visible window. Returns the slot value (minutes-from-midnight) plus whether it
 * had to be clamped, so the caller can surface out-of-window turnos separately
 * instead of silently mixing them into the first/last row.
 */
export function slotOf(
  arMinutes: number,
  slots: number[],
  slotMinutes: number
): { slot: number; outOfRange: "before" | "after" | null } {
  const step = slotMinutes === 30 ? 30 : 60;
  const first = slots[0];
  const last = slots[slots.length - 1];
  const floored = Math.floor(arMinutes / step) * step;
  if (floored < first) return { slot: first, outOfRange: "before" };
  if (floored > last) return { slot: last, outOfRange: "after" };
  return { slot: floored, outOfRange: null };
}

/**
 * Slots covered by a turno AFTER its starting one — used to hint "continúa …"
 * on the rows a long turno runs through, which would otherwise look free.
 */
export function coveredSlots(
  startArMinutes: number,
  durationMin: number,
  slots: number[],
  slotMinutes: number
): number[] {
  const step = slotMinutes === 30 ? 30 : 60;
  const startSlot = Math.floor(startArMinutes / step) * step;
  const end = startArMinutes + Math.max(0, durationMin);
  const out: number[] = [];
  for (let s = startSlot + step; s < end; s += step) {
    if (s >= slots[0] && s <= slots[slots.length - 1]) out.push(s);
  }
  return out;
}

export function fmtHour(d: Date) {
  return d.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

/** Cents → "$1.234" (AR pesos, no decimals). Delegates to the shared
 *  `formatARS` so the currency formatting has a single source of truth. */
export function fmtMoney(cents: number) {
  return formatARS(cents);
}

/**
 * Obra social name to display, or "" when the patient is particular /
 * uninsured. The literal words "Particular" / "Obra social" are never
 * shown — only the actual insurer name (OSDE, Galeno…) appears.
 */
export function osLabel(obraSocial: string): string {
  return obraSocial && obraSocial.toLowerCase() !== "particular" ? obraSocial : "";
}

/**
 * Compact billing line: "Servicio - OSDE - $Copago". The obra social
 * segment is dropped entirely when particular, so it never prints the
 * word "Particular" — just "Servicio - $Copago".
 */
export function billingLine(b: { serviceName: string; obraSocial: string; copagoCents: number }) {
  const os = osLabel(b.obraSocial);
  return [b.serviceName, os, fmtMoney(b.copagoCents)].filter(Boolean).join(" - ");
}

/** Inline pill matching the <Tag> footprint for statuses the Tag tones
 *  don't cover (amber/green semantics for Ausente / Hecho). */
export function statusPill(bg: string, color: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10.5,
    fontWeight: 700,
    padding: "3px 9px",
    borderRadius: 999,
    background: bg,
    color,
    whiteSpace: "nowrap",
  };
}
