import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { WA_COPY, WA_MESSAGE_STATUS_LABEL } from "../../lib/whatsapp/copy";
import { E2E_BASE_URL, E2E_STATE_DIR } from "./support/e2e-constants.mjs";
import { readFixture } from "./support/fixture";
import { cardMenu, insertNote, openHc, uid } from "./support/fichas";
import { RECOVERY_CODES, enableRecoveryOnlyTwoFactor, passTwoFactorWithRecovery, restoreTwoFactor } from "./support/subscription";
import { lastSentToPatient, openBookingDrawer, runMobile, simulatorReply, waitForSentMessage, wipeWhatsApp } from "./support/wa";

/**
 * WA-E (T6, X8; brief §26.5 C-WA5..C-WA9) · WhatsApp del consultorio contra el Meta FALSO, de punta a punta por la UI:
 *   1. Titular → Configuración → WhatsApp → «Conectar» (step-up) → popup «Simulador de Meta (solo desarrollo)» →
 *      «Conectar número de prueba» → «Conectado» y las 5 plantillas «Aprobada» (el simulador las aprueba solo a 1,5 s);
 *   2. alta de paciente con celular y la casilla de WhatsApp tildada → consentimiento GRANTED anclado a ese número;
 *   3. turno de mañana por «Nuevo turno» → el hook post-commit manda «Turno agendado» y el simulador encadena
 *      sent → delivered → read por webhook firmado → el historial del drawer dice «Leído»;
 *   4. «Enviar recordatorio por WhatsApp» → «Confirmo» en el panel del simulador → badge «Confirmó» en la agenda;
 *   5. otro turno → recordatorio → «No puedo ir» → campana «… avisó que no puede ir» y el turno NO se cancela (WA-D7);
 *   6. BAJA desde el simulador → «Editar paciente» dice «Se dio de baja por WhatsApp…»;
 *   7. ALTA desde el simulador → compartir una ficha con «El paciente pidió recibirlo por WhatsApp» → enviado o en cola;
 *   8. turnero público a 390 px: la casilla de WhatsApp aparece DESTILDADA (cuenta activa);
 *   9. «Desconectar WhatsApp» (useConfirm) → vuelve a «Conectá…», credencial borrada.
 *
 * El step-up (C-WA9: connect/disconnect = `account.owner` + step-up) se pasa con un código de recuperación, igual que
 * MPS-E (`support/subscription.ts`). Todo lo que no sea el server local se aborta (`context.route`): el simulador y sus
 * webhooks son del mismo origen. `afterAll` deja el consultorio sin WhatsApp y el Titular sin 2FA.
 *
 * `recepcion.spec.ts` (wa.me manual) corre ANTES que este (orden alfabético, `workers: 1`) y no depende de la cuenta.
 */

// Copy de la UI duplicado A PROPÓSITO (los módulos que lo exportan son `.tsx` de cliente con CSS modules: no se importan
// desde Playwright). Si cambia el copy, la spec cae en el paso que lo usa, no en silencio.
const SECTION_SEND_REMINDER = "Enviar recordatorio por WhatsApp"; // components/agenda/booking-drawer/whatsapp-section.tsx WA_SECTION_COPY
const TURNERO_WA_LABEL = "Quiero recibir avisos de mis turnos por WhatsApp"; // components/booking/wizard/data-step.tsx

let ctx: BrowserContext;
let page: Page;
let twoFactorBefore: { twoFactorEmail: boolean; twoFactorTotp: boolean } | null = null;

const phone = runMobile();
const person = { firstName: "Valeria", lastName: `Avisos E2E ${uid().slice(-4)}` };
let patientId = "";
let booking1 = "";
let booking2 = "";

/** Instante de `day` a las `hh:mm` de Argentina (UTC−3 fijo). */
const arAt = (day: string, hh: number) => new Date(`${day}T${String(hh + 3).padStart(2, "0")}:00:00.000Z`);

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await wipeWhatsApp();
  twoFactorBefore = await enableRecoveryOnlyTwoFactor();
  ctx = await browser.newContext({
    baseURL: E2E_BASE_URL,
    storageState: `${E2E_STATE_DIR}/owner.json`,
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    viewport: { width: 1366, height: 900 },
  });
  await ctx.route(
    (url) => url.origin !== new URL(E2E_BASE_URL).origin,
    (route) => route.abort()
  );
  page = await ctx.newPage();
});

test.afterAll(async () => {
  await ctx?.close();
  if (twoFactorBefore) await restoreTwoFactor(twoFactorBefore);
  await wipeWhatsApp();
  const fx = readFixture();
  const db = ownerClient();
  try {
    // Turnos y paciente de la corrida: hijo → padre (los mensajes ya se fueron en wipeWhatsApp). Las fichas y el
    // documento compartido del paciente los barre el teardown con el tenant.
    await db.booking.deleteMany({ where: { tenantId: fx.tenantId, id: { in: [booking1, booking2].filter(Boolean) } } });
  } finally {
    await db.$disconnect();
  }
});

