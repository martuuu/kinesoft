import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  SecretBoxError,
  mpCredentialAad,
  needsReseal,
  openSecret,
  sealSecret,
  sealedKid,
  waCredentialAad,
  type SecretBoxAad,
  type SecretBoxErrorCode,
} from "./secret-box";

/**
 * Re-sellado de `MpCredential` con la clave primaria de `SECRET_BOX_KEYS`
 * (C-TP1, TP-P1). Lo usa SOLO `scripts/secret-box-rotate.ts` (y su test); la
 * app nunca lo importa.
 *
 * Por qué así:
 *  - **CAS sobre `version` + los dos sobres viejos, SIN mover `version`.**
 *    `version` es el CAS del refresh rotativo de MP (cada refresh invalida el
 *    refresh token anterior). Si la rotación subiera `version`, un refresh que
 *    leyó antes perdería su CAS y el token nuevo que MP ya emitió se tiraría:
 *    la cuenta quedaría sin refresh válido. Sin subirla, gana siempre el
 *    refresh (sus sobres ya salen con la clave primaria) y, si el refresh
 *    escribió primero, el UPDATE de la rotación no matchea y se cuenta como
 *    `conflicts` (la fila ya está bien). Comparar también los sobres cubre a
 *    cualquier otro escritor (reconectar) que no mueva `version`.
 *  - **Los dos sobres juntos y con `keyId`**: el CHECK de M18 exige que ambos
 *    tengan el kid de `keyId`.
 *  - **El dry-run abre cada sobre a re-sellar**: antes de retirar una clave
 *    vieja, `failed` tiene que dar 0 (si no, esas cuentas quedarían
 *    irrecuperables y hay que reconectarlas). Las fallas salen con id y código,
 *    nunca con el sobre ni el token.
 *  - **Keyset por id** en lotes: estable aunque otras filas cambien en el medio.
 *  - **Store inyectable**: el store real usa SQL crudo con columnas
 *    explícitas y el unit test uno en memoria con la misma semántica. Nació
 *    así porque en T5a el cliente Prisma todavía no conocía `MpCredential`
 *    (llegó con M18); hoy sí la conoce, y el SQL crudo se queda igual: fija
 *    las columnas que se leen y escriben (nunca otra) y es el mismo patrón
 *    que `WhatsAppCredential` (M15) abajo.
 *
 * WA-S1 (T6, M15): `WhatsAppCredential` (token del system user + PIN del número, propósito `wa-credential`) usa la
 * misma clave primaria y se rota con el MISMO núcleo (`resealRows`): un solo algoritmo de CAS, dry-run y fallas para
 * los dos stores, así un arreglo en uno no se olvida en el otro. Mismas reglas: CAS sobre `version` + los dos sobres
 * sin mover `version` (en WA la sube reconectar: una rotación que corre mientras el Titular reconecta pierde el CAS y
 * cuenta `conflicts`, la fila ya quedó con la primaria), los dos sobres juntos y con `keyId` (CHECK
 * `WhatsAppCredential_box_check` de M15), SQL crudo con BYPASSRLS (la tabla es SERVICE_ONLY).
 */

export type MpCredentialBoxRow = {
  id: string;
  mpAccountId: string;
  keyId: string;
  accessTokenBox: string;
  refreshTokenBox: string;
  version: number;
};

export interface MpCredentialBoxStore {
  /** Filas con `id > cursorId` (o desde el principio), ordenadas por id, a lo sumo `take`. */
  listAfter(cursorId: string | null, take: number): Promise<MpCredentialBoxRow[]>;
  /** UPDATE condicionado; true si escribió exactamente la fila esperada. */
  casUpdate(
    expected: Pick<MpCredentialBoxRow, "id" | "version" | "accessTokenBox" | "refreshTokenBox">,
    next: Pick<MpCredentialBoxRow, "keyId" | "accessTokenBox" | "refreshTokenBox">,
  ): Promise<boolean>;
}

export type ResealResult = {
  scanned: number;
  /** Filas re-selladas (0 en dry-run). */
  resealed: number;
  /** Filas a re-sellar que no abren con las claves actuales. */
  failed: number;
  /** Filas por `keyId` ANTES de re-sellar. */
  byKid: Record<string, number>;
  /** Extensión: filas que no están (las dos) con la clave primaria, incluidas las que fallan. */
  pending: number;
  /** Extensión: CAS perdidos (otro escritor tocó la fila; ya quedó con la primaria). */
  conflicts: number;
  /** Extensión: hasta 50 fallas con id y código, sin material. */
  failures: { id: string; code: SecretBoxErrorCode | "unexpected" }[];
};

const MAX_FAILURES_LISTED = 50;

