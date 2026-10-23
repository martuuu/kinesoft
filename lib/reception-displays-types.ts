/**
 * TV (T7, §26.4 C-TV): tipos, constantes y schemas de las pantallas de la sala de espera. APTO CLIENTE: sin import de
 * valores de `@prisma/client` (los enums de M17 se espejan como uniones de string; `tests/unit/display-feed-state.test.ts`
 * los ata a Prisma en tipo y en runtime, así un valor nuevo en el enum rompe ahí y no en un `switch` sin rama en la TV).
 *
 * Lo usan las tres caras: el staff (`lib/reception-displays.ts`, drawer «Pantallas» de /sala), el dispositivo
 * (`lib/display-device.ts`, `/tv`) y la lógica pura del feed (`lib/display-feed-state.ts`).
 *
 * Regla de PHI del feed: lo único que sale hacia la TV es `DisplayFeed`, y pasa por `DisplayFeedSchema` (strict en cada
 * nivel): una clave de más (un `patientId`, un `service`, el nombre completo) hace fallar el parse en el server en vez de
 * pintarse en una pantalla que mira toda la sala. `DisplayListItem` (staff) tampoco lleva nunca los hashes del código ni
 * del secreto del dispositivo.
 */
import { z } from "zod";

// ── Enums de M17 espejados ──────────────────────────────────────────────────
export type DisplayNameMode = "SHORT_NAME" | "TURN_TIME";
export const DISPLAY_NAME_MODES = ["SHORT_NAME", "TURN_TIME"] as const satisfies readonly DisplayNameMode[];

export type DisplayTheme = "DARK" | "LIGHT";
export const DISPLAY_THEMES = ["DARK", "LIGHT"] as const satisfies readonly DisplayTheme[];

export type DisplayMediaKind = "NONE" | "VIDEO" | "LIVE" | "PLAYLIST" | "CHANNEL_LIVE";
export const DISPLAY_MEDIA_KINDS = ["NONE", "VIDEO", "LIVE", "PLAYLIST", "CHANNEL_LIVE"] as const satisfies readonly DisplayMediaKind[];

export type DisplayMediaLayout = "SIDE" | "HERO_IDLE";
export const DISPLAY_MEDIA_LAYOUTS = ["SIDE", "HERO_IDLE"] as const satisfies readonly DisplayMediaLayout[];

export type DisplayMediaDuringCall = "DUCK" | "HIDE" | "KEEP";
export const DISPLAY_MEDIA_DURING_CALL = ["DUCK", "HIDE", "KEEP"] as const satisfies readonly DisplayMediaDuringCall[];

// ── Cookie del dispositivo (TV-D7) ──────────────────────────────────────────
/** Cookie httpOnly, `SameSite=Strict`, `path` `/tv`: no viaja a ninguna otra ruta de la app (ni a /sala del staff). */
export const DISPLAY_COOKIE = "kine_tv";
export const DISPLAY_COOKIE_PATH = "/tv";
/** 180 días: una TV de sala no se re-vincula cada semana; revocar desde /sala la corta en el acto igual. */
export const DISPLAY_COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;
/** Renovación deslizante: pasado este tiempo desde el día emitido en la cookie, el server la vuelve a setear. */
export const DISPLAY_COOKIE_RENEW_AFTER_DAYS = 30;

// ── Código de vinculación (TV-D6) ───────────────────────────────────────────
/**
 * Alfabeto Crockford base32: sin I, L, O ni U, así un código dictado o leído de lejos no confunde 1/I/L ni 0/O.
 * 8 caracteres = 40 bits; con TTL de 10 min, un solo uso y el rate limit de `pairDisplay` no se adivina.
 */
export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LEN = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Copy único ante cualquier fallo de vinculación (§26.4): no distingue «no existe» de «venció» ni de «ya usado». */
export const PAIR_FAILED_MESSAGE = "El código no es válido o venció. Pedí uno nuevo en Sala de espera → Pantallas.";

