import type { CSSProperties } from "react";
import type { BookingStatus } from "@prisma/client";
import { formatARS } from "@/lib/format";

export type BookingDTO = {
  id: string;
  scheduledFor: string;
  durationMin: number;
  status: BookingStatus;
  serviceName: string;
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
  /**
   * Sprint 16: tells the agenda whether to expose the link-to-HC + the
   * diagnosis chip. `"basic"` shows the booking + name only; `"none"`
   * is a guest booking (no patient row yet).
   */
  patientAccess: "full" | "basic" | "none";
};

export const DAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

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

export type BookingLayout = BookingDTO & {
  col: number;   // 0-based column within its collision group
  cols: number;  // total columns in the group
  groupKey: string;
};

/**
 * Assign each booking a (col, cols) pair so overlapping bookings share
 * the available width instead of stacking. Algorithm:
 *   1. Sort by start time.
 *   2. Sweep: build collision groups where any two bookings overlap.
 *   3. Within each group assign columns greedily.
 */
type BItem = { b: BookingDTO; start: number; end: number };

export function layoutBookings(bookings: BookingDTO[]): BookingLayout[] {
  if (!bookings.length) return [];

  const items: BItem[] = bookings.map((b) => {
    const start = new Date(b.scheduledFor).getTime();
    const end = start + b.durationMin * 60_000;
    return { b, start, end };
  }).sort((a, b) => a.start - b.start);

  // Build overlap groups via a sweep.
  const groups: BItem[][] = [];
  let current: BItem[] = [items[0]];
  let groupEnd = items[0].end;

  for (let i = 1; i < items.length; i++) {
    if (items[i].start < groupEnd) {
      current.push(items[i]);
      groupEnd = Math.max(groupEnd, items[i].end);
    } else {
      groups.push(current);
      current = [items[i]];
      groupEnd = items[i].end;
    }
  }
  groups.push(current);

  const result: BookingLayout[] = [];
  groups.forEach((group, gi) => {
    const cols = group.length;
    const key = `g${gi}`;
    group.forEach((item, col) => {
      result.push({ ...item.b, col, cols, groupKey: key });
    });
  });
  return result;
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
