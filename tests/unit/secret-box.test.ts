import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SECRET_BOX_DEV_KID,
  SecretBoxError,
  needsReseal,
  openSecret,
  parseSecretBoxKeys,
  sealSecret,
  sealedKid,
  secretBoxStatus,
  type SecretBoxAad,
} from "@/lib/secret-box";
import * as secretBox from "@/lib/secret-box";

/**
 * [TP-P1] Secret box (C-TP1). Se testea el módulo real con la variable de
 * entorno real (`vi.stubEnv`): nada de mocks de crypto. Las claves son
 * aleatorias por corrida, así que ningún resultado depende de un valor fijo.
 */

const AAD: SecretBoxAad = { purpose: "mp-credential", recordId: "acc_1", field: "accessToken" };
const K1 = randomBytes(32).toString("base64");
const K2 = randomBytes(32).toString("base64");

function clearEnv() {
  vi.stubEnv("SECRET_BOX_KEYS", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("VERCEL", "");
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof SecretBoxError) return e.code;
    throw e;
  }
}

/** Cambia un carácter base64url por otro distinto que siga siendo base64url. */
function flipChar(s: string, i: number): string {
  const c = s[i];
  const repl = c === "A" ? "B" : "A";
  return s.slice(0, i) + repl + s.slice(i + 1);
}

beforeEach(() => clearEnv());
afterEach(() => vi.unstubAllEnvs());

