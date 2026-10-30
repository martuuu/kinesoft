import { expect, test, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { arAt, arDay, createCfTenant, deleteCfTenant, type CfTenant } from "./support/cf";

// Superficie pública: sin sesión del staff.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * CF-E2E (§28, decisiones 1 y 5 de Martin) · turnero de un consultorio Kinesiología propio (`support/cf.ts`): dos
 * servicios del mismo profesional (A y B, 60', turnero cada 30') y el interruptor «Atiende servicios distintos a la
 * vez» apagado (default).
 *  - Bloqueo duro: con un turno de A mañana a las 10:00, B no ofrece ese horario (ni los que se pisan) y A sí (ilimitado).
 *  - Datos: la fecha de nacimiento ya no es obligatoria; el «Diagnóstico» sí (sin él, «Confirmar turno» no se habilita).
 *
 * `pub:submit` es 5 reservas cada 5' por IP: este spec hace UNA sola (como `turnero.spec.ts`).
 */
let fx: CfTenant | null = null;

test.beforeAll(async () => {
  const db = ownerClient();
  try {
    fx = await createCfTenant(db, { saasPlan: "INDIVIDUAL", vertical: "KINESIOLOGY", patients: [{ firstName: "Olga", lastName: "Turno A E2E" }] });
    await db.booking.create({
      data: {
        tenantId: fx.tenantId,
        patientId: fx.patients[0].id,
        practitionerId: fx.practitionerId,
        serviceId: fx.serviceA.id,
        locationId: fx.locationId,
        scheduledFor: arAt(arDay(1), 10),
        durationMin: 60,
        status: "CONFIRMED",
        idempotencyKey: `e2e-cf-turnero-a-${fx.tenantId}`,
      },
    });
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = ownerClient();
  try {
    await deleteCfTenant(db, fx);
  } finally {
    await db.$disconnect();
  }
});

async function openSlots(page: Page, serviceName: string) {
  await page.goto(`/c/${fx!.slug}/booking`);
  await expect(page.getByRole("heading", { level: 1, name: "Reservá tu turno" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "¿Qué servicio necesitás?" })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(serviceName) }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { name: "Elegí día y horario" })).toBeVisible();
  await expect(page.locator("button[data-slot-iso]").first()).toBeVisible({ timeout: 20_000 });
}

const isoOf = (d: Date) => d.toISOString();

test("[CF-E2E] turnero: un turno de otro servicio bloquea ese horario (bloqueo duro); el mismo servicio lo sigue ofreciendo", async ({ page }) => {
  const tomorrow = arDay(1);
  const busy = isoOf(arAt(tomorrow, 10));
  const overlapping = isoOf(arAt(tomorrow, 10, 30)); // pisa 10:00-11:00 (60')
  const before = isoOf(arAt(tomorrow, 9, 30)); // 9:30-10:30 también pisa
  const free = isoOf(arAt(tomorrow, 12));

  // B (Osteo): ni 9:30, ni 10:00, ni 10:30 de mañana; 12:00 sí (control: la grilla de ese día existe).
  await openSlots(page, fx!.serviceB.name);
  await expect(page.locator(`button[data-slot-iso="${free}"]`)).toBeVisible();
  for (const iso of [before, busy, overlapping]) await expect(page.locator(`button[data-slot-iso="${iso}"]`), iso).toHaveCount(0);

  // A (Kinesio, ilimitado): el mismo servicio no choca → 10:00 se ofrece.
  await openSlots(page, fx!.serviceA.name);
  await expect(page.locator(`button[data-slot-iso="${busy}"]`)).toBeVisible();
});

test("[CF-E2E] turnero Kine: sin «Diagnóstico» no deja confirmar; sin fecha de nacimiento reserva igual", async ({ page }) => {
  await openSlots(page, fx!.serviceB.name);
  const slot = page.locator("button[data-slot-iso]").first();
  const slotIso = await slot.getAttribute("data-slot-iso");
  await slot.click();
  await expect(slot).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continuar" }).click();

  const dni = `CF${Date.now().toString().slice(-7)}`;
  await page.locator("#booking-firstName").fill("Nadia");
  await page.locator("#booking-lastName").fill("Turnero CF E2E");
  await page.locator("#booking-email").fill(`nadia.${dni.toLowerCase()}@example.com`);
  await page.locator("#booking-phone").fill("1155550177");
  await page.locator("#booking-documentId").fill(dni);
  // Fecha de nacimiento: opcional (no se completa) y sin `required` en el input.
  await expect(page.locator("#booking-dateOfBirth")).toHaveValue("");
  await expect(page.locator("#booking-dateOfBirth")).not.toHaveAttribute("required", /.*/);
  // Diagnóstico: obligatorio en Kinesiología.
  const title = page.locator("#booking-title");
  await expect(title).toHaveAttribute("required", /.*/);
  await expect(page.getByText("Si no tenés un diagnóstico médico, contanos qué te pasa (ej. dolor de rodilla).")).toBeVisible();
  const confirm = page.getByRole("button", { name: "Confirmar turno" });
  await expect(confirm).toBeDisabled();

  await title.fill("Lumbalgia");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await page.waitForURL(/\/booking\/[^/]+\/ok/);
  await expect(page.getByRole("heading", { level: 1, name: "¡Turno reservado!" })).toBeVisible();

  // Efecto observable: el turno quedó en el horario elegido, de B, con paciente sin fecha de nacimiento.
  const db = ownerClient();
  try {
    const booking = await db.booking.findFirst({
      where: { tenantId: fx!.tenantId, scheduledFor: new Date(slotIso!), patient: { documentId: { contains: dni.slice(2) } } },
      select: { status: true, serviceId: true, patient: { select: { dateOfBirth: true } } },
    });
    expect(booking).not.toBeNull();
    expect(booking!.serviceId).toBe(fx!.serviceB.id);
    expect(booking!.status).not.toBe("CANCELLED");
    expect(booking!.patient).not.toBeNull();
    expect(booking!.patient?.dateOfBirth ?? null).toBeNull();
  } finally {
    await db.$disconnect();
  }
});
