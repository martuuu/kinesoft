/**
 * Ingresos del dashboard (S14r, ES3 · plan §16.2), parte PURA.
 *
 * Antes de S14r el widget sumaba solo los `Payment` PAID de Mercado Pago: el
 * copago que se cobra en mano (Facturación → "Copago cobrado", el caso más
 * común del consultorio) no aparecía nunca, y el "% obras sociales" salía de
 * los pagos de MP de pacientes CON cobertura (que es plata del paciente, no de
 * la OS). Ahora (decisión 6 del §16.1):
 *   - ingresos = `Payment` PAID de MP + copagos cobrados a mano
 *     (`paymentStatus PAID` con `copagoPaidAt` en el período) sin contar dos
 *     veces un turno que ya tiene su `Payment` de MP PAID;
 *   - la obra social va APARTE (`insurerPaidAt` en el período, por el arancel
 *     resuelto `Insurer.fixedFeeCents`): no suma en "ingresos", igual que en el
 *     saldo del plan (decisión 2: lo que paga la OS se informa aparte).
 *
 * Sin DB, sin reloj propio (`now` entra por parámetro), client-safe: el server
 * (`lib/dashboard.ts`) arma los períodos y el resumen con esto y la UI usa los
 * títulos. Se testea unit en TZ=UTC y TZ=AR.
 */
import type { Capability } from "@/lib/capabilities";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import type { RevenueRange } from "@/lib/preferences-constants";

export type { RevenueRange } from "@/lib/preferences-constants";

const DAY_MS = 86_400_000;

/** Intervalos semiabiertos `[start, end)`: el actual y el anterior del mismo largo de calendario. */
export type RevenuePeriod = {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
};

/** "YYYY-MM" de AR desplazado `delta` meses (cruza años). */
function shiftYm(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const abs = y * 12 + (m - 1) + delta;
  const ny = Math.floor(abs / 12);
  const nm = abs - ny * 12;
  return `${ny}-${String(nm + 1).padStart(2, "0")}`;
}

const arMidnight = (dayKey: string) => new Date(localToARIso(`${dayKey}T00:00:00`));

/**
 * Período AR que contiene `now`:
 *   - `week`: lunes 00:00 AR → lunes siguiente 00:00 AR (convención AR, igual
 *     que `startOfWeek` de `lib/dashboard.ts`); el anterior, la semana previa.
 *   - `month`: día 1 00:00 AR → día 1 del mes siguiente; el anterior, el mes
 *     calendario previo completo.
 * Todo anclado al reloj AR con `lib/datetime-ar.ts`: en un host UTC (Vercel)
 * el domingo 23:30 AR ya es lunes 02:30 UTC y un `getDay()` del host lo
 * mandaría a la semana siguiente. AR no tiene DST: pasos de 24 h exactos.
 */
export function revenuePeriod(range: RevenueRange, now: Date): RevenuePeriod {
  const dayKey = toARDateKey(now);
  if (range === "week") {
    const today = arMidnight(dayKey);
    const mondayOffset = (toARDow(today) + 6) % 7; // 0 = lunes
    const start = new Date(today.getTime() - mondayOffset * DAY_MS);
    return {
      start,
      end: new Date(start.getTime() + 7 * DAY_MS),
      prevStart: new Date(start.getTime() - 7 * DAY_MS),
      prevEnd: start,
    };
  }
  const ym = dayKey.slice(0, 7);
  const start = arMidnight(`${ym}-01`);
  return {
    start,
    end: arMidnight(`${shiftYm(ym, 1)}-01`),
    prevStart: arMidnight(`${shiftYm(ym, -1)}-01`),
    prevEnd: start,
  };
}

/** Montos crudos de UN período (centavos `Int`). */
export type RevenueAmounts = {
  /** `Payment` PAID de Mercado Pago. */
  mpCents: number;
  /** Copagos cobrados a mano (sin los turnos que ya tienen `Payment` de MP PAID). */
  manualCents: number;
  /** Arancel de la obra social confirmado (`insurerPaidAt`). Va aparte. */
  insurerCents: number;
};

