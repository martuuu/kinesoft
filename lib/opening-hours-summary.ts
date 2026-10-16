/**
 * Horario de atención resumido para el turnero público (VX2-d1, AUDIT `turnero-texto-fijo-lun-sab`).
 *
 * Por qué existe: el nav del turnero decía «lun-sáb 8 a 19hs» fijo para todos los consultorios, aunque un
 * profesional atendiera solo martes a la tarde. Acá se arma de las franjas reales (`PractitionerSchedule`) con las
 * mismas reglas que el motor de disponibilidad (`lib/availability-loader.ts` + `lib/availability/ranges.ts`):
 *   - solo las franjas de los profesionales que el turnero ofrece y de sedes activas;
 *   - un profesional SIN ninguna franja (de cualquier sede o vigencia) cae a la red de seguridad del motor: horario
 *     del consultorio (`businessHoursStart/End`), lunes a sábado (`FALLBACK_WORKING_DOWS`);
 *   - vigencias (`validFrom`/`validUntil`, `@db.Date`) contra el día de HOY EN ARGENTINA (`toARDateKey`): con
 *     `toISOString().slice(0,10)` del host, pasadas las 21:00 AR una franja que vence hoy desaparecía un día antes
 *     en Vercel (UTC). Las fechas `@db.Date` llegan a las 00:00 UTC y se leen con `dbDateToDayKey` (UTC), igual que
 *     el loader.
 *
 * Es un resumen: no mira excepciones ni bloqueos (feriados, vacaciones). La grilla de horarios es la verdad.
 * Puro (sin Prisma ni reloj implícito): el loader le pasa `now`.
 */
import { toARDateKey } from "@/lib/datetime-ar";
import { dbDateToDayKey } from "@/lib/availability/day";
import { FALLBACK_TENANT_HOURS, FALLBACK_WORKING_DOWS } from "@/lib/availability/types";

/** Una franja semanal ya normalizada (minutos desde la medianoche AR; vigencia como `YYYY-MM-DD` o null). */
export type OpeningRange = {
  dow: number;
  startMin: number;
  endMin: number;
  validFrom: string | null;
  validUntil: string | null;
};

/** Fila de `PractitionerSchedule` como la lee `getPublicClinic`. */
export type OpeningScheduleRow = {
  practitionerId: string;
  dow: number;
  startMin: number;
  endMin: number;
  validFrom: Date | null;
  validUntil: Date | null;
  locationActive: boolean;
};

const MINUTES_PER_DAY = 24 * 60;
/** Lunes primero: así lo lee un paciente argentino («Lun a vie»), no domingo primero como `getDay()`. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_SHORT: Record<number, string> = { 0: "dom", 1: "lun", 2: "mar", 3: "mié", 4: "jue", 5: "vie", 6: "sáb" };

/** Mismo criterio que `tenantHoursOf` del loader: fuera de rango o invertido → 8 a 19. */
function tenantHours(t: { businessHoursStart: number; businessHoursEnd: number }) {
  const startMin = t.businessHoursStart * 60;
  const endMin = t.businessHoursEnd * 60;
  if (Number.isInteger(startMin) && Number.isInteger(endMin) && startMin >= 0 && startMin < endMin && endMin <= MINUTES_PER_DAY) {
    return { startMin, endMin };
  }
  return { startMin: FALLBACK_TENANT_HOURS.startMin, endMin: FALLBACK_TENANT_HOURS.endMin };
}

/**
 * Franjas que el turnero puede ofrecer, por profesional ofrecido, con la red de seguridad del motor para quien no
 * configuró ninguna. Las de sedes inactivas no ofrecen turnos (pero cuentan para decidir que SÍ configuró algo).
 */
export function publicOpeningRanges(input: {
  practitionerIds: ReadonlyArray<string>;
  rows: ReadonlyArray<OpeningScheduleRow>;
  tenant: { businessHoursStart: number; businessHoursEnd: number };
}): OpeningRange[] {
  const hours = tenantHours(input.tenant);
  const out: OpeningRange[] = [];
  for (const pid of input.practitionerIds) {
    const own = input.rows.filter((r) => r.practitionerId === pid);
    if (own.length === 0) {
      for (const dow of FALLBACK_WORKING_DOWS) out.push({ dow, ...hours, validFrom: null, validUntil: null });
      continue;
    }
    for (const r of own) {
      if (!r.locationActive) continue;
      out.push({
        dow: r.dow,
        startMin: r.startMin,
        endMin: r.endMin,
        validFrom: dbDateToDayKey(r.validFrom),
        validUntil: dbDateToDayKey(r.validUntil),
      });
    }
  }
  return out;
}

/** «8», «8:30», «24». */
function hourLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? String(h) : `${h}:${String(m).padStart(2, "0")}`;
}

/** Une las franjas que se pisan o se tocan (dos profesionales 8-12 y 11-14 → 8-14). */
function merge(ranges: ReadonlyArray<{ startMin: number; endMin: number }>) {
  const sorted = [...ranges].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: { startMin: number; endMin: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMin <= last.endMin) last.endMin = Math.max(last.endMin, r.endMin);
    else out.push({ ...r });
  }
  return out;
}

/** [lun, mar, mié, vie] → «lun a mié y vie»; [lun, mar] → «lun y mar». */
function daysLabel(days: ReadonlyArray<number>): string {
  const idx = days.map((d) => WEEK_ORDER.indexOf(d as (typeof WEEK_ORDER)[number])).sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const i of idx) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1] === i - 1) run.push(i);
    else runs.push([i]);
  }
  const parts: string[] = [];
  for (const run of runs) {
    const first = DAY_SHORT[WEEK_ORDER[run[0]]];
    const last = DAY_SHORT[WEEK_ORDER[run[run.length - 1]]];
    if (run.length >= 3) parts.push(`${first} a ${last}`);
    else for (const i of run) parts.push(DAY_SHORT[WEEK_ORDER[i]]);
  }
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

/**
 * «Lun a vie 8 a 19 · Sáb 9 a 13». Toma las franjas vigentes HOY (día AR de `now`), las une por día y agrupa los
 * días con el mismo horario. Sin franjas vigentes → null (el turnero no muestra horario: mejor nada que uno falso).
 */
export function summarizeOpeningHours(ranges: ReadonlyArray<OpeningRange>, now: Date): string | null {
  const today = toARDateKey(now);
  const byDow = new Map<number, { startMin: number; endMin: number }[]>();
  for (const r of ranges) {
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) continue;
    const startMin = Math.max(0, r.startMin);
    const endMin = Math.min(MINUTES_PER_DAY, r.endMin);
    if (!(startMin < endMin)) continue;
    if (r.validFrom && r.validFrom > today) continue;
    if (r.validUntil && r.validUntil < today) continue;
    const list = byDow.get(r.dow) ?? [];
    list.push({ startMin, endMin });
    byDow.set(r.dow, list);
  }
  if (byDow.size === 0) return null;

  // Firma de horario por día → días con esa firma, en orden lunes-domingo.
  const groups = new Map<string, number[]>();
  for (const dow of WEEK_ORDER) {
    const list = byDow.get(dow);
    if (!list) continue;
    const sig = merge(list)
      .map((r) => `${hourLabel(r.startMin)} a ${hourLabel(r.endMin)}`)
      .join(" y ");
    groups.set(sig, [...(groups.get(sig) ?? []), dow]);
  }
  return [...groups.entries()]
    .map(([sig, days]) => {
      const label = daysLabel(days);
      return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${sig}`;
    })
    .join(" · ");
}
