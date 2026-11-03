/**
 * Reparto de % entre profesionales (CF2 · P.3, plan §29: decisión 4 de Martin + D-CF2-18/19) · tipos y copy.
 *
 * Client-safe (sin zod ni Prisma): lo importan el editor de Configuración → Profesionales → «Reparto», la caja
 * (`lib/caja-types.ts`) y el server (`lib/revenue-share.ts`, `lib/revenue-share-internal.ts`, `lib/caja-internal.ts`).
 *
 * Modelo (M21, tabla `PractitionerRevenueShare`): un profesional que DESTINA (giver) le pasa `shareBps` (1..10000,
 * 1 bps = 0,01 %) de lo cobrado a un profesional que RECIBE (receiver), solo sobre las fuentes marcadas. Decisión 4:
 * «completo, incluida la OS, y configurable por regla: cada profesional elige sobre cuáles de las 3 fuentes destina».
 * La vigencia es por INSTANTE (D-CF2-18): cambiar = cerrar la vigente en `now` + abrir otra desde `now`; un cambio
 * nunca altera lo ya cobrado. El % va en bps enteros para no hacer aritmética de plata con floats.
 */

/**
 * De dónde sale la plata cobrada (las 3 fuentes de la decisión 4):
 *   - `manual`: copagos cobrados en el consultorio (`copagoPaidAt`, a mano, netos de la seña online);
 *   - `online`: cobros online (Mercado Pago: `OnlineCharge` PAID y el `Payment` legado);
 *   - `insurer`: obra social (`insurerPaidAt` × arancel resuelto AL LEER, D-CF2-19).
 */
export type RevenueSource = "manual" | "online" | "insurer";

/** Orden fijo de columnas y casillas: Copagos · Online · Obra social. */
export const REVENUE_SOURCES = ["manual", "online", "insurer"] as const satisfies readonly RevenueSource[];

/** Sobre qué fuentes aplica una regla (las columnas `appliesManual/Online/Insurer`; al menos una, CHECK de M21). */
export type RevenueShareSources = Readonly<Record<RevenueSource, boolean>>;

/** Etiqueta larga: las casillas del editor (copy literal del brief P.3). */
export const REVENUE_SOURCE_LABEL: Readonly<Record<RevenueSource, string>> = {
  manual: "Copagos cobrados en el consultorio",
  online: "Cobros online",
  insurer: "Obra social",
};

/** Etiqueta corta: las columnas de la caja. */
export const REVENUE_SOURCE_SHORT_LABEL: Readonly<Record<RevenueSource, string>> = {
  manual: "Copagos",
  online: "Online",
  insurer: "Obra social",
};

/** Topes del % en bps (= CHECK `PractitionerRevenueShare_bps_check` de M21): 0,01 % … 100 %. */
export const SHARE_BPS_MIN = 1;
export const SHARE_BPS_MAX = 10_000;

/** Arista del grafo de reparto (solo las reglas VIGENTES cuentan para `validateShareGraph`). */
export type ShareEdge = {
  giverPractitionerId: string;
  receiverPractitionerId: string;
};

/**
 * Por qué se rechaza una regla nueva (D-CF2-18: «quien destina no puede recibir, y viceversa; sin cadenas ni ciclos
 * en v1»). `null` = válida.
 *   - `self`: se destina a sí mismo (también lo frena el CHECK `not_self` de la base);
 *   - `mutual`: el que recibe ya le destina al que destina (ciclo de 2);
 *   - `receiverGives`: el que recibe ya destina a un tercero (cadena);
 *   - `giverReceives`: el que destina ya recibe de alguien (cadena).
 */
export type ShareGraphError = "self" | "mutual" | "receiverGives" | "giverReceives";

/** Copy (voseo) de los rechazos y errores del editor y de las actions. */
export const SHARE_GRAPH_ERROR_COPY: Readonly<Record<ShareGraphError, string>> = {
  self: "Un profesional no puede destinarse un porcentaje a sí mismo.",
  mutual: "Ese profesional ya le destina un porcentaje a este. No pueden destinarse entre los dos.",
  receiverGives: "Quien recibe ya destina un porcentaje a otro profesional. Por ahora no se pueden encadenar repartos.",
  giverReceives: "Este profesional ya recibe un porcentaje de otro, así que no puede destinar. Por ahora no se pueden encadenar repartos.",
};

export const REVENUE_SHARE_COPY = {
  invalidPct: "Ingresá un porcentaje entre 0,01 y 100, con hasta 2 decimales.",
  noSources: "Elegí al menos una fuente sobre la que se destina.",
  /** Carrera (CAS con `expectedOpenId`, P2002 del único parcial o 23514 del trigger): otra pestaña cambió la regla. */
  conflict: "Cambió mientras lo editabas. Volvé a abrir el reparto y revisalo.",
  receiverNotBookable: "Solo puede recibir un profesional activo del consultorio.",
  noOpenRule: "Este profesional no tiene un reparto vigente.",
} as const;

/**
 * Una regla tal como la ve el editor y la caja («Reparto vigente»). Fechas en ISO (viajan por action/RSC).
 * `effectiveTo === null` = vigente. Los nombres ya vienen resueltos con `displayMemberName` (nunca el email).
 */
export type RevenueShareRuleView = {
  id: string;
  giverPractitionerId: string;
  giverName: string;
  receiverPractitionerId: string;
  receiverName: string;
  /** 1..10000 (0,01 % … 100 %). Para mostrar: `formatSharePct`. */
  shareBps: number;
  sources: RevenueShareSources;
  /** ISO del instante desde el que rige (inclusive). */
  effectiveFrom: string;
  /** ISO del instante en que se cerró (exclusive); `null` = vigente. */
  effectiveTo: string | null;
  /** Quién la creó / la cerró (nombre visible); `null` si el usuario ya no existe o es del sistema. */
  createdByName: string | null;
  closedByName: string | null;
};

/** Candidato a recibir: profesional activo y reservable del consultorio (`bookablePractitionerWhere`). */
export type RevenueShareReceiverOption = {
  practitionerId: string;
  name: string;
};

/**
 * Lo que devuelve `listRevenueShares()` (gate `tenant.sensitive`): TODAS las reglas del consultorio, vigentes e
 * históricas, ordenadas por `effectiveFrom` desc (el editor filtra por profesional con `rulesForGiver` /
 * `openRuleForGiver` / `openRulesReceivedBy` de `lib/revenue-share-logic.ts`), más los candidatos a recibir.
 */
export type RevenueShareListView = {
  rules: RevenueShareRuleView[];
  receivers: RevenueShareReceiverOption[];
};
