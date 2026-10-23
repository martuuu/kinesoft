/**
 * [WA-U6] /plataforma/whatsapp — render de la vista con DTOs armados a mano (brief §26.5 «Plataforma → WhatsApp, sin
 * teléfonos»). La garantía de que el DTO real no trae teléfonos está en la integración `wa-u6-platform-read.test.ts`;
 * acá se prueba lo que la vista pinta: el aviso de apagado, la presencia de variables (nunca un valor), la fila por
 * consultorio con sus agregados y la entrada del nav. Correr con TZ=UTC: las fechas tienen que salir en hora AR.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/plataforma/whatsapp" }));
vi.mock("@/components/plataforma/inbox/use-inbox-unread", () => ({ useInboxUnread: () => 0 }));
// Para «con off no consulta tablas»: un prismaService que anota y tira en CUALQUIER acceso, y el guard resuelto (la
// barrera real se prueba en la integración, con un no superadmin de verdad).
const dbAccess = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/db", () => ({
  prismaService: new Proxy(
    {},
    {
      get(_t, prop) {
        dbAccess.push(String(prop));
        throw new Error(`[WA-U6] prismaService.${String(prop)} con WhatsApp apagado`);
      },
    }
  ),
}));
vi.mock("@/lib/platform-actor", () => ({ requirePlatformAdmin: vi.fn(async () => ({ userId: "super" })) }));

import { WhatsAppOverview } from "@/components/plataforma/whatsapp/whatsapp-overview";
import { PlatformNav, PLATFORM_NAV_ITEMS } from "@/components/plataforma/platform-nav";
import { getPlatformWhatsAppOverview } from "@/lib/platform-whatsapp-read";
import type { PlatformWhatsAppAccountRow, PlatformWhatsAppOverview, WaEnvPresence } from "@/lib/platform-whatsapp-read";

const ENV_ALL: WaEnvPresence[] = [
  { name: "WHATSAPP_APP_ID", present: true },
  { name: "WHATSAPP_APP_SECRET", present: true },
  { name: "WHATSAPP_CONFIG_ID", present: false },
  { name: "WHATSAPP_WEBHOOK_VERIFY_TOKEN", present: true },
];

function row(over: Partial<PlatformWhatsAppAccountRow> = {}): PlatformWhatsAppAccountRow {
  return {
    tenantId: "t-1",
    tenantName: "Consultorio Norte",
    mode: "fake",
    status: "ACTIVE",
    qualityRating: "GREEN",
    messagingLimit: "TIER_250",
    wabaIdTail: "4321",
    paymentIssue: false,
    lastErrorCode: null,
    // 15:30 UTC = 12:30 AR.
    lastWebhookAt: "2026-10-20T15:30:00.000Z",
    templatesApproved: 4,
    templatesTotal: 5,
    messages7d: { sent: 12, delivered: 10, read: 7, failed: 2, skipped: 3 },
    topErrors: [
      { code: "rate_limit:131056", count: 2 },
      { code: "undeliverable:131026", count: 1 },
    ],
    ...over,
  };
}

describe("[WA-U6] Plataforma → WhatsApp", () => {
  it("[WA-U6] con modo off dice que está apagado y no pinta la tabla", () => {
    const html = renderToStaticMarkup(<WhatsAppOverview overview={{ mode: "off", env: ENV_ALL }} />);
    expect(html).toContain("WhatsApp está apagado (WHATSAPP_MODE=off)");
    expect(html).not.toContain("data-wa-account");
  });

  it("[WA-U6] variables: solo presencia (Cargada / Falta), por nombre", () => {
    const o: PlatformWhatsAppOverview = { mode: "live", env: ENV_ALL, windowDays: 7, stats: { available: true, lastWebhookAt: null, accounts: [] } };
    const html = renderToStaticMarkup(<WhatsAppOverview overview={o} />);
    expect(html).toContain('data-wa-env="WHATSAPP_CONFIG_ID" data-present="false"');
    expect(html).toContain('data-wa-env="WHATSAPP_APP_SECRET" data-present="true"');
    expect(html).toContain("Falta");
    expect(html).toContain("Ningún consultorio conectó WhatsApp");
    expect(html).toContain("Último webhook");
    expect(html).toContain("Nunca");
  });

  it("[WA-U6] fila por consultorio: estado, calidad, límite, plantillas, mensajes de 7 días y errores; fechas en AR", () => {
    const o: PlatformWhatsAppOverview = {
      mode: "fake",
      env: ENV_ALL,
      windowDays: 7,
      stats: {
        available: true,
        lastWebhookAt: "2026-10-20T15:30:00.000Z",
        accounts: [row(), row({ tenantId: "t-2", tenantName: "Sur", status: "REAUTH_REQUIRED", paymentIssue: true, topErrors: [] })],
      },
    };
    const html = renderToStaticMarkup(<WhatsAppOverview overview={o} />);
    const start = html.indexOf('data-wa-account="t-1"');
    expect(start).toBeGreaterThan(-1);
    const a = html.slice(start, html.indexOf('data-wa-account="t-2"'));
    expect(a).toContain("Consultorio Norte");
    expect(a).toContain("Activa");
    expect(a).toContain("Alta");
    expect(a).toContain("250");
    expect(a).toContain("4 de 5");
    expect(a).toContain("…4321");
    for (const [k, v] of [["sent", 12], ["delivered", 10], ["read", 7], ["failed", 2], ["skipped", 3]] as const) {
      expect(a).toContain(`data-wa-count="${k}">${v}<`);
    }
    expect(a).toContain("rate_limit:131056");
    expect(a).toContain("×2");
    expect(a).toContain("12:30");
    const b = html.slice(html.indexOf('data-wa-account="t-2"'));
    expect(b).toContain("Hay que reconectar");
    expect(b).toContain("Problema con el medio de pago");
    expect(html).toContain("Modo");
    expect(html).toContain("fake");
  });

  it("[WA-U6] estadísticas no disponibles: lo dice, sin tabla", () => {
    const o: PlatformWhatsAppOverview = { mode: "sandbox", env: ENV_ALL, windowDays: 7, stats: { available: false } };
    const html = renderToStaticMarkup(<WhatsAppOverview overview={o} />);
    expect(html).toContain("No se pudieron leer");
    expect(html).not.toContain("data-wa-account");
  });

  it("[WA-U6] el nav de Plataforma tiene «WhatsApp» y se marca activo en /plataforma/whatsapp", () => {
    const item = PLATFORM_NAV_ITEMS.find((i) => i.href === "/plataforma/whatsapp");
    expect(item?.label).toBe("WhatsApp");
    const html = renderToStaticMarkup(<PlatformNav />);
    expect(html).toMatch(/<a[^>]*href="\/plataforma\/whatsapp"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/plataforma\/whatsapp"/);
  });

  it("[WA-U6] getPlatformWhatsAppOverview con WHATSAPP_MODE=off no toca la base (y con fake sí: el detector no es ciego)", async () => {
    const prev = process.env.WHATSAPP_MODE;
    try {
      process.env.WHATSAPP_MODE = "off";
      dbAccess.length = 0;
      const o = await getPlatformWhatsAppOverview();
      expect(o).toEqual({
        mode: "off",
        env: expect.arrayContaining([expect.objectContaining({ name: "WHATSAPP_APP_ID" })]),
      });
      expect(dbAccess).toEqual([]);

      process.env.WHATSAPP_MODE = "fake";
      const f = await getPlatformWhatsAppOverview();
      expect(f.mode).toBe("fake");
      expect(f.mode !== "off" && f.stats.available).toBe(false);
      expect(dbAccess.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.WHATSAPP_MODE;
      else process.env.WHATSAPP_MODE = prev;
    }
  });
});
