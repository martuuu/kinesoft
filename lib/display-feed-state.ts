/**
 * TV (T7, §26.4 C-TV): lógica pura del feed de la pantalla de la sala de espera. Sin DB, sin React, sin reloj propio
 * (`now` lo pasa el caller) y APTO CLIENTE: la TV importa `isNewCall` / `displayStatus` y el server
 * (`lib/display-device-internal.ts#loadDisplayFeed`) arma el feed con `buildDisplayFeed` + `finalizeDisplayFeed`.
 *
 * Qué muestra la pantalla (D8, tiempos de `lib/reception-displays-types.ts`):
 *   hero      = el último llamado (`calledAt` más nuevo) de los últimos `HERO_HOLD_MS` (10 min, inclusive);
 *   recientes = los llamados anteriores (sin el hero) de los últimos `RECENT_WINDOW_MS` (60 min), del más nuevo al más
 *               viejo, hasta `RECENT_MAX` (3);
 *   esperando = llegó (`arrivedAt`), no llamado, no en atención y PENDING/CONFIRMED, por horario del turno, hasta
 *               `WAITING_MAX` (12) + `waitingCount` con el total (el encabezado dice «15 esperando» aunque entren 12).
 * Un turno CANCELLED / NO_SHOW no se anuncia aunque tenga `calledAt` (se canceló después de llamarlo). Uno COMPLETED
 * sí: lo atendieron rápido, pero el llamado existió y la sala lo vio; se va solo por la ventana.
 * No hay «re-llamado» (§26.4): Deshacer + Llamar deja otro `calledAt`, que es otro par `(bookingId, calledAt)` y por lo
 * tanto otra `key` → `isNewCall` vuelve a sonar.
 *
 * PHI: la entrada (`DisplayFeedRow`) trae el nombre completo; la salida solo `shortPatientName` («María G.») o la hora
 * del turno. Se construye cada item campo por campo (nunca `...row`), así lo que un select del server traiga de más no
 * viaja; `finalizeDisplayFeed` además pasa todo por `DisplayFeedSchema` (strict).
 *
 * `key`: sha256 implementado acá en JS puro (síncrono) en vez de `node:crypto` (no entra al bundle del cliente) o de
 * `crypto.subtle` (async: obligaría a `buildDisplayFeed` async y a un orden distinto en server y cliente). Se eligió la
 * implementación apta cliente sobre «pasarla como parámetro» para que la firma de C-TV quede `buildDisplayFeed(rows,
 * {nameMode, now})` y nadie arme keys con otro hash por error. El test la compara contra `node:crypto` con entradas
 * multibyte y de varios bloques. No es para secretos: es un identificador opaco del llamado (el id del turno no sale).
 */
import { shortPatientName } from "@/lib/patient-short-name";
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import {
  DisplayFeedSchema,
  HERO_HOLD_MS,
  ONLINE_WINDOW_MS,
  RECENT_MAX,
  RECENT_WINDOW_MS,
  WAITING_MAX,
  type DisplayConfig,
  type DisplayFeed,
  type DisplayFeedItem,
  type DisplayListItem,
  type DisplayNameMode,
  type DisplayStatus,
} from "@/lib/reception-displays-types";

/** Lo que el server lee de cada turno del día (AR) con `arrivedAt` presente. `room` / `practitioner` ya resueltos a texto. */
export type DisplayFeedRow = {
  bookingId: string;
  startTime: Date | string;
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";
  /** `firstName lastName` del paciente; `null` en un guest. */
  patientName: string | null;
  guestName: string | null;
  arrivedAt: Date | string | null;
  calledAt: Date | string | null;
  attendingAt: Date | string | null;
  room: string | null;
  practitioner: string | null;
};

export type DisplayFeedLists = Pick<DisplayFeed, "hero" | "recent" | "waiting" | "waitingCount">;

const ms = (d: Date | string) => (typeof d === "string" ? Date.parse(d) : d.getTime());
const iso = (d: Date | string) => new Date(ms(d)).toISOString();

