/**
 * Servicios iniciales de un consultorio nuevo, por vertical (BO1-C).
 *
 * Puro y client-safe. Lo usan `scripts/create-tenant.ts` y el alta desde
 * Plataforma (BO2-A). Antes el script sembraba 3 servicios fijos de kine
 * («Consulta inicial», «Sesión kinésica», «RPG») también en un consultorio
 * General, que terminaba con una agenda de kinesiología que no era la suya.
 *
 * Precio 0 a propósito: el arancel lo decide cada consultorio y no hay un valor
 * razonable para todo el país; un precio inventado terminaría cobrándose sin
 * que nadie lo revise. Con 0 el turno se agenda igual y el consultorio lo carga
 * en Configuración → Servicios.
 *
 * Color de `SERVICE_COLORS` (la barra lateral de la agenda es el servicio):
 * uno distinto por servicio para que se diferencien desde el primer día.
 */
import type { Discipline, TenantVertical } from "@prisma/client";
import { SERVICE_COLORS, type ServiceColor } from "./service-colors";

export type StarterService = {
  name: string;
  durationMin: number;
  priceCents: number;
  color: ServiceColor;
  /** Cupos simultáneos por horario (`Service.maxConcurrent`): null = sin tope. */
  maxConcurrent: number | null;
  /** Disciplina del servicio (Planes, D10). null = no es de una disciplina. */
  discipline: Discipline | null;
};

const KINESIOLOGY: readonly StarterService[] = [
  // Kine atiende varios pacientes en paralelo en la misma franja: sin tope,
  // igual que el default de `Service.maxConcurrent`.
  { name: "Kinesiología", durationMin: 45, priceCents: 0, color: SERVICE_COLORS[8], maxConcurrent: null, discipline: "KINESIOLOGY" },
  // Osteopatía es uno a uno (comentario de `Service.maxConcurrent` en el schema).
  { name: "Osteopatía", durationMin: 60, priceCents: 0, color: SERVICE_COLORS[11], maxConcurrent: 1, discipline: "OSTEOPATHY" },
  // La evaluación es individual y sirve para cualquiera de las dos disciplinas.
  { name: "Evaluación inicial", durationMin: 45, priceCents: 0, color: SERVICE_COLORS[5], maxConcurrent: 1, discipline: null },
];

// Consultorio general: consultas uno a uno, sin disciplina (no tiene Planes).
const GENERAL: readonly StarterService[] = [
  { name: "Consulta", durationMin: 30, priceCents: 0, color: SERVICE_COLORS[8], maxConcurrent: 1, discipline: null },
  { name: "Primera consulta", durationMin: 45, priceCents: 0, color: SERVICE_COLORS[5], maxConcurrent: 1, discipline: null },
  { name: "Control", durationMin: 20, priceCents: 0, color: SERVICE_COLORS[2], maxConcurrent: 1, discipline: null },
];

/** Copia nueva en cada llamada: el caller puede mutarla sin ensuciar la constante. */
export function starterServicesFor(vertical: TenantVertical): StarterService[] {
  // Falla cerrado como `modulesFor`: una vertical desconocida cae a General
  // (servicios neutros), nunca a los de kine.
  const list = vertical === "KINESIOLOGY" ? KINESIOLOGY : GENERAL;
  return list.map((s) => ({ ...s }));
}