/** Lo que el núcleo necesita saber de un store: sus dos sobres, con qué AAD abre cada uno y cómo se arma el CAS. */
type ResealSpec<Row extends { id: string; keyId: string }, Expected, Next> = {
  boxes: (row: Row) => [string, string];
  aads: (row: Row) => [SecretBoxAad, SecretBoxAad];
  expected: (row: Row) => Expected;
  next: (keyId: string, boxes: [string, string]) => Next;
};

async function resealRows<Row extends { id: string; keyId: string }, Expected, Next>(
  opts: { apply: boolean; batchSize?: number },
  store: { listAfter(cursorId: string | null, take: number): Promise<Row[]>; casUpdate(e: Expected, n: Next): Promise<boolean> },
  spec: ResealSpec<Row, Expected, Next>,
): Promise<ResealResult> {
  const batchSize = opts.batchSize ?? 100;
  const result: ResealResult = {
    scanned: 0,
    resealed: 0,
    failed: 0,
    byKid: {},
    pending: 0,
    conflicts: 0,
    failures: [],
  };

  let cursor: string | null = null;
  for (;;) {
    const rows = await store.listAfter(cursor, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      result.scanned++;
      result.byKid[row.keyId] = (result.byKid[row.keyId] ?? 0) + 1;
      const [boxA, boxB] = spec.boxes(row);
      const stale =
        needsReseal(boxA) || needsReseal(boxB) || sealedKid(boxA) !== row.keyId || sealedKid(boxB) !== row.keyId;
      if (!stale) continue;
      result.pending++;

      let next: Next;
      try {
        const [aadA, aadB] = spec.aads(row);
        const a = sealSecret(openSecret(boxA, aadA), aadA);
        const b = sealSecret(openSecret(boxB, aadB), aadB);
        next = spec.next(sealedKid(a)!, [a, b]);
      } catch (e) {
        result.failed++;
        if (result.failures.length < MAX_FAILURES_LISTED) {
          result.failures.push({ id: row.id, code: e instanceof SecretBoxError ? e.code : "unexpected" });
        }
        continue;
      }
      if (!opts.apply) continue;
      const ok = await store.casUpdate(spec.expected(row), next);
      if (ok) result.resealed++;
      else result.conflicts++;
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) break;
  }
  return result;
}

function checkBatchSize(batchSize: number | undefined): void {
  const n = batchSize ?? 100;
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Error("[secret-box-rotate] batchSize tiene que ser un entero entre 1 y 1000.");
  }
}

export async function resealMpCredentials(opts: {
  apply: boolean;
  batchSize?: number;
  store?: MpCredentialBoxStore;
}): Promise<ResealResult> {
  checkBatchSize(opts.batchSize);
  // Falla temprano (no_keys / bad_keys) antes de leer nada: sellar con qué.
  sealSecret("probe", mpCredentialAad("probe", "accessToken"));
  const store = opts.store ?? (await defaultStore());
  return resealRows(opts, store, {
    boxes: (r) => [r.accessTokenBox, r.refreshTokenBox],
    aads: (r) => [mpCredentialAad(r.mpAccountId, "accessToken"), mpCredentialAad(r.mpAccountId, "refreshToken")],
    expected: (r) => ({ id: r.id, version: r.version, accessTokenBox: r.accessTokenBox, refreshTokenBox: r.refreshTokenBox }),
    next: (keyId, [accessTokenBox, refreshTokenBox]) => ({ keyId, accessTokenBox, refreshTokenBox }),
  });
}

// ── WhatsApp (WA-S1, M15) ───────────────────────────────────────────────────────────────────────────────────────

export type WaCredentialBoxRow = {
  id: string;
  accountId: string;
  keyId: string;
  tokenBox: string;
  pinBox: string;
  version: number;
};

export interface WaCredentialBoxStore {
  listAfter(cursorId: string | null, take: number): Promise<WaCredentialBoxRow[]>;
  casUpdate(
    expected: Pick<WaCredentialBoxRow, "id" | "version" | "tokenBox" | "pinBox">,
    next: Pick<WaCredentialBoxRow, "keyId" | "tokenBox" | "pinBox">,
  ): Promise<boolean>;
}

