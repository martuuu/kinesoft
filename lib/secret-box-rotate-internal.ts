import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  SecretBoxError,
  mpCredentialAad,
  needsReseal,
  openSecret,
  sealSecret,
  sealedKid,
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
 *  - **Store inyectable**: `MpCredential` llega con M18 (TP-M, T5b) y el
 *    cliente Prisma de T5a no la conoce; el store real usa SQL crudo con
 *    columnas explícitas y el unit test uno en memoria con la misma semántica.
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

export async function resealMpCredentials(opts: {
  apply: boolean;
  batchSize?: number;
  store?: MpCredentialBoxStore;
}): Promise<ResealResult> {
  const batchSize = opts.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("[secret-box-rotate] batchSize tiene que ser un entero entre 1 y 1000.");
  }
  // Falla temprano (no_keys / bad_keys) antes de leer nada: sellar con qué.
  sealSecret("probe", mpCredentialAad("probe", "accessToken"));

  const store = opts.store ?? (await defaultStore());
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
      const stale =
        needsReseal(row.accessTokenBox) ||
        needsReseal(row.refreshTokenBox) ||
        sealedKid(row.accessTokenBox) !== row.keyId ||
        sealedKid(row.refreshTokenBox) !== row.keyId;
      if (!stale) continue;
      result.pending++;

      let next: Pick<MpCredentialBoxRow, "keyId" | "accessTokenBox" | "refreshTokenBox">;
      try {
        const access = openSecret(row.accessTokenBox, mpCredentialAad(row.mpAccountId, "accessToken"));
        const refresh = openSecret(row.refreshTokenBox, mpCredentialAad(row.mpAccountId, "refreshToken"));
        const accessTokenBox = sealSecret(access, mpCredentialAad(row.mpAccountId, "accessToken"));
        const refreshTokenBox = sealSecret(refresh, mpCredentialAad(row.mpAccountId, "refreshToken"));
        next = { keyId: sealedKid(accessTokenBox)!, accessTokenBox, refreshTokenBox };
      } catch (e) {
        result.failed++;
        if (result.failures.length < MAX_FAILURES_LISTED) {
          result.failures.push({ id: row.id, code: e instanceof SecretBoxError ? e.code : "unexpected" });
        }
        continue;
      }
      if (!opts.apply) continue;
      const ok = await store.casUpdate(
        {
          id: row.id,
          version: row.version,
          accessTokenBox: row.accessTokenBox,
          refreshTokenBox: row.refreshTokenBox,
        },
        next,
      );
      if (ok) result.resealed++;
      else result.conflicts++;
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < batchSize) break;
  }
  return result;
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

/** Con un rol sujeto a RLS, `MpCredential` se ve vacía: la rotación exige BYPASSRLS (owner/service). */
export async function assertResealBypassRls(db: Db): Promise<void> {
  const [role] = await db.$queryRaw<{ bypass: boolean }[]>`
    SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
  if (!role?.bypass) {
    throw new Error(
      "[secret-box-rotate] la conexión no tiene BYPASSRLS: MpCredential es SERVICE_ONLY y se vería vacía (falso \"nada que rotar\"). Usá DIRECT_URL (owner).",
    );
  }
}

async function defaultStore(): Promise<MpCredentialBoxStore> {
  // Import diferido: el unit test inyecta su store y no carga `lib/db`.
  const { prismaService } = await import("./db");
  await assertResealBypassRls(prismaService);
  return prismaMpCredentialStore(prismaService);
}
