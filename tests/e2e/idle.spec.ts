import { expect, test, type BrowserContext } from "@playwright/test";
import { freshContext, readPvFixture, submitLogin } from "./support/pv";

/**
 * [IN-E] PV (§27, bloque IN, ola Q4) · cierre de sesión por inactividad con `page.clock`.
 *
 * Política (lib/idle-logout.ts): solo con «Mantenerme conectado» DESTILDADO (`kine_session_mode=ephemeral`) → 15 min.
 * A T−60 s el aviso «¿Seguís ahí?»; a T, POST oculto a `/api/auth/sign-out` → `/login?reason=idle&next=<path>`. El
 * server corta recién a T+60 s (gracia) con la cookie `kine_idle` de la misma sesión.
 *
 * El reloj falso se instala ANTES de navegar: `Date.now`, los `setTimeout` del tick (5 s; 1 s durante el aviso) y lo que
 * use `BroadcastChannel` quedan bajo él. `fastForward` salta sin disparar cada tick intermedio (dispara una vez lo
 * vencido), que es lo que pasa con una pestaña dormida. El server corre con el reloj real: la sesión del GoTrue falso
 * dura 1 h, así que adelantar 30 min en el navegador no la vence.
 *
 * Usuario propio (`pv.idle.owner`, consultorio propio): 4 logins con el mismo email entran en el rate limit por email
 * (10 / 15', app/api/auth/sign-in/route.ts) sin pisar los de otras specs.
 */

const MIN = 60_000;

async function idleCookie(ctx: BrowserContext): Promise<string | null> {
  return (await ctx.cookies()).find((c) => c.name === "kine_idle")?.value ?? null;
}

