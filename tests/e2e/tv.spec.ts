import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { E2E_BASE_URL } from "./support/e2e-constants.mjs";
import { readFixture } from "./support/fixture";

/**
 * TV-E (T7, X8; brief §26.4 C-TV) · pantalla de la sala `/tv` de punta a punta contra el server del E2E (GoTrue falso,
 * `REALTIME_DRIVER=off`: la TV va solo por polling de 15 s ±20 %, así que un llamado tiene que llegar en ≤ 20 s).
 *
 * - El tenant del fixture es INDIVIDUAL y `salaEspera` es de Clínica/Libre: se le concede con un grant de Plataforma
 *   (`Tenant.moduleGrants`, M12) escrito en la base local con la MISMA semántica que el escritor
 *   (`applyTenantEntitlementsInTx`: lista ordenada y sin repetidos). No se llama al escritor porque es `server-only`;
 *   la sesión (`lib/session.ts`) y la TV (`resolveDisplaySession`) leen la columna en cada request, sin cache. Se
 *   restaura en `afterAll` para no cambiarle la agenda a otra spec.
 * - Paciente y turno PROPIOS de hoy (no la Lucía del fixture: `recepcion.spec` ya la marcó «Llegó»). El apellido
 *   tiene que NO aparecer nunca en la TV: el feed solo lleva `shortPatientName` (nombre + inicial).
 * - Todo lo que no sea el server local se aborta (`context.route`): el iframe de YouTube nocookie y la vista previa del
 *   form no salen a internet. Solo se afirma el `src` del iframe.
 */
const PATIENT = { firstName: "Valentina", lastName: "Quiroga E2E" };
const SHORT = "Valentina Q.";
const DISPLAY_NAME = "TV de la sala E2E";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
/** Polling de 15 s con jitter de ±20 % (18 s de peor caso) + el request. */
const TV_LATENCY_MS = 20_000;

/** Hoy en Argentina (YYYY-MM-DD) a las `hh` AR (UTC−3 fijo). */
function arTodayAt(hh: number): Date {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  return new Date(`${today}T${String(hh + 3).padStart(2, "0")}:00:00.000Z`);
}

async function blockExternal(ctx: BrowserContext) {
  await ctx.route(
    (url) => url.origin !== new URL(E2E_BASE_URL).origin,
    (route) => route.abort()
  );
}

/** La tele: un contexto nuevo SIN cookies (ni la sesión del Titular). */
async function tvContext(browser: Browser) {
  const ctx = await browser.newContext({
    baseURL: E2E_BASE_URL,
    storageState: { cookies: [], origins: [] },
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    viewport: { width: 1920, height: 1080 },
  });
  await blockExternal(ctx);
  return ctx;
}

let prevGrants: string[] = [];
let patientId = "";
let bookingId = "";

