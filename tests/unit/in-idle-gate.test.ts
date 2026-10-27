/**
 * IN-S (§27, IN): la parte server del cierre por inactividad (`lib/idle-logout-internal.ts`). Símbolos reales; sin
 * mocks (es lógica pura + `node:crypto`).
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Lo único que se reemplaza: la cookie store de `next/headers` y la lectura del token (`getSessionUser`, red/JWT).
const req = vi.hoisted(() => ({ cookies: new Map<string, string>(), sessionId: null as string | null, userReads: 0 }));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (n: string) => (req.cookies.has(n) ? { name: n, value: req.cookies.get(n)! } : undefined) }),
}));
vi.mock("@/lib/session-user", () => ({
  getSessionUser: async () => {
    req.userReads++;
    return req.sessionId ? { id: "u1", sessionId: req.sessionId } : null;
  },
}));

import { IDLE_DEFAULT_MINUTES, IDLE_SERVER_GRACE_MS, idleSignOutAction, serializeIdleCookie } from "@/lib/idle-logout";
import {
  idleGate,
  idleLoginHref,
  idleSessionTag,
  idleShellState,
  readIdleShellState,
} from "@/lib/idle-logout-internal";

const SID = "5f0c2a4e-1111-4b6c-9d1e-0a0b0c0d0e0f";
const LAST = Date.UTC(2026, 9, 27, 15, 0, 0);
const T = LAST + IDLE_DEFAULT_MINUTES * 60_000;

describe("[IN-2] idleSessionTag / idleGate", () => {
  it("[IN-2] tag = sha256('kinesoft:idle:v1:'+sessionId) recortado a 12, estable y distinto por sesión", () => {
    const expected = createHash("sha256").update(`kinesoft:idle:v1:${SID}`).digest("hex").slice(0, 12);
    expect(idleSessionTag(SID)).toBe(expected);
    expect(idleSessionTag(SID)).toMatch(/^[0-9a-f]{12}$/);
    expect(idleSessionTag(SID)).toBe(idleSessionTag(SID));
    expect(idleSessionTag("otra-sesion")).not.toBe(idleSessionTag(SID));
  });

  it("[IN-2] vencida con la gracia y con el tag de ESTA sesión → expired; antes de la gracia → ok", () => {
    const raw = serializeIdleCookie(LAST, IDLE_DEFAULT_MINUTES, idleSessionTag(SID));
    expect(idleGate({ cookieRaw: raw, sessionId: SID, now: T })).toBe("ok");
    expect(idleGate({ cookieRaw: raw, sessionId: SID, now: T + IDLE_SERVER_GRACE_MS - 1 })).toBe("ok");
    expect(idleGate({ cookieRaw: raw, sessionId: SID, now: T + IDLE_SERVER_GRACE_MS })).toBe("expired");
    expect(idleGate({ cookieRaw: raw, sessionId: SID, now: T + 8 * 3_600_000 })).toBe("expired");
  });

  it("[IN-2] cookie de OTRA sesión, sin cookie, basura o sin sessionId → ok (nunca echa por una cookie ajena)", () => {
    const foreign = serializeIdleCookie(LAST, IDLE_DEFAULT_MINUTES, idleSessionTag("sesion-vieja"));
    const late = T + 8 * 3_600_000;
    expect(idleGate({ cookieRaw: foreign, sessionId: SID, now: late })).toBe("ok");
    expect(idleGate({ cookieRaw: undefined, sessionId: SID, now: late })).toBe("ok");
    expect(idleGate({ cookieRaw: null, sessionId: SID, now: late })).toBe("ok");
    expect(idleGate({ cookieRaw: "1.15.zzz", sessionId: SID, now: late })).toBe("ok");
    const own = serializeIdleCookie(LAST, IDLE_DEFAULT_MINUTES, idleSessionTag(SID));
    expect(idleGate({ cookieRaw: own, sessionId: null, now: late })).toBe("ok");
    expect(idleGate({ cookieRaw: own, sessionId: "", now: late })).toBe("ok");
  });
});

describe("[IN-2] idleShellState (lo que decide el layout `(app)`)", () => {
  const own = serializeIdleCookie(LAST, IDLE_DEFAULT_MINUTES, idleSessionTag(SID));

  it("sesión persistente (default) → off, aunque haya una cookie vencida", () => {
    expect(idleShellState({ sessionMode: undefined, cookieRaw: own, sessionId: SID, now: T + 3_600_000 })).toEqual({
      kind: "off",
    });
    expect(idleShellState({ sessionMode: "persistent", cookieRaw: own, sessionId: SID, now: T + 3_600_000 }).kind).toBe(
      "off"
    );
  });

  it("ephemeral sin sessionId (actor demo / token sin session_id) → off: sin tag no hay cierre atribuible", () => {
    expect(idleShellState({ sessionMode: "ephemeral", cookieRaw: own, sessionId: null, now: T }).kind).toBe("off");
  });

  it("ephemeral vigente → on con minutos, tag y la hora del server", () => {
    const now = LAST + 60_000;
    expect(idleShellState({ sessionMode: "ephemeral", cookieRaw: own, sessionId: SID, now })).toEqual({
      kind: "on",
      idle: { minutes: IDLE_DEFAULT_MINUTES, sessionTag: idleSessionTag(SID), serverNowMs: now },
    });
    // Sin cookie todavía (primer request después del login): on, la escribe el cliente.
    expect(idleShellState({ sessionMode: "ephemeral", cookieRaw: undefined, sessionId: SID, now }).kind).toBe("on");
  });

  it("ephemeral vencida (con gracia) → expired con los minutos de la política", () => {
    expect(
      idleShellState({ sessionMode: "ephemeral", cookieRaw: own, sessionId: SID, now: T + IDLE_SERVER_GRACE_MS })
    ).toEqual({ kind: "expired", minutes: IDLE_DEFAULT_MINUTES });
  });
});

describe("[IN-2] readIdleShellState / idleLoginHref (lo que usan el layout y el login)", () => {
  const own = () => serializeIdleCookie(LAST, IDLE_DEFAULT_MINUTES, idleSessionTag(SID));
  const reset = () => {
    req.cookies.clear();
    req.sessionId = null;
    req.userReads = 0;
  };

  it("persistente: off SIN leer la sesión (la sesión persistente no paga nada)", async () => {
    reset();
    req.cookies.set("kine_idle", own());
    req.sessionId = SID;
    expect(await readIdleShellState(T + 3_600_000)).toEqual({ kind: "off" });
    expect(req.userReads).toBe(0);
  });

  it("ephemeral: lee kine_session_mode + kine_idle + sessionId del token", async () => {
    reset();
    req.cookies.set("kine_session_mode", "ephemeral");
    req.cookies.set("kine_idle", own());
    req.sessionId = SID;
    expect(await readIdleShellState(T + IDLE_SERVER_GRACE_MS)).toEqual({ kind: "expired", minutes: 15 });
    expect((await readIdleShellState(LAST + 1_000)).kind).toBe("on");
    req.sessionId = null; // sin sesión (ya cerrada): nunca expired → sin bucle en el login
    expect((await readIdleShellState(T + 3_600_000)).kind).toBe("off");
  });

  it("idleLoginHref = el next interno de idleSignOutAction (mismas reglas de path seguro)", () => {
    expect(idleLoginHref("/agenda?vista=dia")).toBe(`/login?reason=idle&next=${encodeURIComponent("/agenda?vista=dia")}`);
    expect(idleLoginHref(null)).toBe("/login?reason=idle");
    expect(idleLoginHref("//evil.com")).toBe("/login?reason=idle");
    expect(idleLoginHref("/login?x=1")).toBe("/login?reason=idle");
    expect(new URL(idleSignOutAction("/sala"), "http://x").searchParams.get("next")).toBe(idleLoginHref("/sala"));
  });
});
