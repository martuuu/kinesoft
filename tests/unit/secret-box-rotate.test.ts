import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mpCredentialAad, openSecret, sealSecret, sealedKid } from "@/lib/secret-box";
import {
  resealMpCredentials,
  type MpCredentialBoxRow,
  type MpCredentialBoxStore,
} from "@/lib/secret-box-rotate-internal";

/**
 * [TP-P1] Re-sellado de MpCredential. La tabla llega con M18 (TP-M, T5b): acá
 * el store es en memoria pero con la MISMA semántica de CAS que el UPDATE real
 * (`WHERE id AND version AND sobres viejos`), y el re-sellado usa el secret-box
 * real con claves reales.
 */

const K1 = randomBytes(32).toString("base64");
const K2 = randomBytes(32).toString("base64");

class MemoryStore implements MpCredentialBoxStore {
  rows = new Map<string, MpCredentialBoxRow>();
  writes = 0;
  /** Hook para simular un refresh concurrente entre la lectura y el UPDATE. */
  beforeCas?: (id: string) => void;

  async listAfter(cursorId: string | null, take: number): Promise<MpCredentialBoxRow[]> {
    return [...this.rows.values()]
      .filter((r) => cursorId === null || r.id > cursorId)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, take)
      .map((r) => ({ ...r }));
  }

  async casUpdate(
    expected: Pick<MpCredentialBoxRow, "id" | "version" | "accessTokenBox" | "refreshTokenBox">,
    next: Pick<MpCredentialBoxRow, "keyId" | "accessTokenBox" | "refreshTokenBox">,
  ): Promise<boolean> {
    this.beforeCas?.(expected.id);
    const cur = this.rows.get(expected.id);
    if (
      !cur ||
      cur.version !== expected.version ||
      cur.accessTokenBox !== expected.accessTokenBox ||
      cur.refreshTokenBox !== expected.refreshTokenBox
    ) {
      return false;
    }
    this.writes++;
    // version NO se mueve: es el CAS del refresh rotativo (ver el módulo).
    this.rows.set(cur.id, { ...cur, ...next });
    return true;
  }
}

function addRow(store: MemoryStore, id: string, access: string, refresh: string) {
  const mpAccountId = `acc_${id}`;
  const accessTokenBox = sealSecret(access, mpCredentialAad(mpAccountId, "accessToken"));
  const refreshTokenBox = sealSecret(refresh, mpCredentialAad(mpAccountId, "refreshToken"));
  store.rows.set(id, {
    id,
    mpAccountId,
    keyId: sealedKid(accessTokenBox)!,
    accessTokenBox,
    refreshTokenBox,
    version: 1,
  });
}

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("SECRET_BOX_KEYS", `k1:${K1}`);
});
afterEach(() => vi.unstubAllEnvs());

describe("[TP-P1] Secret box", () => {
  it("resealMpCredentials: dry-run no escribe; apply con CAS", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) addRow(store, `c${i}`, `access-${i}`, `refresh-${i}`);
    // Una fila que ninguna clave abre (sobre de otra cuenta): cuenta como failed y no se toca.
    const alien = store.rows.get("c4")!;
    store.rows.set("c4", { ...alien, mpAccountId: "acc_otra" });

    vi.stubEnv("SECRET_BOX_KEYS", `k2:${K2},k1:${K1}`);
    addRow(store, "c5", "access-5", "refresh-5"); // ya con k2
    const snapshot = JSON.stringify([...store.rows.entries()]);

    const dry = await resealMpCredentials({ apply: false, batchSize: 2, store });
    expect(store.writes).toBe(0);
    expect(JSON.stringify([...store.rows.entries()])).toBe(snapshot);
    expect(dry).toMatchObject({ scanned: 6, resealed: 0, failed: 1, pending: 5, byKid: { k1: 5, k2: 1 } });
    expect(dry.failures).toEqual([{ id: "c4", code: "auth" }]);

    // Apply con un refresh concurrente sobre c1 entre la lectura y el UPDATE:
    // el CAS pierde y la fila del refresh queda intacta (sus tokens nuevos ganan).
    store.beforeCas = (id) => {
      if (id !== "c1") return;
      const cur = store.rows.get(id)!;
      store.rows.set(id, {
        ...cur,
        version: cur.version + 1,
        accessTokenBox: sealSecret("access-1-refrescado", mpCredentialAad(cur.mpAccountId, "accessToken")),
        refreshTokenBox: sealSecret("refresh-1-refrescado", mpCredentialAad(cur.mpAccountId, "refreshToken")),
        keyId: "k2",
      });
      store.beforeCas = undefined;
    };
    const applied = await resealMpCredentials({ apply: true, batchSize: 2, store });
    expect(applied).toMatchObject({ scanned: 6, resealed: 3, failed: 1, conflicts: 1, pending: 5 });

    for (const i of [0, 2, 3]) {
      const r = store.rows.get(`c${i}`)!;
      expect(r.keyId).toBe("k2");
      expect(r.version).toBe(1);
      expect(sealedKid(r.accessTokenBox)).toBe("k2");
      expect(sealedKid(r.refreshTokenBox)).toBe("k2");
      expect(openSecret(r.accessTokenBox, mpCredentialAad(r.mpAccountId, "accessToken"))).toBe(`access-${i}`);
      expect(openSecret(r.refreshTokenBox, mpCredentialAad(r.mpAccountId, "refreshToken"))).toBe(`refresh-${i}`);
    }
    const c1 = store.rows.get("c1")!;
    expect(c1.version).toBe(2);
    expect(openSecret(c1.refreshTokenBox, mpCredentialAad(c1.mpAccountId, "refreshToken"))).toBe("refresh-1-refrescado");
    expect(sealedKid(store.rows.get("c4")!.accessTokenBox)).toBe("k1");

    // Segundo dry-run: solo queda la fila que no abre. Ya se puede retirar k1
    // salvo por c4, que el reporte señala con su id.
    const again = await resealMpCredentials({ apply: false, store });
    expect(again).toMatchObject({ scanned: 6, pending: 1, failed: 1, byKid: { k1: 1, k2: 5 } });

    // Sin claves configuradas no hay a qué rotar: aborta antes de leer.
    vi.stubEnv("SECRET_BOX_KEYS", "");
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(resealMpCredentials({ apply: true, store })).rejects.toMatchObject({ code: "no_keys" });
    await expect(resealMpCredentials({ apply: true, batchSize: 0, store })).rejects.toThrow();
  });
});