describe("[TP-P1] Secret box", () => {
  it("seal→open con la misma AAD; dos seals distintos", () => {
    vi.stubEnv("SECRET_BOX_KEYS", `k1:${K1}`);
    const token = "APP_USR-1234567890-abcdef";
    const a = sealSecret(token, AAD);
    const b = sealSecret(token, AAD);
    expect(a).not.toBe(b); // IV aleatorio
    expect(openSecret(a, AAD)).toBe(token);
    expect(openSecret(b, AAD)).toBe(token);
    // Formato exacto del CHECK de M18 (MpCredential_box_check).
    expect(a).toMatch(/^v1\.[a-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(a.split(".")[1]).toBe("k1");
    expect(sealedKid(a)).toBe("k1");
    // Nunca el texto en claro dentro del sobre.
    expect(a).not.toContain(token);
    expect(Buffer.from(a.split(".")[3], "base64url").toString("utf8")).not.toContain("APP_USR");
    // UTF-8 de varios bytes ida y vuelta.
    expect(openSecret(sealSecret("contraseña ñandú ✓", AAD), AAD)).toBe("contraseña ñandú ✓");
  });

  it("un byte cambiado → auth", () => {
    vi.stubEnv("SECRET_BOX_KEYS", `k1:${K1}`);
    const sealed = sealSecret("secreto", AAD);
    const [v, kid, iv, ct, tag] = sealed.split(".");
    // Byte del ciphertext, del tag y del IV: los tres rompen la autenticación.
    expect(codeOf(() => openSecret([v, kid, iv, flipChar(ct, 0), tag].join("."), AAD))).toBe("auth");
    expect(codeOf(() => openSecret([v, kid, iv, ct, flipChar(tag, 3)].join("."), AAD))).toBe("auth");
    expect(codeOf(() => openSecret([v, kid, flipChar(iv, 2), ct, tag].join("."), AAD))).toBe("auth");
  });

  it("otra AAD → auth", () => {
    vi.stubEnv("SECRET_BOX_KEYS", `k1:${K1}`);
    const sealed = sealSecret("secreto", AAD);
    expect(codeOf(() => openSecret(sealed, { ...AAD, recordId: "acc_2" }))).toBe("auth");
    expect(codeOf(() => openSecret(sealed, { ...AAD, field: "refreshToken" }))).toBe("auth");
    expect(codeOf(() => openSecret(sealed, { ...AAD, purpose: "wa-credential" }))).toBe("auth");
    // Un separador dentro de un campo no puede fabricar la misma AAD de otro registro.
    expect(codeOf(() => sealSecret("x", { ...AAD, recordId: "acc|1" }))).toBe("format");
    expect(codeOf(() => sealSecret("x", { ...AAD, field: "" }))).toBe("format");
  });

  it("rotación k2,k1 abre; needsReseal; re-sellado con k2", () => {
    vi.stubEnv("SECRET_BOX_KEYS", `k1:${K1}`);
    const old = sealSecret("refresh-viejo", AAD);
    expect(needsReseal(old)).toBe(false);

    vi.stubEnv("SECRET_BOX_KEYS", `k2:${K2},k1:${K1}`);
    expect(openSecret(old, AAD)).toBe("refresh-viejo");
    expect(needsReseal(old)).toBe(true);
    const fresh = sealSecret(openSecret(old, AAD), AAD);
    expect(sealedKid(fresh)).toBe("k2");
    expect(needsReseal(fresh)).toBe(false);
    expect(openSecret(fresh, AAD)).toBe("refresh-viejo");

    // Retirada k1, lo re-sellado sigue abriendo y lo viejo ya no.
    vi.stubEnv("SECRET_BOX_KEYS", `k2:${K2}`);
    expect(openSecret(fresh, AAD)).toBe("refresh-viejo");
    expect(codeOf(() => openSecret(old, AAD))).toBe("unknown_kid");
    expect(needsReseal("basura")).toBe(true);
  });

  it("kid desconocido; formato roto", () => {
    vi.stubEnv("SECRET_BOX_KEYS", `k1:${K1}`);
    const sealed = sealSecret("secreto", AAD);
    const parts = sealed.split(".");
    expect(codeOf(() => openSecret(["v1", "k9", ...parts.slice(2)].join("."), AAD))).toBe("unknown_kid");
    expect(codeOf(() => openSecret("", AAD))).toBe("format");
    expect(codeOf(() => openSecret("texto-en-claro", AAD))).toBe("format");
    expect(codeOf(() => openSecret(["v2", ...parts.slice(1)].join("."), AAD))).toBe("format");
    expect(codeOf(() => openSecret(parts.slice(0, 4).join("."), AAD))).toBe("format");
    expect(codeOf(() => openSecret([...parts, "x"].join("."), AAD))).toBe("format");
    expect(codeOf(() => openSecret([parts[0], parts[1], parts[2].slice(1), parts[3], parts[4]].join("."), AAD))).toBe("format");
    expect(codeOf(() => openSecret([parts[0], parts[1], parts[2], parts[3], parts[4] + "A"].join("."), AAD))).toBe("format");
    expect(codeOf(() => openSecret([parts[0], parts[1], parts[2], "", parts[4]].join("."), AAD))).toBe("format");
    expect(codeOf(() => openSecret([parts[0], "K1", ...parts.slice(2)].join("."), AAD))).toBe("format");
    expect(codeOf(() => openSecret([parts[0], parts[1], parts[2], parts[3] + "+", parts[4]].join("."), AAD))).toBe("format");
    expect(sealedKid("v1.k1.roto")).toBeNull();
    expect(sealedKid(sealed)).toBe("k1");
    expect(codeOf(() => sealSecret("", AAD))).toBe("format");
  });

  it("parse inválido → bad_keys sin la clave en el mensaje", () => {
    const short = randomBytes(16).toString("base64");
    const cases = [
      `k1:${short}`, // 16 B, no 32
      `${K1}`, // sin kid: la clave entera quedaría como "kid"
      `K1:${K1}`, // kid en mayúsculas (el CHECK de M18 no lo acepta)
      `k1:${K1},k1:${K2}`, // kid repetido
      `k1:${K1},,k2:${K2}`, // entrada vacía
      `dev:${K1}`, // reservado al fallback local
      `k1:${K1.slice(0, -4)}!!!!`, // base64 inválido
      `k1:${K1}:extra`,
      `averyveryverylongkidname:${K1}`,
    ];
    for (const raw of cases) {
      let err: unknown;
      try {
        parseSecretBoxKeys(raw);
      } catch (e) {
        err = e;
      }
      expect(err, raw.slice(0, 3)).toBeInstanceOf(SecretBoxError);
      const e = err as SecretBoxError;
      expect(e.code).toBe("bad_keys");
      for (const k of [K1, K2, short, K1.slice(0, 12), K2.slice(0, 12), short.slice(0, 12)]) {
        expect(e.message).not.toContain(k);
        expect(String(e.stack)).not.toContain(k);
        expect(JSON.stringify(e)).not.toContain(k);
      }
    }
    // Y por el camino de uso: sellar con la variable rota también da bad_keys sin la clave.
    vi.stubEnv("SECRET_BOX_KEYS", `k1:${short}`);
    expect(codeOf(() => sealSecret("x", AAD))).toBe("bad_keys");

    expect(parseSecretBoxKeys(undefined)).toEqual([]);
    expect(parseSecretBoxKeys("   ")).toEqual([]);
    const parsed = parseSecretBoxKeys(` k2:${K2} , k1:${K1} `);
    expect(parsed.map((k) => k.kid)).toEqual(["k2", "k1"]);
    expect(parsed[0].key.equals(Buffer.from(K2, "base64"))).toBe(true);
    // base64url también se acepta (mismos 32 bytes).
    const url = Buffer.from(K1, "base64").toString("base64url");
    expect(parseSecretBoxKeys(`k1:${url}`)[0].key.equals(Buffer.from(K1, "base64"))).toBe(true);
  });

  it("dev determinista en local; no_keys y dev_key_on_vercel en Vercel", () => {
    // Local sin claves: sella con la clave dev, y la clave es determinista
    // (otro proceso, o este después de reiniciar, abre lo mismo).
    const sealed = sealSecret("token-local", AAD);
    expect(sealedKid(sealed)).toBe(SECRET_BOX_DEV_KID);
    expect(openSecret(sealed, AAD)).toBe("token-local");
    const statusA = secretBoxStatus();
    vi.stubEnv("SECRET_BOX_KEYS", "");
    expect(secretBoxStatus().fingerprints.dev).toBe(statusA.fingerprints.dev);

    // Con claves configuradas en local, lo sellado con dev sigue abriendo
    // (se puede rotar dev → k1) pero ya no se sella con dev.
    vi.stubEnv("SECRET_BOX_KEYS", `k1:${K1}`);
    expect(openSecret(sealed, AAD)).toBe("token-local");
    expect(needsReseal(sealed)).toBe(true);
    expect(sealedKid(sealSecret("x", AAD))).toBe("k1");

    // Vercel (cualquier entorno) sin claves: no sella, no abre lo dev.
    for (const [name, value] of [
      ["VERCEL_ENV", "production"],
      ["VERCEL_ENV", "preview"],
      ["VERCEL", "1"],
    ] as const) {
      clearEnv();
      vi.stubEnv(name, value);
      expect(codeOf(() => sealSecret("x", AAD))).toBe("no_keys");
      expect(codeOf(() => openSecret(sealed, AAD))).toBe("dev_key_on_vercel");
      // Con claves en Vercel, lo dev sigue sin abrir.
      vi.stubEnv("SECRET_BOX_KEYS", `k1:${K1}`);
      expect(codeOf(() => openSecret(sealed, AAD))).toBe("dev_key_on_vercel");
      expect(openSecret(sealSecret("y", AAD), AAD)).toBe("y");
    }
  });

  it("secretBoxStatus sin claves", () => {
    const local = secretBoxStatus();
    expect(local).toMatchObject({ configured: false, devFallback: true, primaryKid: "dev", kids: [] });
    expect(local.fingerprints.dev).toMatch(/^[0-9a-f]{12}$/);

    vi.stubEnv("VERCEL_ENV", "production");
    expect(secretBoxStatus()).toEqual({
      configured: false,
      devFallback: false,
      primaryKid: null,
      kids: [],
      fingerprints: {},
    });

    vi.stubEnv("SECRET_BOX_KEYS", `k2:${K2},k1:${K1}`);
    const s = secretBoxStatus();
    expect(s).toMatchObject({ configured: true, devFallback: false, primaryKid: "k2", kids: ["k2", "k1"] });
    expect(Object.keys(s.fingerprints)).toEqual(["k2", "k1"]);
    expect(s.fingerprints.k1).toMatch(/^[0-9a-f]{12}$/);
    expect(s.fingerprints.k1).not.toBe(s.fingerprints.k2);
    // Huella, nunca la clave (ni en base64 ni en hex).
    const dump = JSON.stringify(s);
    for (const k of [K1, K2]) {
      expect(dump).not.toContain(k);
      expect(dump).not.toContain(Buffer.from(k, "base64").toString("hex").slice(0, 12));
    }

    // Variable rota: el panel de Sistema no se cae; dice "no configurada".
    vi.stubEnv("SECRET_BOX_KEYS", "basura");
    expect(secretBoxStatus()).toMatchObject({ configured: false, devFallback: false, primaryKid: null, kids: [] });
  });
});

// [INF-ENV] (C-WA3: «`waCredentialAad` vive en `lib/secret-box.ts`»). Misma idea que `mpCredentialAad`: el alta, el
// envío y la rotación sellan y abren con EXACTAMENTE la misma AAD, por cuenta y campo.
describe("[INF-ENV] waCredentialAad", () => {
  it("[INF-ENV] AAD wa-credential por cuenta y campo (token | pin); no abre con otra cuenta, otro campo ni la AAD de MP", () => {
    const aad = secretBox.waCredentialAad("wa_acc_1", "token");
    expect(aad).toEqual({ purpose: "wa-credential", recordId: "wa_acc_1", field: "token" });
    expect(secretBox.waCredentialAad("wa_acc_1", "pin")).toEqual({ purpose: "wa-credential", recordId: "wa_acc_1", field: "pin" });
    const sealed = sealSecret("EAAG-token-de-prueba", aad);
    expect(openSecret(sealed, secretBox.waCredentialAad("wa_acc_1", "token"))).toBe("EAAG-token-de-prueba");
    expect(codeOf(() => openSecret(sealed, secretBox.waCredentialAad("wa_acc_2", "token")))).toBe("auth");
    expect(codeOf(() => openSecret(sealed, secretBox.waCredentialAad("wa_acc_1", "pin")))).toBe("auth");
    expect(codeOf(() => openSecret(sealed, { purpose: "mp-credential", recordId: "wa_acc_1", field: "token" }))).toBe("auth");
  });
});