async function openWhatsAppTab() {
  await page.goto("/configuracion?tab=whatsapp");
  await expect(page.locator("[data-wa-state]")).toBeVisible({ timeout: 20_000 });
}

test("whatsapp 1: «Conectar» con el simulador de Meta → «Conectado» y plantillas aprobadas", async () => {
  await page.goto("/configuracion?tab=whatsapp");
  await passTwoFactorWithRecovery(page, RECOVERY_CODES[0]);
  await expect(page).toHaveURL(/tab=whatsapp/);
  await expect(page.locator('[data-wa-state="connect"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Simulador local: la ventana es un Meta falso")).toBeVisible();

  // El popup se abre DESPUÉS de la action (step-up): si el navegador lo bloqueara, aparece «Abrir el simulador de Meta».
  const popupP = page.waitForEvent("popup", { timeout: 15_000 }).catch(() => null);
  await page.getByRole("button", { name: "Conectar", exact: true }).click();
  let popup = await popupP;
  if (!popup) {
    const again = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Abrir el simulador de Meta" }).click();
    popup = await again;
  }
  await expect(popup.getByText(WA_COPY.simulatorTitle)).toBeVisible();
  await expect(popup.getByRole("heading", { name: "Conectar un número de WhatsApp" })).toBeVisible();
  await popup.getByRole("button", { name: "Conectar número de prueba" }).click();

  await expect(page.locator('[data-wa-state="connected"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Conectado", { exact: true })).toBeVisible();
  // Las 5 plantillas: el simulador las aprueba a los 1,5 s por webhook firmado; el panel se relee al recargar.
  await expect(async () => {
    await openWhatsAppTab();
    const tpl = page.locator("[data-wa-template]");
    await expect(tpl).toHaveCount(5);
    await expect(tpl.filter({ hasText: "Aprobada" })).toHaveCount(5, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  const fx = readFixture();
  const db = ownerClient();
  try {
    const acc = await db.whatsAppAccount.findFirstOrThrow({
      where: { tenantId: fx.tenantId, status: "ACTIVE" },
      select: { mode: true, setupStep: true, credentials: { select: { id: true } } },
    });
    expect(acc.mode).toBe("fake");
    expect(acc.setupStep).toBe("DONE");
    expect(acc.credentials).toHaveLength(1);
  } finally {
    await db.$disconnect();
  }
});

test("whatsapp 2: alta de paciente con celular y la casilla de WhatsApp → consentimiento anclado al número", async () => {
  const dni = String(30_000_000 + (Date.now() % 9_000_000));
  await page.goto("/pacientes");
  await page.getByRole("button", { name: "Nuevo paciente" }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Cargar paciente" })).toBeVisible();
  await drawer.getByLabel("Nombre").fill(person.firstName);
  await drawer.getByLabel("Apellido").fill(person.lastName);
  await drawer.getByLabel("DNI").fill(dni);
  await drawer.getByLabel("Teléfono").fill(phone.typed);
  const consent = drawer.getByRole("checkbox", { name: WA_COPY.consentCheckbox });
  await expect(consent).not.toBeChecked(); // destildada: se consiente, no se presume
  await consent.check();
  await drawer.getByRole("button", { name: "Crear paciente" }).click();
  await expect(page).toHaveURL(/\/pacientes\/[^/?]+/);
  patientId = new URL(page.url()).pathname.split("/")[2];

  const fx = readFixture();
  const db = ownerClient();
  try {
    await expect
      .poll(async () => (await db.patient.findUniqueOrThrow({ where: { id: patientId }, select: { waConsent: true } })).waConsent)
      .toBe("GRANTED");
    const p = await db.patient.findUniqueOrThrow({ where: { id: patientId }, select: { tenantId: true, waPhoneE164: true, waConsentSource: true } });
    expect(p.tenantId).toBe(fx.tenantId);
    expect(p.waPhoneE164).toBe(phone.e164);
  } finally {
    await db.$disconnect();
  }
});

test("whatsapp 3: turno de mañana → «Turno agendado» sale solo y el historial del drawer llega a «Leído»", async () => {
  const fx = readFixture();
  const day = fx.moveDay;
  await page.goto(`/agenda?view=timeline&date=${day}`);
  await page.getByRole("button", { name: "Nuevo turno", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Nuevo turno" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Profesional").selectOption(fx.practitionerId);
  await dialog.getByLabel("Servicio").selectOption(fx.serviceId);
  await dialog.getByRole("combobox", { name: "Buscar paciente" }).fill(person.lastName);
  await dialog.getByRole("option", { name: new RegExp(person.lastName) }).first().click();
  await dialog.locator('input[type="date"]').first().fill(day);
  await dialog.getByLabel("Hora", { exact: true }).selectOption("16");
  await dialog.getByLabel("Minutos", { exact: true }).selectOption("00");
  await dialog.getByRole("button", { name: "Crear turno" }).click();
  await expect(page.getByText("Turno creado")).toBeVisible();

  const db = ownerClient();
  try {
    const b = await db.booking.findFirstOrThrow({ where: { tenantId: fx.tenantId, patientId, scheduledFor: arAt(day, 16) }, select: { id: true } });
    booking1 = b.id;
  } finally {
    await db.$disconnect();
  }
  await waitForSentMessage(booking1, "BOOKING_CREATED");

  // El panel del drawer se lee al abrir: se reabre hasta que los webhooks de estado lleguen a «Leído».
  await expect(async () => {
    const drawer = await openBookingDrawer(page, day, person.lastName, "16:00");
    const section = drawer.getByRole("region", { name: "WhatsApp" });
    const item = section.locator("li[data-wa-status]").filter({ hasText: "Turno agendado" });
    await expect(item).toHaveAttribute("data-wa-status", WA_MESSAGE_STATUS_LABEL.READ, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
});

test("whatsapp 4: «Enviar recordatorio por WhatsApp» → «Confirmo» en el simulador → badge «Confirmó»", async () => {
  const fx = readFixture();
  const drawer = await openBookingDrawer(page, fx.moveDay, person.lastName, "16:00");
  const section = drawer.getByRole("region", { name: "WhatsApp" });
  await section.getByRole("button", { name: SECTION_SEND_REMINDER }).click();
  const reminder = await waitForSentMessage(booking1, "BOOKING_REMINDER");
  await expect(section.locator("li[data-wa-status]").filter({ hasText: "Recordatorio" })).toBeVisible();

  const flash = await simulatorReply(ctx, reminder.wamid, "Confirmo");
  expect(flash).toContain("respuesta 200");
  expect(flash).toContain("confirmed");

  await page.goto(`/agenda?view=timeline&date=${fx.moveDay}`);
  await expect(page.getByRole("img", { name: "El paciente confirmó el turno por WhatsApp" })).toBeVisible();
  const db = ownerClient();
  try {
    const b = await db.booking.findUniqueOrThrow({ where: { id: booking1 }, select: { patientConfirmedAt: true, status: true } });
    expect(b.patientConfirmedAt).not.toBeNull();
    expect(b.status).toBe("CONFIRMED");
  } finally {
    await db.$disconnect();
  }
});

test("whatsapp 5: otro turno → «No puedo ir» → campana con el aviso y el turno sigue agendado", async () => {
  const fx = readFixture();
  const db = ownerClient();
  try {
    const b = await db.booking.create({
      data: {
        tenantId: fx.tenantId,
        patientId,
        practitionerId: fx.practitionerId,
        serviceId: fx.serviceId,
        locationId: fx.locationId,
        scheduledFor: arAt(fx.moveDay, 17),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `e2e-wa-2-${uid()}`,
      },
      select: { id: true },
    });
    booking2 = b.id;
  } finally {
    await db.$disconnect();
  }

  const drawer = await openBookingDrawer(page, fx.moveDay, person.lastName, "17:00");
  await drawer.getByRole("region", { name: "WhatsApp" }).getByRole("button", { name: SECTION_SEND_REMINDER }).click();
  const reminder = await waitForSentMessage(booking2, "BOOKING_REMINDER");
  const flash = await simulatorReply(ctx, reminder.wamid, "No puedo ir");
  expect(flash).toContain("cancel_requested");

  await page.goto(`/agenda?view=timeline&date=${fx.moveDay}`);
  await expect(page.getByRole("img", { name: "El paciente avisó por WhatsApp que no puede ir" })).toBeVisible();
  // La campana vive en el Inicio (la agenda no tiene topbar).
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Notificaciones" }).first().click();
  await expect(
    page.getByRole("dialog", { name: "Notificaciones" }).getByText(`${person.firstName} ${person.lastName} avisó que no puede ir`)
  ).toBeVisible();

  const db2 = ownerClient();
  try {
    const b = await db2.booking.findUniqueOrThrow({ where: { id: booking2 }, select: { status: true, patientCancelRequestedAt: true } });
    expect(b.status).toBe("CONFIRMED"); // WA-D7: no se cancela solo
    expect(b.patientCancelRequestedAt).not.toBeNull();
  } finally {
    await db2.$disconnect();
  }
});

test("whatsapp 6: BAJA desde el simulador → «Editar paciente» dice «Se dio de baja por WhatsApp»", async () => {
  const flash = await simulatorReply(ctx, await lastSentToPatient(patientId), "BAJA");
  expect(flash).toContain("opted_out");

  await page.goto(`/pacientes/${patientId}`);
  await page.getByRole("button", { name: "Editar", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Editar paciente" });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-wa-consent-row="REVOKED"]')).toContainText(/Se dio de baja por WhatsApp el \d{2}\/\d{2}/);
  const db = ownerClient();
  try {
    const p = await db.patient.findUniqueOrThrow({ where: { id: patientId }, select: { waConsent: true, waConsentSource: true } });
    expect(p).toEqual({ waConsent: "REVOKED", waConsentSource: "WHATSAPP" });
  } finally {
    await db.$disconnect();
  }
});

test("whatsapp 7: ALTA → compartir una ficha por WhatsApp (el paciente lo pidió) → enviado o en cola", async () => {
  const fx = readFixture();
  const flash = await simulatorReply(ctx, await lastSentToPatient(patientId), "ALTA");
  expect(flash).toContain("opted_in");

  const title = `Por WhatsApp ${uid()}`;
  const noteId = await insertNote(fx, patientId, { title, body: `Indicaciones: hielo 15 min. ${title}.` });
  await openHc(page, patientId);
  await cardMenu(page, noteId, "Compartir con el paciente");
  const dialog = page.getByRole("dialog", { name: "Compartir con el paciente" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox", { name: "Enviar también por WhatsApp" }).check();
  const share = dialog.getByRole("button", { name: "Compartir", exact: true });
  await expect(share).toBeDisabled(); // sin la constancia no se comparte
  await dialog.getByRole("checkbox", { name: WA_COPY.shareByWhatsApp }).check();
  await share.click();
  // Sin portal (ni email) el diálogo queda en el resultado, con la línea de WhatsApp.
  const wa = dialog.locator("[data-share-wa]");
  await expect(wa).toBeVisible({ timeout: 15_000 });
  expect(["success", "info"]).toContain(await wa.getAttribute("data-share-wa"));

  const db = ownerClient();
  try {
    const m = await db.whatsAppMessage.findFirstOrThrow({
      where: { tenantId: fx.tenantId, patientId, kind: "DOCUMENT_SHARED" },
      select: { status: true, templateName: true },
    });
    expect(["QUEUED", "SENDING", "SENT", "DELIVERED", "READ"]).toContain(m.status);
    expect(m.templateName).toBe("cs_documento_v1");
  } finally {
    await db.$disconnect();
  }
});

test("whatsapp 8: turnero público a 390 px con la cuenta activa → casilla de WhatsApp destildada", async ({ browser }) => {
  const fx = readFixture();
  const pub = await browser.newContext({
    baseURL: E2E_BASE_URL,
    storageState: { cookies: [], origins: [] },
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await pub.route(
    (url) => url.origin !== new URL(E2E_BASE_URL).origin,
    (route) => route.abort()
  );
  try {
    const p = await pub.newPage();
    await p.goto(`/c/${fx.slug}/booking`);
    await expect(p.getByRole("heading", { level: 1, name: "Reservá tu turno" })).toBeVisible();
    await p.getByRole("button", { name: /Consulta/ }).click();
    await p.getByRole("button", { name: "Continuar" }).click();
    const slot = p.locator("button[data-slot-iso]").first();
    await expect(slot).toBeVisible({ timeout: 20_000 });
    await slot.click();
    await p.getByRole("button", { name: "Continuar" }).click();
    await expect(p.locator("#booking-phone")).toBeVisible();
    const box = p.getByRole("checkbox", { name: TURNERO_WA_LABEL });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    // Sin scroll horizontal a 390.
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await pub.close();
  }
});

test("whatsapp 9: «Desconectar WhatsApp» → vuelve a «Conectá…» y se borra la credencial", async () => {
  await openWhatsAppTab();
  await page.getByRole("button", { name: WA_COPY.disconnect }).click();
  const confirm = page.getByRole("dialog", { name: "¿Desconectar el WhatsApp del consultorio?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: WA_COPY.disconnect }).click();
  await expect(page.locator('[data-wa-state="connect"]')).toBeVisible({ timeout: 20_000 });

  const fx = readFixture();
  const db = ownerClient();
  try {
    const acc = await db.whatsAppAccount.findFirstOrThrow({
      where: { tenantId: fx.tenantId },
      orderBy: { createdAt: "desc" },
      select: { status: true, credentials: { select: { id: true } } },
    });
    expect(acc.status).toBe("DISCONNECTED");
    expect(acc.credentials).toHaveLength(0);
  } finally {
    await db.$disconnect();
  }
});
