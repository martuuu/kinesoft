/**
 * Estado de los editores de Configuración → Profesionales (B3.5 CFG-UI-2,
 * B-pre): servicios por profesional (`services-editor.tsx`) y coberturas por
 * profesional (`payers-editor.tsx`). Lógica PURA, sin React ni DOM: se testea
 * en `tests/unit/practitioner-editors-state.test.ts`.
 *
 * Por qué fuera de los componentes: los editores trabajan con strings (lo que
 * tipea el usuario: "", "1", "30") y la action espera números o null que
 * HEREDAN (contrato de `PractitionerServiceInput`). La conversión borrador ↔
 * fila ↔ input es donde se esconden los bugs ("" que viaja como 0 y pisa la
 * herencia, un cupo que queda "fantasma" al apagar el override, una
 * anticipación en horas que se guarda en horas), así que vive acá con tests.
 */
import {
  PractitionerServiceInput,
  PS_DURATION_MAX,
  PS_DURATION_MIN,
  PS_MAX_CONCURRENT_MAX,
  PS_MAX_LEAD_DAYS_MAX,
  PS_MIN_LEAD_MAX,
  type PractitionerPayerRow,
  type PractitionerServiceInputT,
  type PractitionerServiceRow,
} from "@/lib/practitioner-config-schemas";

// ─── Servicios ──────────────────────────────────────────────────────────────

/**
 * Borrador editable de una fila. Los numéricos son strings tal cual el input:
 * "" = heredar (duración del servicio, anticipación del canal, sin horizonte).
 * La anticipación mínima se edita en horas + minutos y se guarda en minutos.
 */
export type ServiceDraft = {
  enabled: boolean;
  durationMin: string;
  visibility: "PUBLIC" | "PRIVATE";
  leadHours: string;
  leadMinutes: string;
  maxLeadDays: string;
  concurrencyOverride: boolean;
  /** Con override: true = "sin límite" (maxConcurrent null). */
  concurrencyUnlimited: boolean;
  maxConcurrent: string;
  notifyOnBooking: boolean;
};

export type ServiceDraftField =
  | "durationMin"
  | "minLead"
  | "maxLeadDays"
  | "maxConcurrent";

export type ServiceDraftErrors = Partial<Record<ServiceDraftField, string>>;

const numStr = (n: number | null | undefined) => (n == null ? "" : String(n));

/** Fila de `listPractitionerServices` → borrador. */
export function rowToDraft(row: PractitionerServiceRow): ServiceDraft {
  const lead = row.minLeadMinutes;
  return {
    enabled: row.enabled,
    durationMin: numStr(row.durationMin),
    visibility: row.visibility === "PRIVATE" ? "PRIVATE" : "PUBLIC",
    leadHours: lead == null ? "" : String(Math.floor(lead / 60)),
    leadMinutes: lead == null ? "" : String(lead % 60),
    maxLeadDays: numStr(row.maxLeadDays),
    concurrencyOverride: row.concurrencyOverride,
    concurrencyUnlimited: row.concurrencyOverride && row.maxConcurrent == null,
    // Sin override, el input arranca con el cupo del servicio como punto de
    // partida (lo que el usuario ve si prende el switch).
    maxConcurrent: numStr(row.concurrencyOverride ? row.maxConcurrent : row.serviceMaxConcurrent),
    notifyOnBooking: row.notifyOnBooking,
  };
}

/** Entero no negativo escrito por el usuario, o null si está vacío; NaN si es basura. */
function parseIntField(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return Number.NaN;
  return Number(t);
}

/**
 * Horas + minutos → minutos totales. Ambos vacíos = null (hereda la
 * anticipación del canal). Uno solo vacío cuenta como 0 ("2" h y "" min = 120).
 */
