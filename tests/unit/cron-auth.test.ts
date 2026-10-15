/**
 * BO5-A · `checkCronAuth` (lib/cron-auth.ts): la única barrera de `/api/cron/*`.
 * Matriz: sin secreto → 503 en Production y 401 fuera; header ausente/mal formado/otro valor → 401.
 */
import { describe, it, expect } from "vitest";
import { checkCronAuth } from "@/lib/cron-auth";

const SECRET = "s3cr3t-de-prueba-0123456789";

describe("[BO5-A] checkCronAuth", () => {
  it("Bearer con el secreto correcto → ok", () => {
    expect(checkCronAuth({ authorization: `Bearer ${SECRET}`, secret: SECRET, production: true })).toEqual({ ok: true });
    expect(checkCronAuth({ authorization: `bearer   ${SECRET}  `, secret: SECRET, production: false })).toEqual({ ok: true });
  });

  it("secreto con espacios alrededor en la variable (copiado a Vercel) → se recorta", () => {
    expect(checkCronAuth({ authorization: `Bearer ${SECRET}`, secret: `  ${SECRET}\n`, production: true }).ok).toBe(true);
  });

  it.each([
    ["sin header", null],
    ["vacío", ""],
    ["sin Bearer", SECRET],
    ["otro esquema", `Basic ${SECRET}`],
    ["otro valor", "Bearer otro"],
    ["prefijo del secreto", `Bearer ${SECRET.slice(0, -1)}`],
    ["secreto + basura", `Bearer ${SECRET}x`],
    ["Bearer solo", "Bearer "],
  ])("%s → 401", (_n, authorization) => {
    expect(checkCronAuth({ authorization, secret: SECRET, production: true })).toEqual({
      ok: false,
      status: 401,
      reason: "unauthorized",
    });
  });

  it("sin CRON_SECRET en Production → 503 (config faltante), aunque manden algo", () => {
    for (const secret of [undefined, null, "", "   "]) {
      expect(checkCronAuth({ authorization: "Bearer cualquiera", secret, production: true })).toEqual({
        ok: false,
        status: 503,
        reason: "missing_secret",
      });
    }
  });

  it("sin CRON_SECRET fuera de Production → 401: nunca «abierto porque no hay secreto»", () => {
    expect(checkCronAuth({ authorization: "Bearer ", secret: undefined, production: false })).toMatchObject({ status: 401 });
    expect(checkCronAuth({ authorization: "Bearer undefined", secret: "", production: false })).toMatchObject({ status: 401 });
  });
});
