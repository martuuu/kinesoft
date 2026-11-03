import "server-only";
/**
 * CF2 (A.4) — zod de entrada de `getAgendaMonthSummary`. `server-only` por la misma razón que
 * `availability-actions-schemas.ts` (D-PF5): zod no entra al JS inicial de /agenda.
 *
 * `from` tiene que ser LUNES (la grilla del Mes arranca en lunes: `monthGridRange`) y el rango ≤ 42 días
 * (`AGENDA_MONTH_MAX_DAYS`, 6 semanas): sin tope, un `from`/`to` a mano pediría años de turnos en una sentencia.
 */
import { z } from "zod";
import { dayKeyDiff, dowOfDayKey, isDayKey } from "@/lib/availability/day";
import { AGENDA_MONTH_MAX_DAYS } from "@/lib/agenda-month-types";

const Id = z.string().trim().min(1).max(64);
const DayKeyZ = z.string().refine((s) => isDayKey(s), "Fecha inválida (YYYY-MM-DD)");

export const AgendaMonthQuery = z
  .object({
    from: DayKeyZ,
    to: DayKeyZ,
    // "" = todas (como el `OptId` de availability-actions-schemas).
    locationId: Id.nullish().or(z.literal("").transform(() => null)),
  })
  .superRefine((v, ctx) => {
    if (!isDayKey(v.from) || !isDayKey(v.to)) return;
    // `dowOfDayKey`: 0=Dom … 1=Lun (mediodía AR, sin reloj del host).
    if (dowOfDayKey(v.from) !== 1) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "La grilla del mes arranca en lunes." });
    }
    const span = dayKeyDiff(v.from, v.to);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "La fecha final es anterior a la inicial." });
    else if (span + 1 > AGENDA_MONTH_MAX_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Máximo ${AGENDA_MONTH_MAX_DAYS} días.` });
    }
  });

export type AgendaMonthQueryParsed = { from: string; to: string; locationId: string | null };
