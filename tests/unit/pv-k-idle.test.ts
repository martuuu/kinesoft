/** PV-K (§27, Q1): contratos puros del cierre por inactividad (IN). */
import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";
import {
  IDLE_CHANNEL,
  IDLE_COOKIE,
  IDLE_DEFAULT_MINUTES,
  IDLE_SERVER_GRACE_MS,
  IDLE_WARNING_MS,
  idlePhase,
  idlePolicyFor,
  idleSignOutAction,
  isIdleExpiredOnServer,
  parseIdleCookie,
  secondsLeft,
  serializeIdleCookie,
} from "@/lib/idle-logout";

const LAST = Date.UTC(2026, 9, 27, 15, 0, 0); // segundo exacto
const MIN = 15;
const T = LAST + MIN * 60_000;
const TAG = "a1b2c3d4e5f6";

describe("[IN-1] puros de inactividad", () => {
  it("[IN-1] constantes y política", () => {
    expect(IDLE_COOKIE).toBe("kine_idle");
    expect(IDLE_DEFAULT_MINUTES).toBe(15);
    expect(IDLE_WARNING_MS).toBe(60_000);
    expect(IDLE_SERVER_GRACE_MS).toBe(60_000);
    expect(IDLE_CHANNEL).toBe("kine-idle");
    expect(idlePolicyFor({ sessionMode: "ephemeral" })).toEqual({ minutes: 15 });
    expect(idlePolicyFor({ sessionMode: "persistent" })).toBeNull();
    expect(idlePolicyFor({ sessionMode: null })).toBeNull();
    expect(idlePolicyFor({ sessionMode: undefined })).toBeNull();
  });

  it("[IN-1] bordes T−61 / T−60 / T", () => {
    expect(idlePhase(T - 61_000, LAST, MIN)).toBe("active");
    expect(idlePhase(T - 60_000, LAST, MIN)).toBe("warning");
    expect(idlePhase(T - 1, LAST, MIN)).toBe("warning");
    expect(idlePhase(T, LAST, MIN)).toBe("expired");
    expect(idlePhase(T + 5_000, LAST, MIN)).toBe("expired");
    expect(idlePhase(LAST, LAST, MIN)).toBe("active");
    expect(secondsLeft(T - 60_000, LAST, MIN)).toBe(60);
    expect(secondsLeft(T - 59_500, LAST, MIN)).toBe(60);
    expect(secondsLeft(T - 1_000, LAST, MIN)).toBe(1);
    expect(secondsLeft(T, LAST, MIN)).toBe(0);
    expect(secondsLeft(T + 10_000, LAST, MIN)).toBe(0);
  });

  it("[IN-1] cookie: ida y vuelta, clamp y basura", () => {
    const raw = serializeIdleCookie(LAST + 999, MIN, TAG);
    expect(raw).toBe(`${LAST / 1000}.15.${TAG}`);
    expect(parseIdleCookie(raw)).toEqual({ lastMs: LAST, minutes: 15, tag: TAG });
    expect(parseIdleCookie(`${LAST / 1000}.1.${TAG}`)?.minutes).toBe(5);
    expect(parseIdleCookie(`${LAST / 1000}.0.${TAG}`)?.minutes).toBe(5);
    expect(parseIdleCookie(`${LAST / 1000}.9999.${TAG}`)?.minutes).toBe(480);
    expect(parseIdleCookie(serializeIdleCookie(LAST, 2, TAG))?.minutes).toBe(5);
    for (const junk of [
      null,
      undefined,
      "",
      "abc",
      `${LAST / 1000}.15`,
      `${LAST / 1000}.15.${TAG}.x`,
      `x.15.${TAG}`,
      `${LAST / 1000}.x.${TAG}`,
      `-5.15.${TAG}`,
      `${LAST / 1000}.15.`,
      `${LAST / 1000}.15.tag con espacio`,
      `0.15.${TAG}`,
      `1e9.15.${TAG}`,
      `${LAST / 1000}.15.${"a".repeat(65)}`,
    ]) {
      expect(parseIdleCookie(junk as string | null | undefined), String(junk)).toBeNull();
    }
  });

  it("[IN-1] server: tag distinto → false; gracia de 60 s", () => {
    const raw = serializeIdleCookie(LAST, MIN, TAG);
    expect(isIdleExpiredOnServer(raw, T, TAG)).toBe(false);
    expect(isIdleExpiredOnServer(raw, T + IDLE_SERVER_GRACE_MS - 1, TAG)).toBe(false);
    expect(isIdleExpiredOnServer(raw, T + IDLE_SERVER_GRACE_MS, TAG)).toBe(true);
    expect(isIdleExpiredOnServer(raw, T + 3_600_000, "otrotag00000")).toBe(false);
    expect(isIdleExpiredOnServer("basura", T + 3_600_000, TAG)).toBe(false);
    expect(isIdleExpiredOnServer(null, T + 3_600_000, TAG)).toBe(false);
  });

  it("[IN-1] idleSignOutAction con y sin path, y con path inseguro", () => {
    const withPath = idleSignOutAction("/agenda?fecha=2026-10-27&vista=dia");
    expect(withPath.startsWith("/api/auth/sign-out?next=")).toBe(true);
    const next = new URL(withPath, "http://x").searchParams.get("next")!;
    // Lo que hace la ruta: safeNext(next, "/login") tiene que devolverlo intacto.
    expect(safeNext(next, "/login")).toBe(next);
    const login = new URL(next, "http://x");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("reason")).toBe("idle");
    expect(login.searchParams.get("next")).toBe("/agenda?fecha=2026-10-27&vista=dia");

    const bare = idleSignOutAction();
    const bareNext = new URL(bare, "http://x").searchParams.get("next")!;
    expect(bareNext).toBe("/login?reason=idle");
    expect(safeNext(bareNext, "/login")).toBe(bareNext);

    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "@evil.com", "/a\tb", "evil", "", "/login", "/api/auth/sign-out"]) {
      const url = idleSignOutAction(bad);
      expect(new URL(url, "http://x").searchParams.get("next"), bad).toBe("/login?reason=idle");
    }
  });
});