// ── Tiempos y topes de la pantalla (TV-D8, TV-D11) ──────────────────────────
export const FEED_POLL_MS = 15_000;
/** El hero muestra el último llamado hasta 10 min; después la pantalla vuelve a «Te damos la bienvenida». */
export const HERO_HOLD_MS = 600_000;
export const RECENT_MAX = 3;
export const RECENT_WINDOW_MS = 3_600_000;
export const WAITING_MAX = 12;
export const MAX_LIVE_DISPLAYS = 10;
/** Con `DUCK`, el video baja el volumen este tiempo al entrar un llamado. */
export const DUCK_MS = 12_000;
/** Con `HERO_IDLE`, cada llamado interrumpe el video que ocupa el hero este tiempo. */
export const HERO_IDLE_CALL_MS = 15_000;
/**
 * «En línea» en el drawer: 3 min desde `lastSeenAt`. La TV pide el feed cada 15 s pero `touchDisplaySeen` escribe a lo
 * sumo una vez por minuto (§26.4), así que una ventana menor a ~2 min parpadearía entre online y offline con la TV sana.
 */
export const ONLINE_WINDOW_MS = 3 * 60_000;

/**
 * Lo que tipeó la persona → código canónico de 8 caracteres, o `null` si no lo es. Mayúsculas, sin espacios ni guiones,
 * y las sustituciones de Crockford: O→0, I/L→1 (la U no tiene sustituto: queda inválida).
 */
export function normalizePairingCode(raw: string | null | undefined): string | null {
  const s = cleanPairingCodeInput(raw);
  return PAIRING_CODE_RE.test(s) ? s : null;
}

/**
 * Normalización parcial para el input de la TV mientras se tipea: mismas sustituciones, sin exigir el largo y sin
 * descartar nada más (así el campo no «come» lo que la persona escribe). La validación final es `normalizePairingCode`.
 */
