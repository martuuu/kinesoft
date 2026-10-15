import "server-only";
/**
 * Puerto delgado sobre `supabase.auth.mfa` para CUALQUIER usuario (PL-2a, C-PL6; nació en BO4 como
 * `lib/platform-mfa.ts`, que ahora solo re-exporta esto con los nombres viejos).
 *
 * Por qué se generalizó: la 2FA dejó de ser de los superadmins (BO-D6) y pasó a ser opcional para todos (§20.5.5).
 * El TOTP de un profesional, de una secretaria o del superadmin es el mismo factor de Supabase con el mismo JWT del
 * usuario: un solo puerto, un solo fake (`tests/helpers/platform-mfa-fake.ts`).
 *
 * Por qué un puerto: las actions de 2FA (`lib/two-factor.ts`), `requirePlatformAdmin` y las pantallas de
 * `/plataforma-mfa` dependen de GoTrue, que no corre en el Docker local ni en los tests. El código real llama a
 * `mfaPort()`; los tests inyectan un fake con `__setMfaPortForTests` (mismo patrón que `__setAuthAdminForTests` de
 * `lib/identity/auth-admin.ts`). Nunca se mockea la función bajo test: se reemplaza solo la red.
 *
 * Es del USUARIO (cliente de servidor con las cookies de su sesión), no del admin: enrolar, desafiar y verificar
 * se hacen con el JWT de la persona, y `verify` le reescribe las cookies con una sesión AAL2. Por eso solo se usa
 * desde server actions (en un server component `cookies().set` no escribe; ver `lib/supabase/server.ts`).
 *
 * Nada de esto tira: supabase-js devuelve `{ data, error }` y acá cada `error` se convierte en `{ ok: false }`.
 *
 * SUPUESTOS sobre la API real (auth-js 2.105, leídos en `node_modules/@supabase/auth-js/dist/module/GoTrueClient.js`;
 * si una versión nueva los rompe, se corrige ACÁ y en el fake de los tests):
 *  [M1] `mfa.getAuthenticatorAssuranceLevel(jwt)` CON jwt explícito: decodifica el `aal` del JWT y llama a
 *       `getUser(jwt)`, que valida el token contra GoTrue y trae los factores frescos del server. Devuelve
 *       `{ currentLevel, nextLevel, currentAuthenticationMethods }`; `nextLevel = "aal2"` si hay algún factor con
 *       `status: "verified"`, si no `nextLevel = currentLevel`. SIN jwt lee la sesión de la cookie y decodifica sin
 *       validar firma: en el server no se usa así (la cookie la escribe el cliente).
 *  [M2] El jwt sale de `auth.getSession()` (cookie). Solo se usa su `access_token` como argumento de [M1], que lo
 *       valida; nunca `session.user` (sin validar).
 *  [M3] `mfa.listFactors()` llama a `getUser()` (validado) y devuelve `{ all, totp, phone, webauthn }`: `all` trae
 *       también los no verificados; `totp` solo los verificados. Cada factor: `{ id, factor_type, status,
 *       friendly_name?, created_at }`.
 *  [M4] `mfa.enroll({ factorType: "totp", friendlyName, issuer })` → `{ id, type: "totp", totp: { qr_code, secret,
 *       uri } }`. `qr_code` es un SVG que auth-js ya prefija con `data:image/svg+xml;utf-8,` SIN url-encodear (un `#`
 *       del SVG cortaría la URL en un `<img src>`): acá se re-encodea. `friendly_name` tiene que ser único por
 *       usuario: un enrolamiento a medias (factor `unverified`) se borra antes de crear otro.
 *  [M5] `mfa.challenge({ factorId })` → `{ id, expires_at }`; `mfa.verify({ factorId, challengeId, code })` → sesión
 *       nueva (AAL2) que auth-js guarda con `_saveSession` → `setAll` de las cookies (solo efectivo en una action).
 *       Un código mal puesto llega como `error` (code `mfa_verification_failed`); el challenge vence a los ~5 min.
 *  [M6] `mfa.unenroll({ factorId })` borra el factor; GoTrue exige AAL2 para borrar uno VERIFICADO.
 *  [M7] TOTP viene habilitado por defecto en los proyectos de Supabase (Auth → Multi-Factor); si alguien lo apaga,
 *       `enroll` devuelve error y la pantalla de configurar lo muestra.
 */
import { cache } from "react";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import type { AalLevel, MfaAssurance } from "@/lib/platform-mfa-logic";

export type MfaFactorLite = {
  id: string;
  type: string;
  status: "verified" | "unverified";
  friendlyName: string | null;
  createdAt: string;
};

export type TotpEnrollment = {
  factorId: string;
  /** `data:image/svg+xml;charset=utf-8,<svg url-encodeado>`: va directo a un `<img src>` (CSP: `img-src data:`). */
  qrCode: string;
  /** El secreto en base32 para tipearlo a mano si la cámara no lee el QR. */
  secret: string;
  /** `otpauth://totp/…` (algunas apps de escritorio lo aceptan pegado). */
  uri: string;
};

export type MfaResult<T> = { ok: true; data: T } | { ok: false; code: string };