export function joinLead(hours: string, minutes: string): number | null {
  const h = parseIntField(hours);
  const m = parseIntField(minutes);
  if (h === null && m === null) return null;
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Borrador → payload de `upsertPractitionerService`, con las mismas reglas que
 * el zod del server (`PS_*`) pero con mensajes por campo para mostrarlos en la
 * fila antes de viajar. El server vuelve a validar (no confiamos en esto).
 */
export function draftToInput(
  d: ServiceDraft
): { ok: true; input: PractitionerServiceInputT } | { ok: false; errors: ServiceDraftErrors } {
  const errors: ServiceDraftErrors = {};

  const duration = parseIntField(d.durationMin);
  if (duration !== null) {
    if (Number.isNaN(duration)) errors.durationMin = "Poné minutos enteros.";
    else if (duration < PS_DURATION_MIN || duration > PS_DURATION_MAX)
      errors.durationMin = `Entre ${PS_DURATION_MIN} y ${PS_DURATION_MAX} minutos.`;
    else if (duration % 5 !== 0) errors.durationMin = "Va de a 5 minutos.";
  }

  const leadH = parseIntField(d.leadHours);
  const leadM = parseIntField(d.leadMinutes);
  let minLead: number | null = null;
  if (Number.isNaN(leadH) || Number.isNaN(leadM)) {
    errors.minLead = "Poné horas y minutos enteros.";
  } else if (leadM !== null && leadM > 59) {
    errors.minLead = "Los minutos van de 0 a 59.";
  } else {
    minLead = joinLead(d.leadHours, d.leadMinutes);
    if (minLead !== null && minLead > PS_MIN_LEAD_MAX)
      errors.minLead = `Máximo ${PS_MIN_LEAD_MAX / 60 / 24} días de anticipación.`;
  }

  const maxDays = parseIntField(d.maxLeadDays);
  if (maxDays !== null) {
    if (Number.isNaN(maxDays)) errors.maxLeadDays = "Poné días enteros.";
    else if (maxDays > PS_MAX_LEAD_DAYS_MAX) errors.maxLeadDays = `Máximo ${PS_MAX_LEAD_DAYS_MAX} días.`;
  }

  let cap: number | null = null;
  if (d.concurrencyOverride && !d.concurrencyUnlimited) {
    cap = parseIntField(d.maxConcurrent);
    if (cap === null) errors.maxConcurrent = "Poné un cupo o marcá «Sin límite».";
    else if (Number.isNaN(cap)) errors.maxConcurrent = "Poné un número entero.";
    else if (cap < 1 || cap > PS_MAX_CONCURRENT_MAX)
      errors.maxConcurrent = `Entre 1 y ${PS_MAX_CONCURRENT_MAX}.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const input: PractitionerServiceInputT = {
    enabled: d.enabled,
    durationMin: duration,
    visibility: d.visibility,
    minLeadMinutes: minLead,
    maxLeadDays: maxDays,
    concurrencyOverride: d.concurrencyOverride,
    // Sin override → null (el server también lo fuerza: nada de "cupo fantasma").
    maxConcurrent: d.concurrencyOverride ? cap : null,
    notifyOnBooking: d.notifyOnBooking,
  };
  // Red de seguridad: si el zod compartido rechaza algo que se nos escapó
  // arriba, no mandamos un payload que sabemos inválido.
  const check = PractitionerServiceInput.safeParse(input);
  if (!check.success) {
    const fe = check.error.flatten().fieldErrors;
    return {
      ok: false,
      errors: {
        ...(fe.durationMin ? { durationMin: fe.durationMin[0] } : {}),
        ...(fe.minLeadMinutes ? { minLead: fe.minLeadMinutes[0] } : {}),
        ...(fe.maxLeadDays ? { maxLeadDays: fe.maxLeadDays[0] } : {}),
        ...(fe.maxConcurrent ? { maxConcurrent: fe.maxConcurrent[0] } : {}),
      },
    };
  }
  return { ok: true, input };
}

/**
 * Clave semántica del borrador: dos borradores que se guardarían igual dan la
 * misma clave ("02" h = "2" h; "1" h 0 min = "" h 60 min; el número del cupo
 * no cuenta si el override está apagado o es "sin límite"). Así escribir y
 * borrar no deja la fila "con cambios sin guardar".
 */
export function draftKey(d: ServiceDraft): string {
  const r = draftToInput(d);
  if (r.ok) return JSON.stringify(r.input);
  // Inválido: comparamos lo tipeado tal cual (siempre difiere de un baseline válido).
  return JSON.stringify({ invalid: d });
}

export function isDraftDirty(draft: ServiceDraft, baseline: ServiceDraft): boolean {
  return draftKey(draft) !== draftKey(baseline);
}

/** Texto corto de la anticipación heredada/propia, para el resumen de la card mobile. */
export function formatLead(min: number | null): string {
  if (min == null) return "la del turnero";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// ─── Coberturas ─────────────────────────────────────────────────────────────

/** Ids marcados al cargar (Particular siempre). */
export function initialPayerSelection(rows: PractitionerPayerRow[]): Set<string> {
  return new Set(rows.filter((r) => r.isParticular || r.active).map((r) => r.insurerId));
}

/** Minúsculas, sin acentos ni puntos: "O.S.D.E." encuentra "osde", "Galeno" encuentra "galéno". */
export function foldSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.\s]+/g, " ")
    .trim()
    .toLowerCase();
}

export function filterPayers(rows: PractitionerPayerRow[], query: string): PractitionerPayerRow[] {
  const q = foldSearch(query);
  if (!q) return rows;
  const qCompact = q.replace(/ /g, "");
  return rows.filter((r) => {
    const name = foldSearch(r.name);
    return name.includes(q) || name.replace(/ /g, "").includes(qCompact);
  });
}

/**
 * "Todas" / "Ninguna" sobre las filas VISIBLES (si hay búsqueda, solo las
 * filtradas: "busco 'osde' → Todas" no debería marcar el resto del listado).
 * Particular nunca se desmarca.
 */
export function applyBulk(
  selected: ReadonlySet<string>,
  visible: PractitionerPayerRow[],
  mode: "all" | "none"
): Set<string> {
  const next = new Set(selected);
  for (const r of visible) {
    if (r.isParticular) next.add(r.insurerId);
    else if (mode === "all") next.add(r.insurerId);
    else next.delete(r.insurerId);
  }
  return next;
}

export function togglePayer(
  selected: ReadonlySet<string>,
  row: PractitionerPayerRow
): Set<string> {
  const next = new Set(selected);
  if (row.isParticular) {
    next.add(row.insurerId);
    return next;
  }
  if (next.has(row.insurerId)) next.delete(row.insurerId);
  else next.add(row.insurerId);
  return next;
}

/** Payload de `setPractitionerPayers`: ids del tenant marcados, en el orden del listado. */
export function payerIdsForSave(rows: PractitionerPayerRow[], selected: ReadonlySet<string>): string[] {
  return rows.filter((r) => r.isParticular || selected.has(r.insurerId)).map((r) => r.insurerId);
}

export function isPayerSelectionDirty(
  rows: PractitionerPayerRow[],
  baseline: ReadonlySet<string>,
  selected: ReadonlySet<string>
): boolean {
  return rows.some(
    (r) => !r.isParticular && baseline.has(r.insurerId) !== selected.has(r.insurerId)
  );
}