export type RevenueSummary = {
  range: RevenueRange;
  /** Ingresos del período = MP + copagos a mano. La OS NO suma acá. */
  totalCents: number;
  mpCents: number;
  manualCents: number;
  /** Obra social del período, aparte. */
  insurerCents: number;
  /** Ingresos (MP + copagos) del período anterior completo. */
  prevTotalCents: number;
  /** % vs el período anterior; `null` si el anterior fue 0 (no hay base). */
  deltaPct: number | null;
  /** Reparto pacientes vs obra social sobre (ingresos + OS), en % enteros que suman 100 (o 0 y 0). */
  privateShare: number;
  insurerShare: number;
};

export function summarizeRevenue(
  range: RevenueRange,
  current: RevenueAmounts,
  previous: Pick<RevenueAmounts, "mpCents" | "manualCents">
): RevenueSummary {
  const totalCents = current.mpCents + current.manualCents;
  const prevTotalCents = previous.mpCents + previous.manualCents;
  const all = totalCents + current.insurerCents;
  const privateShare = all ? Math.round((totalCents / all) * 100) : 0;
  return {
    range,
    totalCents,
    mpCents: current.mpCents,
    manualCents: current.manualCents,
    insurerCents: current.insurerCents,
    prevTotalCents,
    deltaPct: prevTotalCents ? Math.round(((totalCents - prevTotalCents) / prevTotalCents) * 100) : null,
    privateShare,
    insurerShare: all ? 100 - privateShare : 0,
  };
}

/**
 * SR-D5I · qué ingresos ve el actor (decisión de Martin, 08-oct: "Ingresos del
 * dashboard restringidos: cada Profesional ve sus ingresos").
 *
 *   - `tenant`: todo el consultorio. `billing.manage` = OWNER, ADMIN, BILLING.
 *   - `own`: solo los turnos cuyo `Booking.practitionerId` es el del actor
 *     (PRACTITIONER: tiene `clinical.read` y no `billing.manage`).
 *   - `none`: nada (ASSISTANT / Secretaria, o un actor sin profesional): el widget y la KPI no se
 *     renderizan y `getRevenue` devuelve error. Sin membresía (caps vacías)
 *     también cae acá: falla cerrado.
 *
 * NO se deriva de `visibilityForActor`: con `Tenant.sharedPatientView` esa
 * función le da `seesAll` a un PRACTITIONER (es visibilidad de PACIENTES, no
 * de plata) y le mostraría la caja de todo el consultorio.
 *
 * Atribución: el ingreso va al profesional ACTUAL del turno. Si un turno
 * cobrado se reasigna a otro profesional, la plata ya cobrada se muda con él
 * (no hay un "cobrado por" congelado al cobrar). El filtro de OWNER por
 * profesional quedó para C0.
 */
export type RevenueScope = { kind: "tenant" } | { kind: "own"; practitionerId: string } | { kind: "none" };
export type RevenueScopeKind = RevenueScope["kind"];

export function revenueScopeFor(caps: ReadonlySet<Capability>, practitionerId: string | null): RevenueScope {
  if (caps.has("billing.manage")) return { kind: "tenant" };
  // IAM-4a: `practitionerId` es null para los roles no clínicos. Un clínico sin profesional no debería existir
  // (`buildActor`), pero si pasara: `none`, nunca `own` con null (sería «los turnos sin profesional»).
  if (caps.has("clinical.read") && practitionerId) return { kind: "own", practitionerId };
  return { kind: "none" };
}

/**
 * Token del scope para la clave de `unstable_cache`. Va EXPLÍCITO en los
 * `keyParts` (además de viajar en los argumentos): sin él, dos profesionales
 * del mismo consultorio compartirían la entrada y el segundo vería la plata
 * del primero durante el TTL.
 */
export function revenueScopeKey(s: RevenueScope): string {
  return s.kind === "own" ? `own:${s.practitionerId}` : s.kind;
}

/**
 * Título del widget (copy literal del plan §16.2). Con scope `own` (SR-D5I) el
 * título aclara que son los ingresos del profesional, no los del consultorio.
 */
export function revenueTitle(range: RevenueRange, scope: RevenueScopeKind = "tenant"): string {
  if (scope === "own") return range === "week" ? "Tus ingresos de la semana" : "Tus ingresos del mes";
  return range === "week" ? "Ingresos de la semana" : "Ingresos del mes";
}

/** Texto del "vs período anterior". */
export function revenuePrevLabel(range: RevenueRange): string {
  return range === "week" ? "vs. la semana pasada" : "vs. el mes pasado";
}
