import { expect, test, type Page } from "@playwright/test";
import { ownerClient, uniqueSuffix } from "../helpers/tenant-factory";
import { freshContext, pvLoginAs, readPvFixture, submitLogin } from "./support/pv";

/**
 * PV (§27, bloque TK, ola Q4) · Tickets en /plataforma de punta a punta por la UI real:
 *  1. anónimo en `/contacto?motivo=precio` → ticket LEAD «Web · precios» / «Nuevo» → el superadmin lo toma, anota,
 *     lo resuelve (con el confirm) y lo reabre; filtros de etapa y origen;
 *  2. Titular con consultorio usable → `/contacto?motivo=plan` redirige a Configuración → Soporte con el borrador;
 *  3. Titular de un consultorio SUSPENDIDO → form de sesión («Te respondemos a {email}») → ticket «Consultorio
 *     suspendido»; usuario deshabilitado → ticket «Cuenta desactivada»;
 *  4. ningún `mailto:` en `/suspendido` ni en el pie de la landing.
 *
 * Fixtures: `support/pv.ts` (superadmin sin consultorio, consultorio suspendido, usuario deshabilitado). El Titular del
 * caso 2 es el del fixture principal (sesión de `auth.setup.ts`): el spec NO envía el borrador, así no le deja un hilo.
 */

/** Ticket por asunto en la lista de Tickets (la fila es un link con el asunto, origen y etapa). */
function ticketRow(page: Page, subject: string | RegExp) {
  return page.getByRole("list", { name: "Tickets" }).getByRole("link").filter({ hasText: subject });
}

