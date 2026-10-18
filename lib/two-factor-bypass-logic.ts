/**
 * HF-3 (plan §22.4, D-HF7) · pausa TEMPORAL de la 2FA del superadmin · lógica PURA (sin `next/*`, sin env, sin logger).
 *
 * El porqué (H-2FA, §22.2): Martin pidió apagar la 2FA de su superadmin por un tiempo, y apagar el TOTP propio no
 * sirve: sin ningún método, cada step-up tira «Activá la verificación en dos pasos» y eso bloquea las acciones `high`
 * de Plataforma (`lib/platform-actor.ts`, `requireStepUp`). La salida es una pausa con fecha, por variable de entorno
 * (`SUPERADMIN_2FA_BYPASS="<userId>@AAAA-MM-DD[,<userId>@AAAA-MM-DD…]"`), que la carga Martin en Vercel; el agente
 * nunca lee el env.
 *
 * Falla CERRADO. Activa solo si TODO esto se cumple:
 *  - el usuario es superadmin (`UserProfile.isPlatformAdmin`) y no está deshabilitado (`disabledAt`);
 *  - `PLATFORM_MFA_ENFORCEMENT` no es `enforce` (con el TOTP de Plataforma obligatorio, la pausa no tiene sentido y
 *    sería una puerta trasera al mismo control);
 *  - la variable entera está bien formada: UNA entrada mal escrita invalida todas (un error de tipeo no puede terminar
 *    habilitando algo distinto de lo que se quiso);
 *  - su id está en la lista, exacto;
 *  - la fecha no venció: vale hasta el FIN de ese día en hora AR (en Vercel el host es UTC; `toARDateKey`);
 *  - vence a ≤30 días de hoy (D-HF7: 14 días recomendado, tope 30). Más lejos se ignora: una pausa «hasta 2099» es
 *    apagar la 2FA para siempre, y eso no es lo que se decidió.
 * Si el mismo id aparece dos veces, manda la fecha más cercana.
 */
import { toARDateKey } from "@/lib/datetime-ar";

export type TwoFactorBypassUser = { id: string; isPlatformAdmin: boolean; disabledAt: Date | null };

export type TwoFactorBypassInactiveReason =
  /** La variable no está o está vacía: el caso normal, sin ruido. */
  | "unset"
  /** No es superadmin, está deshabilitado o no hay perfil. */
  | "not_superadmin"
  /** `PLATFORM_MFA_ENFORCEMENT=enforce`. */
  | "enforce"
  /** Alguna entrada no es `<id>@AAAA-MM-DD` con una fecha real. */
  | "malformed"
  /** Su id no está en la lista. */
  | "not_listed"
  /** La fecha ya pasó (hora AR). */
  | "expired"
  /** La fecha cae a más de `TWO_FACTOR_BYPASS_MAX_DAYS` días. */
  | "too_far";

export type TwoFactorBypassDecision =
  | { active: true; /** AAAA-MM-DD, inclusive (hasta el fin de ese día AR). */ until: string }
  | { active: false; reason: TwoFactorBypassInactiveReason };

/** D-HF7: tope de la pausa. */
export const TWO_FACTOR_BYPASS_MAX_DAYS = 30;

// Ids de Supabase (UUID) y los de los tests (`test-user-…`). Sin `@`, coma ni espacios: el separador queda inequívoco.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Días desde el 1/1/1970 de una fecha `AAAA-MM-DD` real; null si no existe (30/02, mes 13). */
function dayNumber(key: string): number | null {
  const m = DATE_RE.exec(key);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

type Entry = { userId: string; until: string; day: number };

/** null = mal formada. Segmentos vacíos (coma final, doble coma) se toleran: no habilitan nada. */
function parse(raw: string): Entry[] | null {
  const out: Entry[] = [];
  for (const seg of raw.split(",")) {
    const part = seg.trim();
    if (!part) continue;
    const at = part.indexOf("@");
    if (at <= 0 || at !== part.lastIndexOf("@")) return null;
    const userId = part.slice(0, at);
    const until = part.slice(at + 1);
    if (!ID_RE.test(userId)) return null;
    const day = dayNumber(until);
    if (day === null) return null;
    out.push({ userId, until, day });
  }
  return out;
}

export function twoFactorBypassDecision(i: {
  raw: string | null | undefined;
  enforcement: "off" | "enforce";
  user: TwoFactorBypassUser | null;
  now: Date;
}): TwoFactorBypassDecision {
  // El `trim` también recorta el salto de línea que queda al pegar el valor en Vercel (la lección de H-RT1).
  const raw = i.raw?.trim() ?? "";
  if (!raw) return { active: false, reason: "unset" };
  if (!i.user || !i.user.isPlatformAdmin || i.user.disabledAt) return { active: false, reason: "not_superadmin" };
  if (i.enforcement === "enforce") return { active: false, reason: "enforce" };
  const entries = parse(raw);
  if (!entries) return { active: false, reason: "malformed" };
  const mine = entries.filter((e) => e.userId === i.user!.id).sort((a, b) => a.day - b.day)[0];
  if (!mine) return { active: false, reason: "not_listed" };
  const today = dayNumber(toARDateKey(i.now))!;
  if (mine.day < today) return { active: false, reason: "expired" };
  if (mine.day - today > TWO_FACTOR_BYPASS_MAX_DAYS) return { active: false, reason: "too_far" };
  return { active: true, until: mine.until };
}

/** «31/10» (AR, sin año: la pausa vence a ≤30 días). Desde la clave, sin `Date` ni zona horaria del host. */
export function formatBypassUntil(until: string): string {
  const m = DATE_RE.exec(until);
  return m ? `${m[3]}/${m[2]}` : until;
}

/** Copy fijo de la banda (Plataforma y `/cuenta/seguridad`). */
export function twoFactorBypassBandCopy(until: string): string {
  return `La verificación en dos pasos está en pausa para tu usuario hasta el ${formatBypassUntil(until)}. Volvé a activarla antes de esa fecha.`;
}
