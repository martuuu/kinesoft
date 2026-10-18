import type { ReceptionState } from "@/lib/reception-state";
import type { ReceptionFilter } from "@/lib/reception-view-state";

/**
 * [AS-0d · mbz-recepcion-plegable-390] Secciones plegables de Recepción en el celular (< 640 px). Pedido de MB-1b
 * (brief MB, fila «Sala / Recepción»: «una columna, "Esperando" primero, secciones por estado colapsables con
 * conteo») que había quedado sin hacer: a 390 la lista del día era una sola tira cronológica de cards y con 20 turnos
 * la Secretaria scrolleaba ~2.000 px para encontrar a los que están en la sala.
 *
 * En escritorio NO se usa: ahí sigue la tabla con el orden de `sortForReception` (en atención arriba, después
 * cronológico). Las dos presentaciones se dibujan desde el server y el CSS elige una (mismo patrón que la Semana del
 * celular, MB-D10): decidir por `matchMedia` en el cliente reordenaba la lista al hidratar (CLS a 390).
 */
export type ReceptionSectionId = "esperando" | "en-atencion" | "por-llegar" | "atendidos" | "ausentes" | "cancelados";

export const RECEPTION_SECTIONS: ReadonlyArray<{
  id: ReceptionSectionId;
  label: string;
  states: ReadonlyArray<ReceptionState>;
  /** Plegada por defecto: lo que ya terminó no es trabajo de la recepción. */
  folded: boolean;
}> = [
  // «Esperando» primero (brief MB): son los que la Secretaria tiene que mover ahora. El llamado sigue en la sala.
  { id: "esperando", label: "Esperando", states: ["en-sala", "llamado"], folded: false },
  { id: "en-atencion", label: "En atención", states: ["en-atencion"], folded: false },
  // El demorado todavía no llegó: va con los que hay que esperar (misma regla que el filtro «Por llegar»).
  { id: "por-llegar", label: "Por llegar", states: ["demorado", "por-llegar"], folded: false },
  { id: "atendidos", label: "Atendidos", states: ["atendido"], folded: true },
  { id: "ausentes", label: "Ausentes", states: ["ausente"], folded: true },
  { id: "cancelados", label: "Cancelados", states: ["cancelado"], folded: true },
];

export type ReceptionSection<T> = { id: ReceptionSectionId; label: string; entries: T[]; open: boolean };

/**
 * Pura: agrupa las entries (ya filtradas y en el orden de `sortForReception`, que se respeta adentro de cada
 * sección) y resuelve si cada sección está abierta. Las vacías no salen.
 *
 * `toggled` = las secciones que el usuario plegó o desplegó (el valor es el estado elegido). Con un filtro que no es
 * «Todos» todas arrancan abiertas: elegir «Atendidos» y ver la sección cerrada sería un filtro que no muestra nada.
 */
export function receptionSections<T extends { state: ReceptionState }>(
  entries: ReadonlyArray<T>,
  filter: ReceptionFilter,
  toggled: Readonly<Partial<Record<ReceptionSectionId, boolean>>> = {}
): ReceptionSection<T>[] {
  const out: ReceptionSection<T>[] = [];
  for (const s of RECEPTION_SECTIONS) {
    const list = entries.filter((e) => s.states.includes(e.state));
    if (list.length === 0) continue;
    const byDefault = filter !== "todos" || !s.folded;
    out.push({ id: s.id, label: s.label, entries: list, open: toggled[s.id] ?? byDefault });
  }
  return out;
}