test.describe("[IN-E] cierre por inactividad", () => {
  test("sin «Mantenerme conectado»: aviso a T−60 s, «Seguir conectado», cierre a T y reingreso a /agenda", async ({ browser }) => {
    const fx = readPvFixture();
    const ctx = await freshContext(browser);
    const page = await ctx.newPage();
    try {
      await page.clock.install();
      await page.goto("/login");
      await submitLogin(page, fx.idle.owner, { remember: false });
      const mode = (await ctx.cookies()).find((c) => c.name === "kine_session_mode");
      expect(mode?.value).toBe("ephemeral");

      await page.goto("/agenda");
      await expect(page).toHaveURL(/\/agenda/);
      // El primer tick escribe la cookie de esta sesión (`<lastSec>.<minutes>.<tag>`), de sesión (sin vencimiento).
      await expect.poll(() => idleCookie(ctx)).toMatch(/^\d+\.15\.[A-Za-z0-9_-]+$/);
      const cookie = (await ctx.cookies()).find((c) => c.name === "kine_idle");
      expect(cookie?.expires).toBe(-1);
      await expect(page.getByTestId("idle-warning")).toHaveCount(0);

      // 13 min: todavía nada.
      await page.clock.fastForward(13 * MIN);
      await page.clock.runFor(6_000);
      await expect(page.getByTestId("idle-warning")).toHaveCount(0);

      // T−60 s: aparece el aviso con el foco en «Seguir conectado».
      await page.clock.fastForward(1 * MIN);
      await page.clock.runFor(6_000);
      const warning = page.getByTestId("idle-warning");
      await expect(warning).toBeVisible();
      const dialog = page.getByRole("dialog", { name: "¿Seguís ahí?" });
      await expect(dialog).toBeVisible();
      // PV ZF2/ZG (M4): `toBeVisible` no mira la opacidad. Se intentó exigir el fade completo (opacidad 1 del fondo y del
      // panel), pero bajo `page.clock` el frameloop de framer no termina ni con `runFor` ni con `clock.resume()` (0/0
      // en 5 s): es un límite del reloj falso, no del aviso (mismo `Modal` que el resto de la app). La verificación
      // visual del aviso quedó como P0 del QA manual (QA.md «PV»).
      await expect(page.getByTestId("idle-stay")).toBeFocused();
      const s1 = Number(await page.getByTestId("idle-warning-seconds").textContent());
      expect(s1).toBeGreaterThan(0);
      expect(s1).toBeLessThanOrEqual(60);
      // Durante el aviso el contador baja de a un segundo.
      await page.clock.runFor(3_000);
      await expect.poll(async () => Number(await page.getByTestId("idle-warning-seconds").textContent())).toBeLessThan(s1);

      // Con el aviso abierto, mover el mouse NO lo cierra (solo «Seguir conectado»).
      await page.mouse.move(200, 200);
      await page.mouse.move(400, 300, { steps: 5 });
      await page.clock.runFor(2_000);
      await expect(warning).toBeVisible();

      // «Seguir conectado» lo cierra y la sesión sigue.
      await page.getByTestId("idle-stay").click();
      await expect(page.getByTestId("idle-warning")).toHaveCount(0);
      await page.clock.runFor(6_000);
      await expect(page.getByTestId("idle-warning")).toHaveCount(0);
      await expect(page).toHaveURL(/\/agenda/);

      // Sin actividad hasta T: POST de sign-out y al login con el aviso.
      const signOut = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/auth/sign-out");
      await page.clock.fastForward(15 * MIN);
      await page.clock.runFor(6_000);
      const req = await signOut;
      const next = new URL(req.url()).searchParams.get("next") ?? "";
      expect(next).toBe("/login?reason=idle&next=%2Fagenda");
      await page.waitForURL(/\/login\?/);
      const url = new URL(page.url());
      expect(url.searchParams.get("reason")).toBe("idle");
      expect(url.searchParams.get("next")).toBe("/agenda");
      await expect(page.getByTestId("login-notice")).toContainText("Cerramos tu sesión por inactividad.");
      // El sign-out borró la cookie de inactividad y la sesión: /agenda ya no abre.
      expect(await idleCookie(ctx)).toBeNull();

      // Reingreso: vuelve a /agenda (el `next` del login).
      await submitLogin(page, fx.idle.owner, { remember: false });
      await expect(page).toHaveURL(/\/agenda/);
    } finally {
      await ctx.close();
    }
  });

  test("el server corta recién a T+60 s con la cookie de la misma sesión", async ({ browser }) => {
    const fx = readPvFixture();
    const ctx = await freshContext(browser);
    const page = await ctx.newPage();
    try {
      // Sin reloj falso: acá se reescribe la cookie a mano con horas del pasado (reloj real del server).
      await page.goto("/login");
      await submitLogin(page, fx.idle.owner, { remember: false });
      await page.goto("/agenda");
      await expect.poll(() => idleCookie(ctx)).not.toBeNull();
      const raw = (await idleCookie(ctx)) as string;
      const [, minutes, tag] = raw.split(".");
      const setLast = async (msAgo: number) => {
        // Pestaña cerrada (sin JS que la reescriba): se navega a una página fuera de (app) antes de tocar la cookie.
        await page.goto("/terminos");
        await ctx.addCookies([
          { name: "kine_idle", value: `${Math.floor((Date.now() - msAgo) / 1000)}.${minutes}.${tag}`, url: page.url() },
        ]);
      };

      // T+30 s: dentro de la gracia, el server deja pasar. Por `ctx.request` (mismas cookies, sin JS): en una pestaña,
      // el tick del cliente vería la cookie vencida y cerraría la sesión él mismo, que no es lo que se prueba acá.
      await setLast(15 * MIN + 30_000);
      const inGrace = await ctx.request.get("/agenda", { maxRedirects: 0 });
      expect(inGrace.status()).toBe(200);

      // T+90 s: el server corta antes de pintar nada (redirect al login con el aviso; nunca manda la agenda).
      await setLast(15 * MIN + 90_000);
      const cut = await ctx.request.get("/agenda", { maxRedirects: 0 });
      expect([303, 307, 308]).toContain(cut.status());
      const loc = new URL(cut.headers()["location"] ?? "", page.url());
      expect(loc.pathname).toBe("/login");
      expect(loc.searchParams.get("reason")).toBe("idle");
      expect(loc.searchParams.get("next")).toBe("/agenda");
      await page.goto("/agenda");
      await page.waitForURL(/\/login/);
      expect(new URL(page.url()).searchParams.get("reason")).toBe("idle");
      await expect(page.getByTestId("login-notice")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("con «Mantenerme conectado» tildado no aparece nunca el aviso", async ({ browser }) => {
    const fx = readPvFixture();
    const ctx = await freshContext(browser);
    const page = await ctx.newPage();
    try {
      await page.clock.install();
      await page.goto("/login");
      await submitLogin(page, fx.idle.owner, { remember: true });
      await page.goto("/agenda");
      await expect(page).toHaveURL(/\/agenda/);
      await page.clock.fastForward(16 * MIN);
      await page.clock.runFor(6_000);
      await page.clock.fastForward(16 * MIN);
      await page.clock.runFor(6_000);
      await expect(page.getByTestId("idle-warning")).toHaveCount(0);
      await expect(page.getByTestId("idle-closing")).toHaveCount(0);
      await expect(page).toHaveURL(/\/agenda/);
      expect(await idleCookie(ctx)).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