export function cleanPairingCodeInput(raw: string | null | undefined): string {
  return (raw ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

/** `ABCDEFGH` → `ABCD-EFGH` (cómo se muestra en el drawer). Con menos de 5 caracteres no agrega el guion. */
export function formatPairingCode(code: string): string {
  const s = cleanPairingCodeInput(code);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

// ── Inputs del staff ────────────────────────────────────────────────────────
const idSchema = z.string().trim().min(1).max(64);

/**
 * Alta / edición. `mediaUrl` llega CRUDO (lo que pegó la persona, o `null` para sin video): el server lo pasa por
 * `parseYouTubeUrl` (`lib/youtube.ts`) y guarda solo `mediaKind` + `mediaRef`; la URL nunca se guarda ni llega al iframe.
 * `name` espeja `ReceptionDisplay_name_check` (1-60, sin espacios en los bordes: el trim va acá).
 */
export const DisplayUpsertSchema = z.object({
  name: z.string().trim().min(1, "Poné un nombre para la pantalla.").max(60, "Hasta 60 caracteres."),
  locationId: idSchema.nullable(),
  nameMode: z.enum(DISPLAY_NAME_MODES),
  theme: z.enum(DISPLAY_THEMES),
  mediaUrl: z.string().trim().max(2048).nullable(),
  mediaLayout: z.enum(DISPLAY_MEDIA_LAYOUTS),
  mediaMuted: z.boolean(),
  mediaDuringCall: z.enum(DISPLAY_MEDIA_DURING_CALL),
});
export type DisplayUpsertInput = z.input<typeof DisplayUpsertSchema>;
export type DisplayUpsertValues = z.output<typeof DisplayUpsertSchema>;

/** Edición con CAS: `expectedUpdatedAt` es el `updatedAt` que vio el drawer (otro cambio en el medio → error). */
export const DisplayUpdateSchema = DisplayUpsertSchema.extend({
  id: idSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});
export type DisplayUpdateInput = z.input<typeof DisplayUpdateSchema>;

export const DisplayIdSchema = z.object({ id: idSchema });
export type DisplayIdInput = z.input<typeof DisplayIdSchema>;

/** `pairDisplay`: el código crudo (el server lo normaliza; uno inválido da `PAIR_FAILED_MESSAGE`, igual que uno vencido). */
export const PairDisplaySchema = z.object({ code: z.string().max(32) });
export type PairDisplayInput = z.input<typeof PairDisplaySchema>;

// ── Salidas del staff ───────────────────────────────────────────────────────
/** Estado del chip del drawer (`displayStatus`). */
export type DisplayStatus = "online" | "offline" | "pairing" | "unpaired";

/** Fila del drawer «Pantallas». Solo pantallas vivas (sin `revokedAt`). NUNCA lleva `pairingCodeHash` ni `deviceSecretHash`. */
export type DisplayListItem = {
  id: string;
  name: string;
  locationId: string | null;
  locationName: string | null;
  nameMode: DisplayNameMode;
  theme: DisplayTheme;
  mediaKind: DisplayMediaKind;
  mediaRef: string | null;
  mediaLayout: DisplayMediaLayout;
  mediaMuted: boolean;
  mediaDuringCall: DisplayMediaDuringCall;
  /** ISO. Hay un dispositivo vinculado (`deviceSecretHash` presente). */
  pairedAt: string | null;
  lastSeenAt: string | null;
  /** ISO. Hay un código vivo (solo su vencimiento: el código en claro se muestra una vez, al generarlo). */
  pairingExpiresAt: string | null;
  createdAt: string;
  /** ISO, para el CAS de `updateReceptionDisplay`. */
  updatedAt: string;
};

/** El código recién generado: la ÚNICA vez que sale en claro (formateado `ABCD-EFGH`). */
export type DisplayPairingCode = { code: string; expiresAt: string };

export type DisplaysPanel = {
  displays: DisplayListItem[];
  /** Sedes activas del consultorio para el select (la sede elegida se valida igual en el server). */
  locations: { id: string; name: string }[];
  maxLive: number;
};

// ── Feed del dispositivo (C-TV, PHI) ────────────────────────────────────────
/**
 * Un renglón de la TV. `key` = sha256(`bookingId|calledAt`) en base64url recortado a 16 (identifica el llamado sin
 * revelar el id); `label` = «María G.» o «Turno de las 10:30». Nada de apellido, DNI, teléfono, servicio, notas ni ids.
 */
export type DisplayFeedItem = { key: string; label: string; room: string | null; practitioner: string | null; calledAt: string | null };

/** Lo que la TV necesita de la configuración de la pantalla (sin la sede ni nada del staff). */
export type DisplayConfig = {
  nameMode: DisplayNameMode;
  theme: DisplayTheme;
  mediaKind: DisplayMediaKind;
  mediaRef: string | null;
  mediaLayout: DisplayMediaLayout;
  mediaMuted: boolean;
  mediaDuringCall: DisplayMediaDuringCall;
};

export type DisplayFeed = {
  v: 1;
  /** ISO del server: la TV corrige el desfase de su reloj con esto. */
  serverNow: string;
  /** Día AR `YYYY-MM-DD`. */
  dayKey: string;
  clinicName: string;
  locationName: string | null;
  config: DisplayConfig;
  hero: DisplayFeedItem | null;
  recent: DisplayFeedItem[];
  waiting: DisplayFeedItem[];
  /** Total de esperando (la lista se corta en `WAITING_MAX`). */
  waitingCount: number;
};

export type DeviceFeedResult = { ok: true; feed: DisplayFeed } | { ok: false; state: "unpaired" | "revoked" | "unavailable" | "rate_limited" };

const isoSchema = z.string().datetime({ offset: true });

export const DisplayFeedItemSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    label: z.string().min(1).max(80),
    room: z.string().max(80).nullable(),
    practitioner: z.string().max(80).nullable(),
    calledAt: isoSchema.nullable(),
  })
  .strict();

export const DisplayConfigSchema = z
  .object({
    nameMode: z.enum(DISPLAY_NAME_MODES),
    theme: z.enum(DISPLAY_THEMES),
    mediaKind: z.enum(DISPLAY_MEDIA_KINDS),
    mediaRef: z.string().max(64).nullable(),
    mediaLayout: z.enum(DISPLAY_MEDIA_LAYOUTS),
    mediaMuted: z.boolean(),
    mediaDuringCall: z.enum(DISPLAY_MEDIA_DURING_CALL),
  })
  .strict();

/** Whitelist estricta de lo que sale hacia la TV (§26.4 «La salida pasa por `DisplayFeedSchema.strict()`»). */
export const DisplayFeedSchema = z
  .object({
    v: z.literal(1),
    serverNow: isoSchema,
    dayKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    clinicName: z.string().max(120),
    locationName: z.string().max(120).nullable(),
    config: DisplayConfigSchema,
    hero: DisplayFeedItemSchema.nullable(),
    recent: z.array(DisplayFeedItemSchema).max(RECENT_MAX),
    waiting: z.array(DisplayFeedItemSchema).max(WAITING_MAX),
    waitingCount: z.number().int().min(0),
  })
  .strict();
