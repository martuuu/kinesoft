import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { WhatsAppMessageKind, WhatsAppMessageStatus } from "@prisma/client";
import { ownerClient } from "../../helpers/tenant-factory";
import { readFixture } from "./fixture";

/**
 * WA-E (T6, X8) · helpers de `whatsapp.spec.ts`: el WhatsApp del consultorio del fixture contra el Meta FALSO
 * (`WHATSAPP_MODE=fake`, literales de `DEV_WAFAKE_LITERALS`: lo fija `start-server.mjs`). El simulador vive en el MISMO
 * origen (`/api/whatsapp/fake/**`) y sus webhooks entran por la ruta real `/api/webhooks/whatsapp`, firmados con el
 * App Secret de prueba: nada sale del server local.
 *
 * Por qué el panel del simulador se maneja por la fila del `wamid` (input hidden de sus forms) y no por el número
 * enmascarado: el panel lista los últimos 30 mensajes de TODO el proceso (no por consultorio), y dos mensajes al mismo
 * paciente (aviso + recordatorio) comparten el «Para». El `wamid` sale de la base (canal owner), que es el efecto
 * observable de la cola.
 */

export const SIM_PANEL = "/api/whatsapp/fake/panel";

/**
 * Celular AR válido para la corrida, distinto en cada una y lejos de los números mágicos del simulador (`…0001` a
 * `…0004` = errores de Meta). `normalizeArMobile("11 5577 NNNN")` → `+54911 5577 NNNN`.
 */
export function runMobile(): { typed: string; e164: string } {
  const n = String(1000 + (Date.now() % 8000)).padStart(4, "0");
  return { typed: `11 5577 ${n}`, e164: `+54911 5577 ${n}`.replace(/\s/g, "") };
}

/** Mensaje de la cola de un turno (el más nuevo de ese tipo), esperando hasta que tenga `wamid` (ya salió a «Meta»). */
export async function waitForSentMessage(
  bookingId: string,
  kind: WhatsAppMessageKind,
  opts: { timeoutMs?: number } = {}
): Promise<{ id: string; wamid: string; status: WhatsAppMessageStatus }> {
  const fx = readFixture();
  const db = ownerClient();
  try {
    let row: { id: string; wamid: string | null; status: WhatsAppMessageStatus } | null = null;
    await expect
      .poll(
        async () => {
          row = await db.whatsAppMessage.findFirst({
            where: { tenantId: fx.tenantId, bookingId, kind },
            orderBy: { createdAt: "desc" },
            select: { id: true, wamid: true, status: true },
          });
          return row?.wamid ?? null;
        },
        { timeout: opts.timeoutMs ?? 15_000, message: `mensaje ${kind} del turno ${bookingId} con wamid` }
      )
      .not.toBeNull();
    const r = row as unknown as { id: string; wamid: string; status: WhatsAppMessageStatus };
    return r;
  } finally {
    await db.$disconnect();
  }
}

/** Último mensaje que salió a un paciente (cualquier tipo, con wamid): para la BAJA/ALTA del panel. */
export async function lastSentToPatient(patientId: string): Promise<string> {
  const fx = readFixture();
  const db = ownerClient();
  try {
    const m = await db.whatsAppMessage.findFirst({
      where: { tenantId: fx.tenantId, patientId, wamid: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { wamid: true },
    });
    if (!m?.wamid) throw new Error("wa-e: el paciente no tiene ningún mensaje enviado");
    return m.wamid;
  } finally {
    await db.$disconnect();
  }
}

/**
 * Panel del simulador en una pestaña aparte del mismo contexto: «responde como el paciente» sobre el mensaje `wamid`
 * con uno de sus botones (Confirmo, No puedo ir, BAJA, ALTA). Devuelve el flash («Webhook enviado · respuesta 200 ·
 * <outcome>»): el outcome lo escribe el webhook REAL de la app.
 */
export async function simulatorReply(ctx: BrowserContext, wamid: string, button: "Confirmo" | "No puedo ir" | "BAJA" | "ALTA"): Promise<string> {
  const sim = await ctx.newPage();
  try {
    await sim.goto(SIM_PANEL);
    await expect(sim.getByRole("heading", { name: "Panel del simulador de Meta" })).toBeVisible();
    const row = sim.locator("tr").filter({ has: sim.locator(`input[name="wamid"][value="${wamid}"]`) });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: button, exact: true }).click();
    const flash = sim.locator("p.flash");
    await expect(flash).toBeVisible();
    return (await flash.textContent()) ?? "";
  } finally {
    await sim.close();
  }
}

/** Abre el turno desde la grilla del día (timeline) por el apellido del paciente. */
export async function openBookingDrawer(page: Page, day: string, patientLastName: string, hhmm: string) {
  await page.goto(`/agenda?view=timeline&date=${day}`);
  await page
    .getByRole("button", { name: new RegExp(patientLastName) })
    .filter({ hasText: hhmm })
    .first()
    .click();
  const drawer = page.getByRole("dialog", { name: "Turno" });
  await expect(drawer).toBeVisible();
  return drawer;
}

/**
 * Restaura el consultorio del fixture: las filas de WhatsApp de la corrida (hijo → padre, el orden de la factory),
 * las campanas de «No puedo ir» y el consentimiento de los pacientes. El estado en memoria del simulador queda (es del
 * proceso del server y no lo lee ningún otro spec).
 */
export async function wipeWhatsApp(): Promise<void> {
  const fx = readFixture();
  const db = ownerClient();
  try {
    const where = { tenantId: fx.tenantId };
    await db.whatsAppInbound.deleteMany({ where });
    await db.whatsAppMessage.deleteMany({ where });
    await db.whatsAppTemplate.deleteMany({ where });
    await db.whatsAppCredential.deleteMany({ where });
    await db.whatsAppAccount.deleteMany({ where });
    await db.notification.deleteMany({ where: { tenantId: fx.tenantId, kind: "BOOKING_PATIENT_REPLY" } });
  } finally {
    await db.$disconnect();
  }
}