test.describe("tickets", () => {
  test("lead de precios: Web · precios → Tomar → nota → Marcar resuelto → Reabrir, con filtros", async ({ browser }) => {
    const fx = readPvFixture();
    const name = `Lead Precio ${uniqueSuffix()}`;
    const email = `${fx.leadEmailPrefix}${uniqueSuffix()}@test.local`;

    // (1a) Anónimo: el form de lead de la landing con el origen oculto.
    const anon = await freshContext(browser);
    const p = await anon.newPage();
    await p.goto("/contacto?motivo=precio");
    await expect(p.getByRole("heading", { name: "Pedinos el precio" })).toBeVisible();
    const form = p.getByRole("form", { name: "Pedinos el precio" });
    await expect(form.locator('input[type="hidden"][name="source"]')).toHaveValue("PRICING");
    await form.getByLabel("Nombre").fill(name);
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Mensaje").fill("Somos tres kinesiólogos, ¿cuánto sale?");
    // Anti-bot (`leadBotVerdict`): menos de 3 s entre que se mostró el form y el envío se descarta en silencio.
    await p.waitForTimeout(3_500);
    await form.getByRole("button", { name: "Enviar consulta" }).click();
    await expect(p.getByRole("status")).toContainText("Recibimos tu consulta.");
    await anon.close();

    // El hilo existe con su origen (efecto observable en la base, no solo el mensaje de éxito).
    const db = ownerClient();
    let threadId: string;
    try {
      const t = await db.supportThread.findFirstOrThrow({
        where: { kind: "LEAD", leadEmail: email },
        select: { id: true, source: true, subject: true, status: true, platformTakenAt: true },
      });
      expect(t).toMatchObject({ source: "PRICING", status: "OPEN", platformTakenAt: null });
      expect(t.subject).toBe(`Precio · Consulta de ${name}`);
      threadId = t.id;
    } finally {
      await db.$disconnect();
    }

    // (1b) Superadmin: aparece en Tickets como «Web · precios» / «Nuevo».
    const { ctx, page } = await pvLoginAs(browser, fx.superadmin, "/plataforma/mensajes");
    try {
      await page.goto("/plataforma/mensajes");
      await expect(page.getByRole("heading", { name: "Tickets", level: 1 })).toBeVisible();
      const row = ticketRow(page, name);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Web · precios");
      await expect(row).toContainText("Nuevo");
      await expect(row).toHaveAttribute("data-stage", "NEW");

      // Filtros: «Nuevos» lo muestra, «Resueltos» no; el origen «Web · precios» (select por GET) lo muestra.
      await page.goto("/plataforma/mensajes?estado=nuevos");
      await expect(ticketRow(page, name)).toHaveCount(1);
      await page.goto("/plataforma/mensajes?estado=resueltos");
      await expect(ticketRow(page, name)).toHaveCount(0);
      await page.goto("/plataforma/mensajes");
      await page.getByRole("form", { name: "Filtrar por origen" }).getByLabel("Origen").selectOption({ label: "Web · precios" });
      await page.getByRole("button", { name: "Filtrar" }).click();
      await expect(page).toHaveURL(/origen=precio/);
      await expect(ticketRow(page, name)).toHaveCount(1);
      await page.goto("/plataforma/mensajes?origen=suspendido");
      await expect(ticketRow(page, name)).toHaveCount(0);

      // Detalle.
      await page.goto("/plataforma/mensajes");
      await ticketRow(page, name).click();
      await expect(page).toHaveURL(new RegExp(`/plataforma/mensajes/${threadId}`));
      await expect(page.getByRole("heading", { level: 1, name: `Precio · Consulta de ${name}` })).toBeVisible();
      const actions = page.getByRole("group", { name: "Acciones del ticket" });

      // Tomar → «En curso» y «Tomado por …».
      await actions.getByRole("button", { name: "Tomar" }).click();
      await expect(page.getByText("Ticket tomado")).toBeVisible();
      await expect(actions.getByRole("button", { name: "Tomar" })).toHaveCount(0);
      await expect(page.getByText("En curso", { exact: true }).first()).toBeVisible();
      await expect(page.getByText(fx.superadmin.fullName).first()).toBeVisible();

      // Nota interna: «Nota guardada» y se ve en el detalle.
      const note = `Lo llamé por WhatsApp ${uniqueSuffix()}`;
      await page.getByLabel("Nueva nota").fill(note);
      await page.getByRole("button", { name: "Agregar nota" }).click();
      await expect(page.getByText("Nota guardada")).toBeVisible();
      await expect(page.getByRole("list", { name: "Notas internas" })).toContainText(note);

      // Marcar resuelto, con el confirm.
      await actions.getByRole("button", { name: "Marcar resuelto" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("¿Marcar como resuelto?");
      await expect(dialog).toContainText("Pasa a Resueltos. Si respondés, se vuelve a abrir.");
      await dialog.getByRole("button", { name: "Marcar resuelto" }).click();
      await expect(page.getByText("Ticket resuelto")).toBeVisible();
      await expect(actions.getByRole("button", { name: "Reabrir" })).toBeVisible();

      await page.goto("/plataforma/mensajes?estado=resueltos");
      await expect(ticketRow(page, name)).toHaveCount(1);
      await expect(ticketRow(page, name)).toContainText("Resuelto");

      // Reabrir: vuelve a «En curso» (ya lo había tomado alguien), no a «Nuevo».
      await page.goto(`/plataforma/mensajes/${threadId}`);
      await page.getByRole("group", { name: "Acciones del ticket" }).getByRole("button", { name: "Reabrir" }).click();
      await expect(page.getByText("Ticket reabierto")).toBeVisible();
      await page.goto("/plataforma/mensajes?estado=en-curso");
      const reopened = ticketRow(page, name);
      await expect(reopened).toHaveCount(1);
      await expect(reopened).toHaveAttribute("data-stage", "IN_PROGRESS");
      await expect(reopened).toContainText(`Tomado por ${fx.superadmin.fullName}`);
      await page.goto("/plataforma/mensajes?estado=nuevos");
      await expect(ticketRow(page, name)).toHaveCount(0);
    } finally {
      await ctx.close();
    }

    const db2 = ownerClient();
    try {
      const t = await db2.supportThread.findUniqueOrThrow({
        where: { id: threadId },
        select: { status: true, platformTakenById: true, _count: { select: { notes: true } } },
      });
      expect(t).toMatchObject({ status: "OPEN", platformTakenById: fx.superadmin.id, _count: { notes: 1 } });
    } finally {
      await db2.$disconnect();
    }
  });

  test("Titular con consultorio usable: /contacto?motivo=plan → Configuración → Soporte con el borrador", async ({ page }) => {
    // Sesión del Titular del fixture principal (storageState del proyecto).
    // El redirect del server lleva `nuevo=plan`; con el borrador ya en el Drawer, el cliente lo saca de la URL
    // (configuracion-client.tsx: un refresh no lo vuelve a abrir). Se afirma el redirect en la respuesta y el Drawer.
    const res = await page.request.get("/contacto?motivo=plan", { maxRedirects: 0 });
    expect([303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"]).toMatch(/\/configuracion\?tab=soporte&nuevo=plan$/);
    await page.goto("/contacto?motivo=plan");
    await expect(page).toHaveURL(/\/configuracion\?tab=soporte/);
    const drawer = page.getByRole("dialog", { name: "Nuevo mensaje a soporte" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel("Asunto")).toHaveValue("Consulta por mi plan");
    await expect(drawer.locator("form")).toHaveAttribute("data-ticket-source", "PLAN_CHANGE");
  });

  test("Titular de un consultorio suspendido: ticket «Consultorio suspendido» con el email de la sesión", async ({ browser }) => {
    const fx = readPvFixture();
    const owner = fx.suspended.owner;
    const ctx = await freshContext(browser);
    const page = await ctx.newPage();
    try {
      await page.goto("/login");
      await submitLogin(page, owner);
      await expect(page).toHaveURL(/\/suspendido/);
      await expect(page.getByRole("heading", { name: `${fx.suspended.tenantName} está suspendido` })).toBeVisible();
      // (4) Sin mailto: el «escribinos» es un link a /contacto.
      expect(await page.locator('a[href^="mailto:"]').count()).toBe(0);
      const contact = page.locator("a[data-support-contact]");
      await expect(contact).toHaveAttribute("href", "/contacto?motivo=suspendido");
      await contact.click();

      await expect(page).toHaveURL(/\/contacto\?motivo=suspendido/);
      await expect(page.getByRole("heading", { name: "Escribinos por tu consultorio" })).toBeVisible();
      await expect(page.getByText(`Te respondemos a ${owner.email.toLowerCase()}.`)).toBeVisible();
      const form = page.getByRole("form", { name: "Escribinos por tu consultorio" });
      // Identidad de la sesión: el form no pide nombre ni email.
      await expect(form.locator('input[name="email"], input[name="name"]')).toHaveCount(0);
      const msg = `Nos suspendieron por error ${uniqueSuffix()}`;
      await form.getByLabel("Mensaje").fill(msg);
      await form.getByRole("button", { name: "Enviar mensaje" }).click();
      await expect(page.getByRole("status")).toContainText(`Recibimos tu mensaje. Te respondemos a ${owner.email.toLowerCase()}.`);
    } finally {
      await ctx.close();
    }

    const db = ownerClient();
    try {
      const t = await db.supportThread.findFirstOrThrow({
        where: { tenantId: fx.suspended.tenantId, source: "TENANT_SUSPENDED" },
        select: { kind: true, createdById: true, subject: true },
      });
      expect(t).toMatchObject({ kind: "TENANT", createdById: owner.id });
    } finally {
      await db.$disconnect();
    }

    const sa = await pvLoginAs(browser, fx.superadmin, "/plataforma/mensajes");
    try {
      await sa.page.goto("/plataforma/mensajes?origen=suspendido");
      const row = ticketRow(sa.page, owner.fullName);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Consultorio suspendido");
      await expect(row).toContainText("Nuevo");
    } finally {
      await sa.ctx.close();
    }
  });

  test("usuario deshabilitado: ticket LEAD «Cuenta desactivada» con el email de la sesión", async ({ browser }) => {
    const fx = readPvFixture();
    const u = fx.disabled;
    const ctx = await freshContext(browser);
    const page = await ctx.newPage();
    try {
      await page.goto("/login");
      await submitLogin(page, u);
      await expect(page).toHaveURL(/\/cuenta-desactivada/);
      expect(await page.locator('a[href^="mailto:"]').count()).toBe(0);
      await page.goto("/contacto?motivo=cuenta");
      await expect(page.getByRole("heading", { name: "Escribinos por tu cuenta" })).toBeVisible();
      await expect(page.getByText(`Te respondemos a ${u.email.toLowerCase()}.`)).toBeVisible();
      const form = page.getByRole("form", { name: "Escribinos por tu cuenta" });
      await form.getByLabel("Mensaje").fill("No puedo entrar a mi cuenta.");
      await form.getByRole("button", { name: "Enviar mensaje" }).click();
      await expect(page.getByRole("status")).toContainText("Recibimos tu mensaje.");
    } finally {
      await ctx.close();
    }

    const db = ownerClient();
    try {
      const t = await db.supportThread.findFirstOrThrow({
        where: { kind: "LEAD", leadEmail: u.email.toLowerCase(), source: "ACCOUNT_DISABLED" },
        select: { createdById: true },
      });
      expect(t.createdById).toBe(u.id);
    } finally {
      await db.$disconnect();
    }

    const sa = await pvLoginAs(browser, fx.superadmin, "/plataforma/mensajes");
    try {
      await sa.page.goto("/plataforma/mensajes?origen=cuenta");
      const row = ticketRow(sa.page, u.fullName);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Cuenta desactivada");
    } finally {
      await sa.ctx.close();
    }
  });

  test("sin mailto: en el pie de la landing; los contactos van a /contacto", async ({ browser }) => {
    const ctx = await freshContext(browser);
    const page = await ctx.newPage();
    try {
      await page.goto("/");
      const footer = page.locator("footer").last();
      await expect(footer).toBeVisible();
      expect(await footer.locator('a[href^="mailto:"]').count()).toBe(0);
      expect(await page.locator('a[href^="mailto:"]').count()).toBe(0);
      expect(await footer.locator('a[href^="/contacto"]').count()).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });
});
