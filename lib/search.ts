"use server";

/**
 * Global search powering the ⌘K command palette.
 *
 * Returns categorised results: patients (tenant-scoped), exercises (only
 * with the `ejercicios` module, through the catalog gate) + conditions (only
 * with `diagnostico`: global + this tenant's custom), bookings in the next 7
 * days, plus the navigation shortcuts of the tenant's modules.
 *
 * Each entry has an `id`, `label`, `sublabel`, `href` and `category` so
 * the palette can render them generically.
 */
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { gatingForActor } from "@/lib/plan-gating";
import { toARDateKey } from "@/lib/datetime-ar";
import { shortcutsFor } from "@/lib/nav";
import { modulesFor } from "@/lib/tenant-modules";
import { escapeLike } from "@/lib/email-match";

import type { SearchHit } from "@/lib/search-types";

// EV0 (C-EV2): los atajos salen de `shortcutsFor(modules)` de `lib/nav.ts`, la
// misma fuente que sidebar y topbar. Antes había una lista `SHORTCUTS` fija acá
// y un consultorio General veía "Diagnóstico"/"Seguimiento"/"Biblioteca".

export async function globalSearch(q: string): Promise<SearchHit[]> {
  const term = q.trim();
  const actor = await getActor();
  const modules = modulesFor(actor.entitlements);
  const shortcuts = shortcutsFor(modules);
  if (!term) return shortcuts;

  // Sin el módulo no se consulta (no alcanza con filtrar el resultado: es una
  // query de menos y no depende de que la visibilidad esté bien armada).
  const withExercises = modules.has("ejercicios");
  const withConditions = modules.has("diagnostico");
  // Sin `ejercicios` el gate tampoco hace falta (su visibilidad sería vacía).
  const gate = withExercises ? await gatingForActor() : null;
  const insensitive = "insensitive" as const;
  // EV1 (integrador): mismo hallazgo que pacientes/catálogo/Plataforma — Prisma no escapa `%`/`_` en
  // `contains` + insensitive (ILIKE con el valor tal cual): «%» en la paleta traía todo. Los atajos de abajo
  // siguen filtrando con el `term` crudo (es un `includes` en JS, no SQL).
  const like = escapeLike(term);

  const [patients, exercises, conditions, bookings] = await Promise.all([
    runWithRls(actor.tenantId, (tx) => tx.patient.findMany({
      where: {
        tenantId: actor.tenantId,
        OR: [
          { firstName: { contains: like, mode: insensitive } },
          { lastName: { contains: like, mode: insensitive } },
          { email: { contains: like, mode: insensitive } },
          { documentId: { contains: like, mode: insensitive } },
        ],
      },
      take: 6,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true, documentId: true, email: true },
    })),
    !gate ? Promise.resolve([]) : runWithRls(actor.tenantId, (tx) => tx.exercise.findMany({
      where: {
        AND: [
          gate.visibility,
          // Igual que la biblioteca: un archivado no se ofrece.
          { archivedAt: null },
          {
            OR: [
              { name: { contains: like, mode: insensitive } },
              { muscleGroups: { contains: like, mode: insensitive } },
              { description: { contains: like, mode: insensitive } },
            ],
          },
        ],
      },
      take: 6,
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true, muscleGroups: true, difficulty: true },
    })),
    !withConditions ? Promise.resolve([]) : runWithRls(actor.tenantId, (tx) => tx.condition.findMany({
      where: {
        AND: [
          // Catálogo global + las custom de ESTE consultorio. Antes no había
          // filtro de tenant: con RLS lo tapaba la policy, pero en prod la
          // conexión tiene BYPASSRLS y el ⌘K listaba condiciones custom de
          // otros consultorios (test [EV0-EV-G] en exercise-entitlements).
          { OR: [{ tenantId: null }, { tenantId: actor.tenantId }] },
          {
            OR: [
              { name: { contains: like, mode: insensitive } },
              { cie10: { contains: like, mode: insensitive } },
              { summary: { contains: like, mode: insensitive } },
            ],
          },
        ],
      },
      take: 6,
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true, cie10: true },
    })),
    runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
      where: {
        tenantId: actor.tenantId,
        scheduledFor: {
          gte: new Date(),
          lt: new Date(Date.now() + 7 * 86_400_000),
        },
        status: { notIn: ["CANCELLED"] },
        OR: [
          { patient: { firstName: { contains: like, mode: insensitive } } },
          { patient: { lastName: { contains: like, mode: insensitive } } },
          { guestName: { contains: like, mode: insensitive } },
        ],
      },
      take: 4,
      orderBy: { scheduledFor: "asc" },
      include: { patient: { select: { firstName: true, lastName: true } } },
    })),
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
        hourCycle: "h23",
        timeZone: "America/Argentina/Buenos_Aires",
      }),
      href: `/agenda?date=${toARDateKey(b.scheduledFor)}`,
    });
  }

  // Always offer shortcuts that match the term.
  const shortcutMatches = shortcuts.filter((s) =>
    s.label.toLowerCase().includes(term.toLowerCase())
  );
  return [...out, ...shortcutMatches];
}