/** «Turno de las 10:30» con la hora AR del turno (nunca la del host: en Vercel es UTC). */
function turnTimeLabel(startTime: Date | string): string {
  const m = toARMinutes(startTime);
  return `Turno de las ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Etiqueta pública del turno. SHORT_NAME = `shortPatientName` del paciente o, en un guest, del `guestName`; sin ningún
 * nombre utilizable cae a la hora del turno (mejor que un renglón vacío en la TV). TURN_TIME nunca muestra nombre.
 */
export function displayLabel(row: Pick<DisplayFeedRow, "startTime" | "patientName" | "guestName">, nameMode: DisplayNameMode): string {
  if (nameMode === "SHORT_NAME") {
    const short = shortPatientName(row.patientName ?? row.guestName ?? "");
    if (short) return short.slice(0, 80);
  }
  return turnTimeLabel(row.startTime);
}

/** sha256(`bookingId|calledAt ISO`) → base64url → 16 caracteres. Sin llamado: `bookingId|`. */
export function feedKey(bookingId: string, calledAt: Date | string | null): string {
  return base64url(sha256(utf8(`${bookingId}|${calledAt == null ? "" : iso(calledAt)}`))).slice(0, 16);
}

function toItem(row: DisplayFeedRow, nameMode: DisplayNameMode): DisplayFeedItem {
  const text = (s: string | null) => {
    const t = s?.trim();
    return t ? t.slice(0, 80) : null;
  };
  return {
    key: feedKey(row.bookingId, row.calledAt),
    label: displayLabel(row, nameMode),
    room: text(row.room),
    practitioner: text(row.practitioner),
    calledAt: row.calledAt == null ? null : iso(row.calledAt),
  };
}

const ANNOUNCEABLE = new Set<DisplayFeedRow["status"]>(["PENDING", "CONFIRMED", "COMPLETED"]);
const WAITING_STATUSES = new Set<DisplayFeedRow["status"]>(["PENDING", "CONFIRMED"]);

export function buildDisplayFeed(rows: readonly DisplayFeedRow[], opts: { nameMode: DisplayNameMode; now: Date }): DisplayFeedLists {
  const now = opts.now.getTime();

  // Un `calledAt` levemente en el futuro (reloj de la base vs. el del server) cuenta como «recién»: si no, el llamado
  // se perdería hasta el próximo poll.
  const calls = rows
    .filter((r) => r.calledAt != null && ANNOUNCEABLE.has(r.status) && now - ms(r.calledAt) <= RECENT_WINDOW_MS)
    .sort((a, b) => ms(b.calledAt!) - ms(a.calledAt!) || (a.bookingId < b.bookingId ? -1 : 1));

  const heroRow = calls.length > 0 && now - ms(calls[0].calledAt!) <= HERO_HOLD_MS ? calls[0] : null;
  const recentRows = (heroRow ? calls.slice(1) : calls).slice(0, RECENT_MAX);

  const waitingRows = rows
    .filter((r) => r.arrivedAt != null && r.calledAt == null && r.attendingAt == null && WAITING_STATUSES.has(r.status))
    .sort((a, b) => ms(a.startTime) - ms(b.startTime) || ms(a.arrivedAt!) - ms(b.arrivedAt!) || (a.bookingId < b.bookingId ? -1 : 1));

  return {
    hero: heroRow ? toItem(heroRow, opts.nameMode) : null,
    recent: recentRows.map((r) => toItem(r, opts.nameMode)),
    waiting: waitingRows.slice(0, WAITING_MAX).map((r) => toItem(r, opts.nameMode)),
    waitingCount: waitingRows.length,
  };
}

/**
 * Feed final que sale hacia la TV: agrega la cabecera (`v`, `serverNow`, día AR) y lo pasa por `DisplayFeedSchema`
 * strict. Tira si algo no cumple la whitelist: preferible un 500 (la TV muestra «Reconectando…») a una clave de más
 * en pantalla.
 */
export function finalizeDisplayFeed(
  meta: { now: Date; clinicName: string; locationName: string | null; config: DisplayConfig },
  lists: DisplayFeedLists,
): DisplayFeed {
  return DisplayFeedSchema.parse({
    v: 1,
    serverNow: meta.now.toISOString(),
    dayKey: toARDateKey(meta.now),
    clinicName: meta.clinicName,
    locationName: meta.locationName,
    config: meta.config,
    hero: lists.hero,
    recent: lists.recent,
    waiting: lists.waiting,
    waitingCount: lists.waitingCount,
  });
}

/**
 * ¿Suena el chime / se anima el hero? Solo si el hero cambió respecto del feed anterior. `prevKey` = `undefined`
 * significa «todavía no hubo feed» (la TV recién carga o se recargó a las 04:00): no suena por un llamado viejo.
 * `null` = el feed anterior no tenía hero.
 */
export function isNewCall(prevKey: string | null | undefined, feed: Pick<DisplayFeed, "hero">): boolean {
  if (prevKey === undefined || !feed.hero) return false;
  return feed.hero.key !== prevKey;
}

/**
 * Chip del drawer «Pantallas». Un código vivo manda sobre el vínculo (se regeneró para mover la pantalla a otra TV: lo
 * que importa es la cuenta regresiva); después, vinculada = online si se la vio dentro de `ONLINE_WINDOW_MS`.
 */
export function displayStatus(item: Pick<DisplayListItem, "pairedAt" | "lastSeenAt" | "pairingExpiresAt">, now: Date): DisplayStatus {
  const t = now.getTime();
  if (item.pairingExpiresAt && ms(item.pairingExpiresAt) > t) return "pairing";
  if (item.pairedAt) {
    return item.lastSeenAt && t - ms(item.lastSeenAt) <= ONLINE_WINDOW_MS ? "online" : "offline";
  }
  return "unpaired";
}

// ── SHA-256 puro (FIPS 180-4), síncrono y apto cliente ─────────────────────
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sha256(msg: Uint8Array): Uint8Array {
  const bitLen = msg.length * 8;
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Largo en bits como entero de 64 bits big-endian (los ids nunca pasan de 2^32 bits: la parte alta es 0).
  view.setUint32(padded.length - 4, bitLen >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_0000_0000));

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += B64URL[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}
