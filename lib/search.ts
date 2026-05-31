"use server";

/**
 * Global search powering the ⌘K command palette.
 *
 * Returns categorised results: patients (tenant-scoped), exercises +
 * conditions (catalog), bookings in the next 7 days, plus a fixed list
 * of navigation shortcuts.
 *
 * Each entry has an `id`, `label`, `sublabel`, `href` and `category` so
 * the palette can render them generically.
 */
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { gatingForActor } from "@/lib/plan-gating";

import type { SearchHit } from "@/lib/search-types";

const SHORTCUTS: SearchHit[] = [
  { id: "nav:dashboard", category: "shortcut", label: "Dashboard", href: "/dashboard" },
  { id: "nav:agenda", category: "shortcut", label: "Agenda", href: "/agenda" },
  { id: "nav:pacientes", category: "shortcut", label: "Pacientes", href: "/pacientes" },
  { id: "nav:diagnostico", category: "shortcut", label: "Diagnóstico", href: "/diagnostico" },
  { id: "nav:seguimiento", category: "shortcut", label: "Seguimiento", href: "/seguimiento" },
  { id: "nav:biblioteca", category: "shortcut", label: "Biblioteca", href: "/biblioteca" },
  { id: "nav:reportes", category: "shortcut", label: "Reportes", href: "/reportes" },
];

export async function globalSearch(q: string): Promise<SearchHit[]> {
  const term = q.trim();
  if (!term) return SHORTCUTS;

  const actor = await getActor();
  const gate = await gatingForActor();
  const insensitive = "insensitive" as const;

  const [patients, exercises, conditions, bookings] = await Promise.all([
    prisma.patient.findMany({
      where: {
        tenantId: actor.tenantId,
        OR: [
          { firstName: { contains: term, mode: insensitive } },
          { lastName: { contains: term, mode: insensitive } },
          { email: { contains: term, mode: insensitive } },
          { documentId: { contains: term, mode: insensitive } },
        ],
      },
      take: 6,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true, documentId: true, email: true },
    }),
    prisma.exercise.findMany({
      where: {
        AND: [
          gate.visibility,
          {
            OR: [
              { name: { contains: term, mode: insensitive } },
              { muscleGroups: { contains: term, mode: insensitive } },
              { description: { contains: term, mode: insensitive } },
            ],
          },
        ],
      },
      take: 6,
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true, muscleGroups: true, difficulty: true },
    }),
    prisma.condition.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: insensitive } },
          { cie10: { contains: term, mode: insensitive } },
          { summary: { contains: term, mode: insensitive } },
        ],
      },
      take: 6,
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true, cie10: true },
    }),
    prisma.booking.findMany({
      where: {
        tenantId: actor.tenantId,
        scheduledFor: {
          gte: new Date(),
          lt: new Date(Date.now() + 7 * 86_400_000),
        },
        status: { notIn: ["CANCELLED"] },
        OR: [
          { patient: { firstName: { contains: term, mode: insensitive } } },
          { patient: { lastName: { contains: term, mode: insensitive } } },
          { guestName: { contains: term, mode: insensitive } },
        ],
      },
      take: 4,
      orderBy: { scheduledFor: "asc" },
      include: { patient: { select: { firstName: true, lastName: true } } },
    }),
  ]);

  const out: SearchHit[] = [];

  for (const p of patients) {
    out.push({
      id: `patient:${p.id}`,
      category: "patient",
      label: `${p.firstName} ${p.lastName}`,
      sublabel: p.documentId
        ? `DNI ${p.documentId}`
        : p.email ?? "Sin contacto",
      href: `/pacientes/${p.id}`,
    });
  }
  for (const e of exercises) {
    out.push({
      id: `exercise:${e.id}`,
      category: "exercise",
      label: e.name,
      sublabel:
        (e.muscleGroups ? e.muscleGroups + " · " : "") + `Nivel ${e.difficulty}`,
      href: `/biblioteca?q=${encodeURIComponent(e.name)}`,
    });
  }
  for (const c of conditions) {
    out.push({
      id: `condition:${c.id}`,
      category: "condition",
      label: c.name,
      sublabel: c.cie10 ? `CIE-10 ${c.cie10}` : undefined,
      href: `/biblioteca?condition=${encodeURIComponent(c.slug)}`,
    });
  }
  for (const b of bookings) {
    out.push({
      id: `booking:${b.id}`,
      category: "booking",
      label: b.patient
        ? `${b.patient.firstName} ${b.patient.lastName}`
        : b.guestName ?? "Sin asignar",
      sublabel: b.scheduledFor.toLocaleString("es-AR", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
      href: `/agenda?date=${b.scheduledFor.toISOString().slice(0, 10)}`,
    });
  }

  // Always offer shortcuts that match the term.
  const shortcutMatches = SHORTCUTS.filter((s) =>
    s.label.toLowerCase().includes(term.toLowerCase())
  );
  return [...out, ...shortcutMatches];
}