export async function resealWaCredentials(opts: {
  apply: boolean;
  batchSize?: number;
  store?: WaCredentialBoxStore;
}): Promise<ResealResult> {
  checkBatchSize(opts.batchSize);
  sealSecret("probe", waCredentialAad("probe", "token"));
  const store = opts.store ?? (await defaultWaStore());
  return resealRows(opts, store, {
    boxes: (r) => [r.tokenBox, r.pinBox],
    aads: (r) => [waCredentialAad(r.accountId, "token"), waCredentialAad(r.accountId, "pin")],
    expected: (r) => ({ id: r.id, version: r.version, tokenBox: r.tokenBox, pinBox: r.pinBox }),
    next: (keyId, [tokenBox, pinBox]) => ({ keyId, tokenBox, pinBox }),
  });
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Store real sobre `"MpCredential"` con SQL crudo (columnas de M18 explícitas).
 * Requiere una conexión con BYPASSRLS: la tabla es SERVICE_ONLY (RLS sin
 * policies), así que con el rol de la app se verían 0 filas y el dry-run
 * diría "nada que rotar". Ver `assertResealBypassRls`.
 */
export function prismaMpCredentialStore(db: Db): MpCredentialBoxStore {
  return {
    async listAfter(cursorId, take) {
      const rows = cursorId === null
        ? await db.$queryRaw<MpCredentialBoxRow[]>`
            SELECT "id", "mpAccountId", "keyId", "accessTokenBox", "refreshTokenBox", "version"
            FROM "MpCredential" ORDER BY "id" ASC LIMIT ${take}`
        : await db.$queryRaw<MpCredentialBoxRow[]>`
            SELECT "id", "mpAccountId", "keyId", "accessTokenBox", "refreshTokenBox", "version"
            FROM "MpCredential" WHERE "id" > ${cursorId} ORDER BY "id" ASC LIMIT ${take}`;
      return rows.map((r) => ({ ...r, version: Number(r.version) }));
    },
    async casUpdate(expected, next) {
      // `version` NO se toca (ver cabecera). `updatedAt` sí: no tiene default
      // en la base (lo pone Prisma) y deja rastro de cuándo se re-selló.
      const n = await db.$executeRaw`
        UPDATE "MpCredential"
        SET "keyId" = ${next.keyId}, "accessTokenBox" = ${next.accessTokenBox},
            "refreshTokenBox" = ${next.refreshTokenBox}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${expected.id} AND "version" = ${expected.version}
          AND "accessTokenBox" = ${expected.accessTokenBox} AND "refreshTokenBox" = ${expected.refreshTokenBox}`;
      return n === 1;
    },
  };
}

/**
 * Store real sobre `"WhatsAppCredential"` (M15), SQL crudo con columnas explícitas. Misma exigencia de BYPASSRLS que
 * el de MP: la tabla es SERVICE_ONLY.
 */
export function prismaWaCredentialStore(db: Db): WaCredentialBoxStore {
  return {
    async listAfter(cursorId, take) {
      const rows = cursorId === null
        ? await db.$queryRaw<WaCredentialBoxRow[]>`
            SELECT "id", "accountId", "keyId", "tokenBox", "pinBox", "version"
            FROM "WhatsAppCredential" ORDER BY "id" ASC LIMIT ${take}`
        : await db.$queryRaw<WaCredentialBoxRow[]>`
            SELECT "id", "accountId", "keyId", "tokenBox", "pinBox", "version"
            FROM "WhatsAppCredential" WHERE "id" > ${cursorId} ORDER BY "id" ASC LIMIT ${take}`;
      return rows.map((r) => ({ ...r, version: Number(r.version) }));
    },
    async casUpdate(expected, next) {
      // `version` NO se toca (ver cabecera): la sube reconectar, no la rotación.
      const n = await db.$executeRaw`
        UPDATE "WhatsAppCredential"
        SET "keyId" = ${next.keyId}, "tokenBox" = ${next.tokenBox}, "pinBox" = ${next.pinBox},
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${expected.id} AND "version" = ${expected.version}
          AND "tokenBox" = ${expected.tokenBox} AND "pinBox" = ${expected.pinBox}`;
      return n === 1;
    },
  };
}

/** Con un rol sujeto a RLS, `MpCredential` se ve vacía: la rotación exige BYPASSRLS (owner/service). */
export async function assertResealBypassRls(db: Db): Promise<void> {
  const [role] = await db.$queryRaw<{ bypass: boolean }[]>`
    SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
  if (!role?.bypass) {
    throw new Error(
      "[secret-box-rotate] la conexión no tiene BYPASSRLS: MpCredential y WhatsAppCredential son SERVICE_ONLY y se verían vacías (falso \"nada que rotar\"). Usá DIRECT_URL (owner).",
    );
  }
}

async function defaultStore(): Promise<MpCredentialBoxStore> {
  // Import diferido: el unit test inyecta su store y no carga `lib/db`.
  const { prismaService } = await import("./db");
  await assertResealBypassRls(prismaService);
  return prismaMpCredentialStore(prismaService);
}

async function defaultWaStore(): Promise<WaCredentialBoxStore> {
  const { prismaService } = await import("./db");
  await assertResealBypassRls(prismaService);
  return prismaWaCredentialStore(prismaService);
}