test.beforeAll(async () => {
  const fx = readFixture();
  const db = ownerClient();
  try {
    const t = await db.tenant.findUniqueOrThrow({ where: { id: fx.tenantId }, select: { moduleGrants: true } });
    prevGrants = [...t.moduleGrants];
    const grants = [...new Set([...prevGrants, "salaEspera"])].sort();
    await db.tenant.update({ where: { id: fx.tenantId }, data: { moduleGrants: grants } });
    const p = await db.patient.create({
      data: { tenantId: fx.tenantId, ...PATIENT, documentId: `DNI-TV-${fx.tenantId.slice(-6)}`, assignedPractitionerId: fx.practitionerId },
      select: { id: true },
    });
    patientId = p.id;
    const b = await db.booking.create({
      data: {
        tenantId: fx.tenantId,
        patientId,
        practitionerId: fx.practitionerId,
        serviceId: fx.serviceId,
        locationId: fx.locationId,
        scheduledFor: arTodayAt(17),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `e2e-tv-${fx.tenantId}`,
      },
      select: { id: true },
    });
    bookingId = b.id;
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const fx = readFixture();
  const db = ownerClient();
  try {
    await db.tenant.update({ where: { id: fx.tenantId }, data: { moduleGrants: prevGrants } });
    await db.receptionDisplay.deleteMany({ where: { tenantId: fx.tenantId } });
    if (bookingId) await db.booking.deleteMany({ where: { id: bookingId } });
    if (patientId) await db.patient.deleteMany({ where: { id: patientId } });
  } finally {
    await db.$disconnect();
  }
});

test("TV: vincular con código, ver el llamado con el nombre corto y volver al vínculo al desvincular", async ({ page, browser, context }) => {
  test.setTimeout(150_000);
  const fx = readFixture();
  await blockExternal(context);

  // 1. Titular → /sala → «Pantallas» → «Agregar pantalla» (con video de YouTube) → código.
  await page.goto("/sala");
  await page.getByRole("button", { name: "Pantallas" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Pantallas" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Agregar pantalla" }).click();
  const form = page.getByRole("dialog", { name: "Agregar pantalla" });
  await form.getByRole("textbox", { name: "Nombre" }).fill(DISPLAY_NAME);
  await form.getByRole("textbox", { name: "Link de YouTube" }).fill(VIDEO_URL);
  await form.getByRole("button", { name: "Agregar y generar código" }).click();
  const codeEl = page.getByTestId("pairing-code");
  await expect(codeEl).toBeVisible();
  const code = (await codeEl.textContent())?.trim() ?? "";
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  // 2. La tele (sin cookies) abre /tv: CSP enforced, manifest propio, form de vínculo.
  const tvCtx = await tvContext(browser);
  try {
    const tv = await tvCtx.newPage();
    const res = await tv.goto("/tv");
    expect(res?.status()).toBe(200);
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com");
    expect(csp).toContain("frame-ancestors 'none'");
    const manifests = await tv.locator('link[rel="manifest"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(manifests).toEqual(["/tv/manifest"]);

    await expect(tv.getByRole("heading", { name: "Vinculá esta pantalla" })).toBeVisible();
    await tv.getByLabel("Código de la pantalla").fill(code);
    await tv.getByRole("button", { name: "Vincular" }).click();
    await expect(tv.getByText("Te damos la bienvenida.")).toBeVisible({ timeout: 15_000 });
    // El video: siempre el reproductor nocookie (el host está bloqueado; solo se mira la URL que arma la TV).
    const iframe = tv.locator("iframe").first();
    await expect(iframe).toHaveAttribute("src", /^https:\/\/www\.youtube-nocookie\.com\//);

    // 3. Otra pestaña del staff: turno de hoy → «Llegó» → «Llamar».
    const staff = await context.newPage();
    await staff.goto(`/agenda?view=timeline&date=${fx.today}`);
    await staff.getByRole("button", { name: new RegExp(PATIENT.lastName) }).first().click();
    const bookingDrawer = staff.getByRole("dialog", { name: "Turno" });
    await expect(bookingDrawer).toBeVisible();
    const reception = bookingDrawer.getByRole("group", { name: "Recepción" });
    await reception.getByRole("button", { name: "Llegó" }).click();
    await expect(staff.getByText(`Marcaste la llegada de ${PATIENT.firstName}`)).toBeVisible();
    // En sala y sin llamar: la TV la lista en «Próximos» (también con el nombre corto).
    await expect(tv.getByText(SHORT).first()).toBeVisible({ timeout: TV_LATENCY_MS });
    await reception.getByRole("button", { name: "Llamar" }).click();

    const db = ownerClient();
    try {
      await expect
        .poll(async () => (await db.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { calledAt: true } })).calledAt, {
          timeout: 10_000,
        })
        .not.toBeNull();
    } finally {
      await db.$disconnect();
    }

    // 4. ≤ 20 s: el llamado en grande con el nombre corto; el apellido completo, nunca.
    const hero = tv.getByRole("region", { name: "Llamado" });
    await expect(hero.getByText(SHORT, { exact: true })).toBeVisible({ timeout: TV_LATENCY_MS });
    await expect(tv.locator("body")).not.toContainText(PATIENT.lastName);
    await expect(tv.locator("body")).not.toContainText(`${PATIENT.firstName} ${PATIENT.lastName}`);

    // 5. Desvincular desde «Pantallas» → la TV vuelve a la pantalla de vínculo.
    await drawer.getByRole("button", { name: "Desvincular" }).click();
    const confirm = page.getByRole("dialog", { name: `¿Desvincular «${DISPLAY_NAME}»?` });
    await confirm.getByRole("button", { name: "Desvincular" }).click();
    await expect(page.getByText(`«${DISPLAY_NAME}» quedó desvinculada.`)).toBeVisible();
    await expect(tv.getByRole("heading", { name: "Vinculá esta pantalla" })).toBeVisible({ timeout: TV_LATENCY_MS });
    await expect(tv.getByText("Esta pantalla se desvinculó desde Sala de espera.", { exact: false })).toBeVisible();
    await expect(tv.locator("body")).not.toContainText(SHORT);
  } finally {
    await tvCtx.close();
  }
});
