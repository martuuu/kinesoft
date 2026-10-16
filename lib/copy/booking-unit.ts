/**
 * VX3-f «sesión→turno»: la unidad con la que se cuentan los turnos de una serie.
 *
 * Por qué existe: EV1-C1 resolvía Clínica general reescribiendo el texto YA ARMADO con «sesiones» (`asTurnos` en
 * `components/agenda/booking-modal/sessions-mode.tsx`, regex sobre el resumen del server). Funcionaba, pero cada
 * texto nuevo con «sesión» quedaba mal hasta que alguien sumara su regex, y la concordancia («sesiones pedidas» →
 * «turnos pedidos») vivía en un replace. Ahora los que arman el texto (`summarizeRange`, `localSummary`,
 * `shortfallNote`) reciben la unidad y eligen la palabra; `previewRecurrence` la saca de los módulos del actor.
 *
 * Regla: Kinesiología (módulo `sesiones`) cuenta «sesiones»; Clínica general, «turnos». Puro, sin dependencias de
 * runtime: lo importan el server (`lib/availability-actions.ts`) y el cliente.
 */
import type { TenantModule } from "@/lib/tenant-modules";

export type BookingUnit = "sesion" | "turno";

const WORDS: Record<BookingUnit, { one: string; many: string; requested: string }> = {
  // «pedidas/pedidos»: concordancia de género con el sustantivo.
  sesion: { one: "sesión", many: "sesiones", requested: "pedidas" },
  turno: { one: "turno", many: "turnos", requested: "pedidos" },
};

/** Unidad según los módulos del consultorio (`modulesFor(actor.entitlements)` o `useTenantModules()`). */
export function bookingUnitOf(modules: { has(m: TenantModule): boolean }): BookingUnit {
  return modules.has("sesiones") ? "sesion" : "turno";
}

/** «1 sesión» / «8 sesiones» / «1 turno» / «8 turnos». */
export function unitCount(unit: BookingUnit, n: number): string {
  const w = WORDS[unit];
  return `${n} ${n === 1 ? w.one : w.many}`;
}

/** «sesiones» / «turnos» (minúscula, para armar frases). */
export function unitPlural(unit: BookingUnit): string {
  return WORDS[unit].many;
}

/** «Sesiones» / «Turnos» (rótulo de un campo). */
export function unitPluralLabel(unit: BookingUnit): string {
  const w = WORDS[unit].many;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** «las sesiones» / «los turnos». */
export function unitPluralWithArticle(unit: BookingUnit): string {
  return unit === "sesion" ? "las sesiones" : "los turnos";
}

/** «Sin sesiones» / «Sin turnos». */
export function unitNone(unit: BookingUnit): string {
  return `Sin ${WORDS[unit].many}`;
}

/** «Se generan 3 de 8 sesiones pedidas.» / «Se generan 3 de 8 turnos pedidos.» */
export function unitShortfall(unit: BookingUnit, generated: number, requested: number): string {
  const w = WORDS[unit];
  return `Se generan ${generated} de ${requested} ${requested === 1 ? w.one : w.many} ${
    requested === 1 ? w.requested.slice(0, -1) : w.requested
  }.`;
}