export interface MfaPort {
  getAssurance(): Promise<MfaResult<MfaAssurance>>;
  listFactors(): Promise<MfaResult<MfaFactorLite[]>>;
  enrollTotp(friendlyName: string): Promise<MfaResult<TotpEnrollment>>;
  challenge(factorId: string): Promise<MfaResult<{ challengeId: string }>>;
  verify(factorId: string, challengeId: string, code: string): Promise<MfaResult<void>>;
  unenroll(factorId: string): Promise<MfaResult<void>>;
}

function errCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown } | null;
  if (e && typeof e.code === "string" && e.code) return e.code;
  if (e && typeof e.name === "string" && e.name) return e.name;
  return "unknown";
}

function aal(v: unknown): AalLevel | null {
  return v === "aal1" || v === "aal2" ? v : null;
}

/** [M4] Normaliza el QR a un data URI url-encodeado, venga crudo (`<svg…`) o con el prefijo de auth-js. */
export function qrDataUri(raw: string): string {
  const prefix = /^data:image\/svg\+xml;(?:utf-8|charset=utf-8),/i;
  if (prefix.test(raw)) {
    const body = raw.replace(prefix, "");
    // Ya encodeado (empieza con %3C) → se respeta; crudo → se encodea.
    return `data:image/svg+xml;charset=utf-8,${body.startsWith("%3C") ? body : encodeURIComponent(body)}`;
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
}

/**
 * Cada método envuelve su llamada en try/catch además de mirar `error`: fuera de un request `cookies()` tira, y el
 * mock de integración de `lib/supabase/server` no trae `getSession` ni `mfa`. Un puerto que tirara ahí rompería
 * `requirePlatformAdmin("support.start")` con el flag en `off`, que solo quiere saber si hubo AAL2 para el registro.
 */
const realPort: MfaPort = {
  async getAssurance() {
    try {
      const auth = getSupabaseServerClient().auth;
      const { data: sd, error: se } = await auth.getSession();
      if (se) return { ok: false, code: errCode(se) };
      const jwt = sd?.session?.access_token;
      if (!jwt) return { ok: true, data: { currentLevel: null, nextLevel: null } };
      const { data, error } = await auth.mfa.getAuthenticatorAssuranceLevel(jwt);
      if (error || !data) return { ok: false, code: errCode(error) };
      return { ok: true, data: { currentLevel: aal(data.currentLevel), nextLevel: aal(data.nextLevel) } };
    } catch (err) {
      return { ok: false, code: errCode(err) };
    }
  },

  async listFactors() {
    try {
      const { data, error } = await getSupabaseServerClient().auth.mfa.listFactors();
      if (error || !data) return { ok: false, code: errCode(error) };
      return {
        ok: true,
        data: data.all.map((f) => ({
          id: f.id,
          type: String(f.factor_type),
          status: f.status === "verified" ? "verified" : "unverified",
          friendlyName: f.friendly_name ?? null,
          createdAt: f.created_at,
        })),
      };
    } catch (err) {
      return { ok: false, code: errCode(err) };
    }
  },

  async enrollTotp(friendlyName) {
    try {
      const { data, error } = await getSupabaseServerClient().auth.mfa.enroll({
        factorType: "totp",
        friendlyName,
        issuer: "KineSoft",
      });
      if (error || !data) return { ok: false, code: errCode(error) };
      return {
        ok: true,
        data: { factorId: data.id, qrCode: qrDataUri(data.totp.qr_code), secret: data.totp.secret, uri: data.totp.uri },
      };
    } catch (err) {
      return { ok: false, code: errCode(err) };
    }
  },

  async challenge(factorId) {
    try {
      const { data, error } = await getSupabaseServerClient().auth.mfa.challenge({ factorId });
      if (error || !data) return { ok: false, code: errCode(error) };
      return { ok: true, data: { challengeId: data.id } };
    } catch (err) {
      return { ok: false, code: errCode(err) };
    }
  },

  async verify(factorId, challengeId, code) {
    try {
      const { error } = await getSupabaseServerClient().auth.mfa.verify({ factorId, challengeId, code });
      if (error) return { ok: false, code: errCode(error) };
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: errCode(err) };
    }
  },

  async unenroll(factorId) {
    try {
      const { error } = await getSupabaseServerClient().auth.mfa.unenroll({ factorId });
      if (error) return { ok: false, code: errCode(error) };
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: errCode(err) };
    }
  },
};

let override: MfaPort | null = null;

/** El puerto vigente: el fake si un test lo inyectó, si no Supabase. */
export function mfaPort(): MfaPort {
  return override ?? realPort;
}

/** Tests: inyecta un fake (null vuelve al real). */
export function __setMfaPortForTests(p: MfaPort | null): void {
  override = p;
}

async function loadAssurance(): Promise<MfaAssurance | null> {
  const r = await mfaPort().getAssurance();
  if (!r.ok) {
    logger.warn("platform.mfa.assurance_unavailable", { code: r.code });
    return null;
  }
  return r.data;
}

// Mismo memo que `lib/session-user.ts`: `cache` solo existe en el build react-server.
const memo: <T extends (...a: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

/**
 * Nivel de la sesión, una lectura a GoTrue por request (`cache`): el layout y cada lectura de la página llaman a
 * `requirePlatformAdmin`. null = no se pudo leer (GoTrue caído o sin configurar). Ojo: dentro de una action que
 * hace `verify`, esta foto queda vieja; las actions de 2FA no la vuelven a leer después.
 */
export const readMfaAssurance: () => Promise<MfaAssurance | null> = memo(loadAssurance);
